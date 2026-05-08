'use strict';

const path = require('path');
const fs   = require('fs');
const { normalizePolicy } = require('./policy');
const { expandConfigPlaceholders, loadDotEnvForConfig } = require('./config-expand');

const cfgPath = process.env.ORCHESTRATOR_CONFIG
  || path.join(__dirname, 'agents.config.json');

let cfg;
try {
  loadDotEnvForConfig(cfgPath);
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  expandConfigPlaceholders(cfg);
} catch (e) {
  process.stderr.write(`[orchestrator] Cannot read config: ${cfgPath}\n${e.message}\n`);
  process.exit(1);
}

if (!cfg.agentGroups && (!Array.isArray(cfg.subAgents) || !cfg.subAgents.length)) {
  process.stderr.write('[orchestrator] config.subAgents must be a non-empty array, or config.agentGroups must be provided\n');
  process.exit(1);
}

// ─── Optional ajv schema validation ─────────────────────────────────────────
// ajv is an optional dev dependency. If not installed we fall back to manual
// validation below. Run `npm install` to enable strict schema checking.

function tryAjvValidation(data) {
  try {
    const Ajv = require('ajv');
    const schemaPath = path.join(__dirname, 'agents.config.schema.json');
    if (!fs.existsSync(schemaPath)) return;
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      const msgs = (validate.errors || []).map(e => `  ${e.instancePath || '(root)'} ${e.message}`).join('\n');
      process.stderr.write(`[orchestrator] config schema errors:\n${msgs}\n`);
      process.exit(1);
    }
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      process.stderr.write(`[orchestrator] ajv validation error: ${err.message}\n`);
    }
    // MODULE_NOT_FOUND = ajv not installed; fall through to manual validation
  }
}

// ─── Env expansion for MCP server config ─────────────────────────────────────

function expandEnv(str) {
  return str
    .replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, v) => process.env[v] || '')
    .replace(/\$\{([^}]+)\}/g, (_, v) => process.env[v] || '');
}

function resolveNameValueEntries(entries = [], { filterEmptyBearer = false } = {}) {
  return entries
    .map(entry => ({ ...entry, value: expandEnv(entry.value) }))
    .filter(entry => {
      if (!filterEmptyBearer) return true;
      return entry.value && entry.value.trim() !== '' && !/^Bearer\s*$/i.test(entry.value);
    });
}

function resolveMcpServers(servers = []) {
  return servers.map(srv => {
    if (srv.type === 'stdio') {
      return {
        type: 'stdio',
        name: srv.name,
        command: srv.command,
        args: srv.args || [],
        env: resolveNameValueEntries(srv.env || []),
      };
    }

    return {
      type: srv.type,
      name: srv.name,
      url: srv.url,
      headers: resolveNameValueEntries(srv.headers || [], { filterEmptyBearer: true }),
    };
  });
}

const pick = (cfgVal, envVal, fallback) => {
  if (cfgVal !== undefined && cfgVal !== null) return cfgVal;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
};

// ─── Numeric config values ────────────────────────────────────────────────────

const MAX_TURNS          = pick(cfg.maxTurns,          process.env.MAX_TURNS,          5);
const AGENT_TIMEOUT_MS   = pick(cfg.agentTimeoutMs,    process.env.AGENT_TIMEOUT_MS,   120_000);
const MAX_RETRIES        = pick(cfg.maxRetries,        process.env.MAX_RETRIES,        3);
const RETRY_DELAY_MS     = pick(cfg.retryDelayMs,      process.env.RETRY_DELAY_MS,     5_000);
const HEARTBEAT_MS       = pick(cfg.heartbeatMs,       process.env.HEARTBEAT_MS,       30_000);
const MAX_RETRY_AFTER_MS = pick(cfg.maxRetryAfterMs,   process.env.MAX_RETRY_AFTER_MS, 5 * 60_000);
const MAX_LINE_BYTES     = pick(cfg.maxLineBytes,      process.env.MAX_LINE_BYTES,     4 * 1024 * 1024);
const MAX_OUTPUT_BYTES   = pick(cfg.maxOutputBytes,    process.env.MAX_OUTPUT_BYTES,   10 * 1024 * 1024);
const REVIEWER_AGENT_CHARS = pick(cfg.reviewerAgentChars, process.env.REVIEWER_AGENT_CHARS, 40_000);
const CONCURRENCY        = pick(cfg.concurrency,       process.env.CONCURRENCY,        4);
const PROBE_TIMEOUT_MS   = pick(cfg.probeTimeoutMs,    process.env.PROBE_TIMEOUT_MS,   20_000);

// ─── Manual config validation ─────────────────────────────────────────────────

function fail(msg) {
  process.stderr.write(`[orchestrator] config error: ${msg}\n`);
  process.exit(1);
}

function assertInt(name, val, min) {
  if (!Number.isFinite(val) || !Number.isInteger(val) || val < min) {
    fail(`${name} must be an integer >= ${min}, got ${val}`);
  }
}

function assertOptionalInt(name, val, min) {
  if (val !== undefined) assertInt(name, val, min);
}

function assertString(name, val) {
  if (typeof val !== 'string' || val.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
}

function assertWorkspaceRelativePath(name, val) {
  assertString(name, val);
  if (path.isAbsolute(val) || path.win32.isAbsolute(val)) {
    fail(`${name} must be workspace-relative, got absolute path ${JSON.stringify(val)}`);
  }
  const parts = val.split(/[\\/]/);
  if (parts.some(part => part === '')) {
    fail(`${name} must not contain empty path segments`);
  }
  if (parts.includes('..')) {
    fail(`${name} must not contain ".." path segments`);
  }
}

function assertStringArray(name, val) {
  if (!Array.isArray(val) || val.some(v => typeof v !== 'string')) {
    fail(`${name} must be an array of strings`);
  }
}

function assertKnownKeys(pathLabel, obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      fail(`${pathLabel} contains unknown key ${JSON.stringify(key)}`);
    }
  }
}

function assertStringMap(name, val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    fail(`${name} must be an object with string values`);
  }
  for (const [k, v] of Object.entries(val)) {
    if (typeof v !== 'string') {
      fail(`${name}.${k} must be a string`);
    }
  }
}

function assertNameValueArray(name, val) {
  if (!Array.isArray(val)) fail(`${name} must be an array`);
  for (const [i, entry] of val.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${name}[${i}] must be an object`);
    }
    assertKnownKeys(`${name}[${i}]`, entry, NAME_VALUE_KEYS);
    assertString(`${name}[${i}].name`, entry.name);
    if (typeof entry.value !== 'string') {
      fail(`${name}[${i}].value must be a string`);
    }
  }
}

const ROOT_KEYS = [
  '$schema',
  'maxTurns',
  'agentTimeoutMs',
  'maxRetries',
  'retryDelayMs',
  'heartbeatMs',
  'maxRetryAfterMs',
  'maxLineBytes',
  'maxOutputBytes',
  'reviewerAgentChars',
  'concurrency',
  'probeTimeoutMs',
  'envIsolation',
  'defaultGroup',
  'workflow',
  'artifactDir',
  'rateLimits',
  'mcpServers',
  'subAgents',
  'reviewer',
  'agentGroups',
];
const AGENT_KEYS = [
  'name',
  'command',
  'sandboxCommand',
  'sandboxArgs',
  'rateLimitKey',
  'args',
  'env',
  'passEnv',
  'envIsolation',
  'credHome',
  'allowRealHome',
  'agentTimeoutMs',
  'maxRetries',
  'retryDelayMs',
  'heartbeatMs',
];
const GROUP_KEYS = [
  'description',
  'persist',
  'strategy',
  'permissions',
  'reviewerPermissions',
  'writerPermissions',
  'writer',
  'attachApprovedPlanFrom',
  'artifactDir',
  'maxTurns',
  'concurrency',
  'subAgents',
  'reviewer',
];
const MCP_SERVER_KEYS = ['type', 'name', 'url', 'command', 'args', 'env', 'headers'];
const NAME_VALUE_KEYS = ['name', 'value'];
const RATE_LIMIT_KEYS = ['requestsPerMinute', 'burstSize'];

assertKnownKeys('(root)', cfg, ROOT_KEYS);

assertInt('maxTurns',         MAX_TURNS,          1);
assertInt('agentTimeoutMs',   AGENT_TIMEOUT_MS,   1000);
assertInt('maxRetries',       MAX_RETRIES,        0);
assertInt('retryDelayMs',     RETRY_DELAY_MS,     0);
assertInt('heartbeatMs',      HEARTBEAT_MS,       0);
assertInt('maxRetryAfterMs',  MAX_RETRY_AFTER_MS, 0);
assertInt('maxLineBytes',     MAX_LINE_BYTES,     1024);
assertInt('maxOutputBytes',   MAX_OUTPUT_BYTES,   1024);
assertInt('reviewerAgentChars', REVIEWER_AGENT_CHARS, 1000);
assertInt('concurrency',      CONCURRENCY,        1);
assertInt('probeTimeoutMs',   PROBE_TIMEOUT_MS,   0);

if (cfg.envIsolation !== undefined && typeof cfg.envIsolation !== 'boolean') {
  fail('envIsolation must be a boolean');
}
if (cfg.mcpServers !== undefined && !Array.isArray(cfg.mcpServers)) {
  fail('mcpServers must be an array');
}
if (cfg.workflow !== undefined) assertStringArray('workflow', cfg.workflow);
if (cfg.defaultGroup !== undefined) assertString('defaultGroup', cfg.defaultGroup);
if (cfg.artifactDir !== undefined) assertWorkspaceRelativePath('artifactDir', cfg.artifactDir);

function validateAgentSpec(p, a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    fail(`${p} must be an object`);
  }
  assertKnownKeys(p, a, AGENT_KEYS);
  assertString(`${p}.name`, a.name);
  assertString(`${p}.command`, a.command);
  if (a.rateLimitKey !== undefined) assertString(`${p}.rateLimitKey`, a.rateLimitKey);
  if (a.args !== undefined) assertStringArray(`${p}.args`, a.args);
  if (a.sandboxCommand !== undefined) assertString(`${p}.sandboxCommand`, a.sandboxCommand);
  if (a.sandboxArgs !== undefined) assertStringArray(`${p}.sandboxArgs`, a.sandboxArgs);
  if (a.env !== undefined) assertStringMap(`${p}.env`, a.env);
  if (a.passEnv !== undefined) assertStringArray(`${p}.passEnv`, a.passEnv);
  if (a.envIsolation !== undefined && typeof a.envIsolation !== 'boolean') {
    fail(`${p}.envIsolation must be a boolean`);
  }
  if (a.credHome !== undefined && (typeof a.credHome !== 'string' || !a.credHome)) {
    fail(`${p}.credHome must be a non-empty string`);
  }
  if (a.allowRealHome !== undefined && typeof a.allowRealHome !== 'boolean') {
    fail(`${p}.allowRealHome must be a boolean`);
  }
  assertOptionalInt(`${p}.agentTimeoutMs`, a.agentTimeoutMs, 1000);
  assertOptionalInt(`${p}.maxRetries`, a.maxRetries, 0);
  assertOptionalInt(`${p}.retryDelayMs`, a.retryDelayMs, 0);
  assertOptionalInt(`${p}.heartbeatMs`, a.heartbeatMs, 0);
}

function validatePermissions(p, permissions) {
  try {
    return normalizePolicy(permissions);
  } catch (err) {
    fail(`${p}: ${err.message}`);
  }
}

function policyAllowsMutation(policy) {
  return Boolean(policy.writeFiles || policy.terminal || policy.allowUnknownClientRequests);
}

function assertReadOnlyParallelReports(groupName, group) {
  const strategy = group.strategy || 'parallel_reports';
  if (strategy !== 'parallel_reports') return;

  const subPolicy = validatePermissions(`agentGroups.${groupName}.permissions`, group.permissions);
  const reviewerPolicy = validatePermissions(`agentGroups.${groupName}.reviewerPermissions`, group.reviewerPermissions);

  if (policyAllowsMutation(subPolicy) || policyAllowsMutation(reviewerPolicy)) {
    fail(`agentGroups.${groupName}: parallel_reports groups must be read-only; use single_writer for code-changing phases`);
  }

  if (group.writer !== undefined || group.writerPermissions !== undefined) {
    fail(`agentGroups.${groupName}: writer and writerPermissions are only valid for single_writer groups`);
  }
}

function assertReadOnlyReviewer(groupName, group) {
  const reviewerPolicy = validatePermissions(`agentGroups.${groupName}.reviewerPermissions`, group.reviewerPermissions);
  if (policyAllowsMutation(reviewerPolicy)) {
    fail(`agentGroups.${groupName}.reviewerPermissions must be read-only; reviewers cannot receive write or terminal permissions`);
  }
}

if (cfg.subAgents !== undefined) {
  if (!Array.isArray(cfg.subAgents) || !cfg.subAgents.length) {
    fail('subAgents must be a non-empty array');
  }
  for (const [i, a] of cfg.subAgents.entries()) {
    validateAgentSpec(`subAgents[${i}]`, a);
  }
}
if (cfg.reviewer !== undefined) validateAgentSpec('reviewer', cfg.reviewer);

for (const [i, s] of (cfg.mcpServers || []).entries()) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    fail(`mcpServers[${i}] must be an object`);
  }
  assertKnownKeys(`mcpServers[${i}]`, s, MCP_SERVER_KEYS);
  if (!['http', 'stdio'].includes(s.type)) {
    fail(`mcpServers[${i}].type must be "http" or "stdio", got ${JSON.stringify(s.type)}`);
  }
  assertString(`mcpServers[${i}].name`, s.name);
  if (s.type === 'http') assertString(`mcpServers[${i}].url`, s.url);
  if (s.type === 'stdio') assertString(`mcpServers[${i}].command`, s.command);
  if (s.args !== undefined) assertStringArray(`mcpServers[${i}].args`, s.args);
  if (s.headers !== undefined) assertNameValueArray(`mcpServers[${i}].headers`, s.headers);
  if (s.env !== undefined) assertNameValueArray(`mcpServers[${i}].env`, s.env);
}

if (cfg.rateLimits !== undefined) {
  if (!cfg.rateLimits || typeof cfg.rateLimits !== 'object' || Array.isArray(cfg.rateLimits)) {
    fail('rateLimits must be an object');
  }
  for (const [command, limit] of Object.entries(cfg.rateLimits)) {
    if (!limit || typeof limit !== 'object' || Array.isArray(limit)) {
      fail(`rateLimits.${command} must be an object`);
    }
    assertKnownKeys(`rateLimits.${command}`, limit, RATE_LIMIT_KEYS);
    if (!Number.isFinite(limit.requestsPerMinute) || limit.requestsPerMinute <= 0) {
      fail(`rateLimits.${command}.requestsPerMinute must be a number > 0`);
    }
    if (limit.burstSize !== undefined) {
      assertInt(`rateLimits.${command}.burstSize`, limit.burstSize, 1);
    }
  }
}

if (cfg.agentGroups !== undefined) {
  if (!cfg.agentGroups || typeof cfg.agentGroups !== 'object' || Array.isArray(cfg.agentGroups)) {
    fail('agentGroups must be an object keyed by group name');
  }
  if (Object.keys(cfg.agentGroups).length === 0) {
    fail('agentGroups must contain at least one group');
  }
  for (const [name, group] of Object.entries(cfg.agentGroups)) {
    assertString('agentGroups group name', name);
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      fail(`agentGroups.${name} must be an object`);
    }
    assertKnownKeys(`agentGroups.${name}`, group, GROUP_KEYS);
    if (group.description !== undefined && typeof group.description !== 'string') {
      fail(`agentGroups.${name}.description must be a string`);
    }
    if (group.persist !== undefined && typeof group.persist !== 'boolean') {
      fail(`agentGroups.${name}.persist must be a boolean`);
    }
    if (group.strategy !== undefined && !['parallel_reports', 'single_writer'].includes(group.strategy)) {
      fail(`agentGroups.${name}.strategy must be "parallel_reports" or "single_writer"`);
    }
    if (group.permissions !== undefined) validatePermissions(`agentGroups.${name}.permissions`, group.permissions);
    if (group.reviewerPermissions !== undefined) validatePermissions(`agentGroups.${name}.reviewerPermissions`, group.reviewerPermissions);
    if (group.writerPermissions !== undefined) validatePermissions(`agentGroups.${name}.writerPermissions`, group.writerPermissions);
    if (group.artifactDir !== undefined) assertWorkspaceRelativePath(`agentGroups.${name}.artifactDir`, group.artifactDir);
    if (group.attachApprovedPlanFrom !== undefined) assertString(`agentGroups.${name}.attachApprovedPlanFrom`, group.attachApprovedPlanFrom);
    if (group.writer !== undefined) assertString(`agentGroups.${name}.writer`, group.writer);
    if (group.concurrency !== undefined) assertInt(`agentGroups.${name}.concurrency`, group.concurrency, 1);
    if (!Array.isArray(group.subAgents) || !group.subAgents.length) {
      fail(`agentGroups.${name}.subAgents must be a non-empty array`);
    }
    for (const [i, a] of group.subAgents.entries()) {
      validateAgentSpec(`agentGroups.${name}.subAgents[${i}]`, a);
    }
    const agentNames = group.subAgents.map(a => a.name);
    const duplicateName = agentNames.find((agentName, idx) => agentNames.indexOf(agentName) !== idx);
    if (duplicateName) {
      fail(`agentGroups.${name}.subAgents contains duplicate agent name ${JSON.stringify(duplicateName)}`);
    }
    const strategy = group.strategy || 'parallel_reports';
    assertReadOnlyParallelReports(name, group);
    assertReadOnlyReviewer(name, group);
    if (strategy === 'single_writer') {
      if (!group.writer) {
        fail(`agentGroups.${name}.writer is required when strategy is "single_writer"`);
      }
      const matches = agentNames.filter(agentName => agentName === group.writer);
      if (matches.length !== 1) {
        fail(`agentGroups.${name}.writer must match exactly one subAgents[].name, got ${matches.length} matches for ${JSON.stringify(group.writer)}`);
      }
    }
    if (group.reviewer !== undefined) validateAgentSpec(`agentGroups.${name}.reviewer`, group.reviewer);
    assertOptionalInt(`agentGroups.${name}.maxTurns`, group.maxTurns, 1);
  }
}

// ─── Environment isolation ────────────────────────────────────────────────────

const ENV_ISOLATION = cfg.envIsolation !== false;
const decorateEnv = a => ({ envIsolation: ENV_ISOLATION, ...a });

function buildAgentGroups() {
  const rawGroups = cfg.agentGroups || {
    default: {
      subAgents: cfg.subAgents,
      reviewer: cfg.reviewer,
      description: 'Legacy default group',
    },
  };

  const groups = {};
  for (const [name, group] of Object.entries(rawGroups)) {
    const reviewer = group.reviewer || cfg.reviewer;
    if (!reviewer) {
      fail(`agentGroups.${name}.reviewer is required when no top-level reviewer is configured`);
    }
    groups[name] = {
      name,
      description: group.description || '',
      strategy: group.strategy || 'parallel_reports',
      persist: group.persist ?? ((group.strategy || 'parallel_reports') !== 'single_writer'),
      permissions: group.permissions,
      reviewerPermissions: group.reviewerPermissions,
      writerPermissions: group.writerPermissions,
      writer: group.writer,
      attachApprovedPlanFrom: group.attachApprovedPlanFrom ?? (name === 'code' && rawGroups.plan ? 'plan' : undefined),
      artifactDir: group.artifactDir || cfg.artifactDir || '.plan/orchestrator',
      maxTurns: group.maxTurns ?? MAX_TURNS,
      concurrency: group.concurrency ?? CONCURRENCY,
      subAgents: group.subAgents.map(decorateEnv),
      reviewer: decorateEnv(reviewer),
    };
  }
  return groups;
}

const AGENT_GROUPS = buildAgentGroups();
const GROUP_NAMES  = Object.keys(AGENT_GROUPS);
const DEFAULT_GROUP = cfg.defaultGroup || (cfg.agentGroups ? GROUP_NAMES[0] : 'default');
if (!AGENT_GROUPS[DEFAULT_GROUP]) {
  fail(`defaultGroup must reference an existing agentGroups entry, got ${JSON.stringify(DEFAULT_GROUP)}`);
}

const WORKFLOW = cfg.workflow || [DEFAULT_GROUP];
if (!WORKFLOW.length) {
  fail('workflow must contain at least one group');
}
for (const [i, name] of WORKFLOW.entries()) {
  if (!AGENT_GROUPS[name]) {
    fail(`workflow[${i}] references unknown agent group ${JSON.stringify(name)}`);
  }
}
for (const [name, group] of Object.entries(AGENT_GROUPS)) {
  if (group.attachApprovedPlanFrom && !AGENT_GROUPS[group.attachApprovedPlanFrom]) {
    fail(`agentGroups.${name}.attachApprovedPlanFrom references unknown agent group ${JSON.stringify(group.attachApprovedPlanFrom)}`);
  }
}

tryAjvValidation(cfg);

module.exports = {
  MAX_TURNS,
  AGENT_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  HEARTBEAT_MS,
  MAX_RETRY_AFTER_MS,
  MAX_LINE_BYTES,
  MAX_OUTPUT_BYTES,
  REVIEWER_AGENT_CHARS,
  CONCURRENCY,
  PROBE_TIMEOUT_MS,
  RATE_LIMITS:   cfg.rateLimits || {},
  AGENT_GROUPS,
  DEFAULT_GROUP,
  WORKFLOW,
  MCP_SERVERS:   resolveMcpServers(cfg.mcpServers),
};
