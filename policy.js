'use strict';

// Read-only default: no MCP. MCP servers expose tool surfaces whose mutability
// is opaque to the orchestrator, so they are off by default in planning/review
// phases. Set permissions.mcp = true explicitly when every forwarded MCP server
// is known read-only.
const READ_ONLY_POLICY = Object.freeze({
  readFiles: true,
  writeFiles: false,
  terminal: false,
  mcp: false,
  allowUnknownClientRequests: false,
});

const FULL_POLICY = Object.freeze({
  readFiles: true,
  writeFiles: true,
  terminal: true,
  mcp: true,
  allowUnknownClientRequests: true,
});

const POLICY_KEYS = ['readFiles', 'writeFiles', 'terminal', 'mcp', 'allowUnknownClientRequests'];
const POLICY_KEY_SET = new Set(POLICY_KEYS);

function optionalPolicyBool(input, key, fallback) {
  if (input[key] === undefined) return Boolean(fallback[key]);
  if (typeof input[key] !== 'boolean') {
    throw new Error(`permissions.${key} must be a boolean`);
  }
  return input[key];
}

function normalizePolicy(input, fallback = READ_ONLY_POLICY) {
  if (input === undefined || input === null) return { ...fallback };

  if (typeof input === 'string') {
    if (input === 'read_only') return { ...READ_ONLY_POLICY };
    if (input === 'writer_only' || input === 'full' || input === 'allow_all') return { ...FULL_POLICY };
    throw new Error(`unknown permissions policy ${JSON.stringify(input)}`);
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('permissions must be a string or object');
  }

  for (const key of Object.keys(input)) {
    if (!POLICY_KEY_SET.has(key)) {
      throw new Error(`permissions contains unknown key ${JSON.stringify(key)}`);
    }
  }

  return {
    readFiles: optionalPolicyBool(input, 'readFiles', fallback),
    writeFiles: optionalPolicyBool(input, 'writeFiles', fallback),
    terminal: optionalPolicyBool(input, 'terminal', fallback),
    mcp: optionalPolicyBool(input, 'mcp', fallback),
    allowUnknownClientRequests: optionalPolicyBool(input, 'allowUnknownClientRequests', fallback),
  };
}

function effectivePolicyForAgent(group, agentCfg, role = 'subagent') {
  if (role === 'reviewer') {
    return normalizePolicy(group.reviewerPermissions, READ_ONLY_POLICY);
  }

  if (group.strategy === 'single_writer') {
    const writerName = group.writer || group.writerAgent;
    const isWriter = role === 'writer' || (writerName && agentCfg?.name === writerName);
    return normalizePolicy(
      isWriter ? (group.writerPermissions || group.permissions) : 'read_only',
      isWriter ? FULL_POLICY : READ_ONLY_POLICY,
    );
  }

  return normalizePolicy(
    role === 'reviewer' ? (group.reviewerPermissions || group.permissions) : group.permissions,
    READ_ONLY_POLICY,
  );
}

function groupAllowsMutation(group) {
  if (!group) return false;
  if (group.strategy === 'single_writer') return true;

  const subagentPolicy = normalizePolicy(group.permissions, READ_ONLY_POLICY);
  const reviewerPolicy = normalizePolicy(group.reviewerPermissions, READ_ONLY_POLICY);
  return Boolean(
    subagentPolicy.writeFiles || subagentPolicy.terminal || subagentPolicy.allowUnknownClientRequests ||
    reviewerPolicy.writeFiles || reviewerPolicy.terminal || reviewerPolicy.allowUnknownClientRequests
  );
}

function maskClientCapabilities(caps = {}, policy = READ_ONLY_POLICY) {
  const out = { ...caps };

  if (caps.fs || policy.readFiles || policy.writeFiles) {
    out.fs = {
      ...caps.fs,
      readTextFile: Boolean(policy.readFiles && caps.fs?.readTextFile),
      writeTextFile: Boolean(policy.writeFiles && caps.fs?.writeTextFile),
    };
  }

  if ('terminal' in caps || !policy.terminal) {
    out.terminal = Boolean(policy.terminal && caps.terminal);
  }

  return out;
}

function classifyClientMethod(method) {
  if (method === 'fs/read_text_file' || method === 'fs/readTextFile') return 'read';
  if (method === 'fs/write_text_file' || method === 'fs/writeTextFile') return 'write';
  if (typeof method === 'string' && method.startsWith('fs/')) return 'fs_unknown';
  if (typeof method === 'string' && method.startsWith('terminal/')) return 'terminal';
  if (method === 'session/request_permission') return 'permission';
  return 'other';
}

function classifyPermissionRequest(params = {}) {
  const kind = String(params?.toolCall?.kind || '').toLowerCase();
  const title = String(params?.toolCall?.title || '').toLowerCase();
  const haystack = `${kind} ${title}`;
  if (haystack.includes('terminal') || haystack.includes('execute') || haystack.includes('shell')) {
    return 'terminal';
  }
  if (haystack.includes('fs.write') || haystack.includes('write') || haystack.includes('edit')) {
    return 'write';
  }
  if (haystack.includes('delete') || haystack.includes('remove') || haystack.includes('move') || haystack.includes('rename')) {
    return 'write';
  }
  if (haystack.includes('fs.read') || haystack.includes('read')) {
    return 'read';
  }
  return 'other';
}

function denied(message) {
  const err = new Error(message);
  err.code = -32000;
  return err;
}

function assertAllowedClientRequest(msg, policy, agentName = 'child agent') {
  const kind = classifyClientMethod(msg?.method);
  if (kind === 'read' && !policy.readFiles) {
    throw denied(`${agentName} is not allowed to read files in this phase; ${msg.method} denied`);
  }
  if (kind === 'write' && !policy.writeFiles) {
    throw denied(`${agentName} is read-only in this phase; ${msg.method} denied`);
  }
  if (kind === 'fs_unknown' && !policy.writeFiles) {
    throw denied(`${agentName}: unknown filesystem client method ${msg.method} denied by default`);
  }
  if (kind === 'terminal' && !policy.terminal) {
    throw denied(`${agentName} is read-only in this phase; ${msg.method} denied`);
  }
  if (kind === 'permission') {
    if (!policy.writeFiles && !policy.terminal) {
      throw denied(`${agentName} is read-only in this phase; session/request_permission denied`);
    }
    const requestedKind = classifyPermissionRequest(msg?.params);
    if (requestedKind === 'write' && !policy.writeFiles) {
      throw denied(`${agentName} is not allowed to request file-write permission in this phase`);
    }
    if (requestedKind === 'terminal' && !policy.terminal) {
      throw denied(`${agentName} is not allowed to request terminal permission in this phase`);
    }
  }
  if (kind === 'other') {
    const escapeHatch = policy.allowUnknownClientRequests || policy.writeFiles || policy.terminal;
    if (!escapeHatch) {
      throw denied(`${agentName}: unknown client request method ${msg.method} denied by default in read-only phase`);
    }
  }
}

function promptCapabilities(agentCapabilities = {}) {
  return agentCapabilities.promptCapabilities || {};
}

function filterPromptContentForCapabilities(content, agentCapabilities = {}) {
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
  const promptCaps = promptCapabilities(agentCapabilities);
  const dropped = [];
  const kept = [];

  for (const block of blocks) {
    if (!block || block.type === 'text' || block.type === 'resource_link') {
      kept.push(block);
    } else if (block.type === 'image') {
      if (promptCaps.image) kept.push(block);
      else dropped.push(block.type);
    } else if (block.type === 'resource') {
      if (promptCaps.embeddedContext) kept.push(block);
      else dropped.push(block.type || 'unknown');
    } else {
      dropped.push(block.type || 'unknown');
    }
  }

  return { content: kept, dropped };
}

module.exports = {
  READ_ONLY_POLICY,
  FULL_POLICY,
  normalizePolicy,
  effectivePolicyForAgent,
  groupAllowsMutation,
  maskClientCapabilities,
  classifyClientMethod,
  classifyPermissionRequest,
  assertAllowedClientRequest,
  filterPromptContentForCapabilities,
};
