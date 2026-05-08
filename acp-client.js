'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { redact } = require('./redact');
const { version } = require('./package.json');

// Minimum env propagated to every sub-agent when envIsolation is on.
// Crucially excludes API keys, NODE_PATH (module-loading vector), and Windows
// home equivalents (USERPROFILE/APPDATA/LOCALAPPDATA — see REAL_HOME_KEYS).
// Proxy vars are forwarded; they may include credentials in their URLs.
const SAFE_ENV_KEYS = [
  'PATH', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'PROGRAMDATA', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
];

// Home/credential roots: forwarded only when allowRealHome=true and credHome
// is unset. USERPROFILE/APPDATA/LOCALAPPDATA are Windows home equivalents and
// reveal user credential locations, so they belong here, not in SAFE_ENV_KEYS.
const REAL_HOME_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
];
const CRED_HOME_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_CONFIG_DIR',
];
const CRED_HOME_KEY_SET = new Set(CRED_HOME_KEYS);

function utf8ByteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function ensureCredHome(credHome) {
  fs.mkdirSync(credHome, { recursive: true, mode: 0o700 });
}

function resolveCredHome(credHome, workDir) {
  if (credHome.startsWith('~/')) {
    return path.resolve(os.homedir(), credHome.slice(2));
  }
  return path.isAbsolute(credHome)
    ? credHome
    : path.resolve(workDir || process.cwd(), credHome);
}

function isTildeHomePath(credHome) {
  return credHome === '~' || credHome.startsWith('~/') || credHome.startsWith('~\\');
}

// Pre-creation check: walk up from abs to find the first existing ancestor and verify
// its realpath is inside the workspace root. Detects symlink escapes before mkdir runs.
// Only applies to workspace-relative paths; absolute and tilde paths are allowed anywhere.
function assertSafeToCreate(credHome, workDir, abs) {
  if (path.isAbsolute(credHome) || isTildeHomePath(credHome)) return;
  const root = path.resolve(workDir || process.cwd());
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { return; }
  let cur = path.resolve(abs);
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`credHome resolves outside workspace through symlink: ${credHome}`);
      }
      return;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const parent = path.dirname(cur);
        if (parent === cur) return;
        cur = parent;
        continue;
      }
      throw err;
    }
  }
}

function assertCredHomeSafe(credHome, abs, workDir) {
  if (path.isAbsolute(credHome) || isTildeHomePath(credHome)) return;
  const root = path.resolve(workDir || process.cwd());
  const rootReal = fs.realpathSync(root);
  const absReal = fs.realpathSync(abs);
  if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) {
    throw new Error(`credHome resolves outside workspace through symlink: ${credHome}`);
  }
}

function applyCredHome(env, credHome, workDir) {
  const abs = resolveCredHome(credHome, workDir);
  assertSafeToCreate(credHome, workDir, abs);
  ensureCredHome(abs);
  assertCredHomeSafe(credHome, abs, workDir);

  for (const key of CRED_HOME_KEYS) delete env[key];

  env.HOME = abs;
  env.USERPROFILE = abs;
  env.APPDATA = path.join(abs, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(abs, 'AppData', 'Local');
  env.XDG_CONFIG_HOME = path.join(abs, '.config');
  env.XDG_DATA_HOME   = path.join(abs, '.local', 'share');
  env.XDG_CACHE_HOME  = path.join(abs, '.cache');
  env.XDG_STATE_HOME  = path.join(abs, '.local', 'state');
  env.CODEX_HOME = path.join(abs, 'codex');
  env.GEMINI_CLI_HOME = path.join(abs, 'gemini');
  env.CLAUDE_CONFIG_DIR = path.join(abs, 'claude');
  env.OPENCODE_CONFIG_DIR = path.join(abs, 'opencode');

  return env;
}

function buildChildEnv({ env = {}, passEnv = [], envIsolation = false, credHome = null, allowRealHome = false }, workDir) {
  let base;
  if (!envIsolation) {
    base = { ...process.env };
  } else {
    base = {};
    for (const k of SAFE_ENV_KEYS) {
      if (process.env[k] !== undefined) base[k] = process.env[k];
    }
    if (allowRealHome) {
      for (const k of REAL_HOME_KEYS) {
        if (process.env[k] !== undefined) base[k] = process.env[k];
      }
    }
    for (const k of passEnv || []) {
      if (credHome && CRED_HOME_KEY_SET.has(k)) continue;
      if (process.env[k] !== undefined) base[k] = process.env[k];
    }
  }

  const merged = { ...base, ...env };
  // Per-agent credential home is applied last so env/passEnv cannot escape it.
  return credHome ? applyCredHome(merged, credHome, workDir) : merged;
}

function spawnSpec(agentCfg) {
  const command = agentCfg.command;
  const args = agentCfg.args || [];
  if (!agentCfg.sandboxCommand) return { command, args };
  return {
    command: agentCfg.sandboxCommand,
    args: [...(agentCfg.sandboxArgs || []), command, ...args],
  };
}

const DEFAULT_MAX_LINE_BYTES   = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSION = 1;

class AcpClient {
  constructor(agentCfg, workDir, opts = {}) {
    const { name } = agentCfg;
    const { command, args } = spawnSpec(agentCfg);
    this.name       = name || command;
    this._pending   = new Map();
    this._notifs    = [];
    this._id        = 1;
    this._dead      = null;
    this._maxLine   = opts.maxLineBytes   || DEFAULT_MAX_LINE_BYTES;
    this._maxOutput = opts.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    this._stderrBytes = 0;
    this._stderrText  = '';
    this._pid       = null;
    this._onRequest = opts.onRequest || null;
    this._killGraceMs = opts.killGraceMs ?? 1000;
    this._killTimer = null;
    this._exited = false;

    const isWindows = process.platform === 'win32';
    try {
      this.proc = spawn(command, args, {
        cwd:         workDir,
        stdio:       ['pipe', 'pipe', 'pipe'],
        env:         buildChildEnv(agentCfg, workDir),
        detached:    !isWindows,
        shell:       isWindows,
        windowsHide: true,
      });
      this._pid = this.proc.pid ?? null;
    } catch (err) {
      this._dead = err;
      return;
    }

    const fail = (err) => this._fail(err);

    this.proc.on('error', err => {
      process.stderr.write(`[${this.name}] spawn error: ${err.message}\n`);
      fail(new Error(`spawn ${command}: ${err.message}`));
    });

    this.proc.on('exit', (code, signal) => {
      this._exited = true;
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
      if (!this._dead && bufStart < buf.length) {
        const line = buf.slice(bufStart);
        if (utf8ByteLength(line) <= this._maxLine) {
          this._handleLine(line);
        }
      }
      const err = new Error(
        `[${this.name}] process exited (code=${code}, signal=${signal}) before completing request`
      );
      if (code !== 0 && code !== null) {
        const snippet = this._stderrText ? `: ${redact(this._stderrText).trim()}` : '';
        process.stderr.write(`[${this.name}] exited with code ${code}${snippet}\n`);
      }
      fail(err);
    });

    this.proc.stdin.on('error', err => fail(new Error(`[${this.name}] stdin: ${err.message}`)));

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    let buf = '';
    let bufStart = 0;
    this.proc.stdout.on('data', chunk => {
      if (this._dead) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n', bufStart)) !== -1) {
        const line = buf.slice(bufStart, nl);
        bufStart = nl + 1;
        if (utf8ByteLength(line) > this._maxLine) {
          fail(new Error(`[${this.name}] stdout line exceeded ${this._maxLine} bytes`));
          return;
        }
        this._handleLine(line);
      }
      if (bufStart > 65536) {
        buf = buf.slice(bufStart);
        bufStart = 0;
      }
      if (utf8ByteLength(buf.slice(bufStart)) > this._maxLine) {
        fail(new Error(`[${this.name}] unterminated stdout line exceeded ${this._maxLine} bytes`));
      }
    });

    this.proc.stderr.on('data', chunk => {
      if (this._dead) return;
      this._stderrBytes += utf8ByteLength(chunk);
      if (this._stderrBytes > this._maxOutput) {
        fail(new Error(`[${this.name}] stderr exceeded ${this._maxOutput} bytes`));
        return;
      }
      this._stderrText += chunk;
      if (this._stderrText.length > 8192) {
        this._stderrText = this._stderrText.slice(-8192);
      }
    });
  }

  _fail(err) {
    if (this._dead) return;
    if (this._stderrText && err?.message && !err.message.includes('stderr:')) {
      err.message += `; stderr: ${redact(this._stderrText).trim()}`;
    }
    this._dead = err;
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
    this._terminateProcess();
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.method == null && msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'RPC error');
        err.code = Number.isInteger(msg.error.code) ? msg.error.code : -32000;
        if (msg.error.data !== undefined) err.data = msg.error.data;
        reject(err);
      } else {
        resolve(msg.result);
      }
    } else if (msg.id != null && msg.method) {
      this._handleInboundRequest(msg);
    } else if (msg.method) {
      for (const h of this._notifs) h(msg);
    }
  }

  _writeFrame(msg) {
    const frame = JSON.stringify(msg) + '\n';
    try {
      if (this.proc?.stdin?.writable) this.proc.stdin.write(frame);
    } catch {}
  }

  _rpcErrorFrom(err, fallbackCode = -32000) {
    if (err && typeof err === 'object') {
      const error = {
        code: Number.isInteger(err.code) ? err.code : fallbackCode,
        message: err.message || 'RPC error',
      };
      if (err.data !== undefined) error.data = err.data;
      return error;
    }
    return { code: fallbackCode, message: String(err || 'RPC error') };
  }

  _handleInboundRequest(msg) {
    if (!this._onRequest) {
      this._writeFrame({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
      return;
    }

    Promise.resolve()
      .then(() => this._onRequest(msg))
      .then(result => {
        this._writeFrame({
          jsonrpc: '2.0',
          id: msg.id,
          result: result === undefined ? {} : result,
        });
      })
      .catch(err => {
        this._writeFrame({
          jsonrpc: '2.0',
          id: msg.id,
          error: this._rpcErrorFrom(err),
        });
      });
  }

  _rpc(method, params, timeoutMs = 0) {
    if (this._dead) return Promise.reject(this._dead);

    return new Promise((resolve, reject) => {
      const id = this._id++;
      let done = false;
      let timer = null;

      const finish = (fn, val) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._pending.delete(id);
        fn(val);
      };

      this._pending.set(id, {
        resolve: r => finish(resolve, r),
        reject:  e => finish(reject, e),
      });

      if (timeoutMs > 0) {
        timer = setTimeout(
          () => finish(reject, new Error(`TIMEOUT:${timeoutMs}ms — ${method} did not respond`)),
          timeoutMs,
        );
      }

      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        if (!this.proc.stdin.writable) {
          throw new Error(`stdin not writable for ${this.name}`);
        }
        this.proc.stdin.write(frame, err => {
          if (err) finish(reject, err);
        });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  async init(clientCapabilities = {}, timeoutMs = 30000) {
    const result = await this._rpc('initialize', {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: { name: 'orchestrator', version },
    }, timeoutMs);

    const protocolVersion = result?.protocolVersion;
    if (!Number.isInteger(protocolVersion) || protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new Error(
        `[${this.name}] protocolVersion mismatch: expected ${SUPPORTED_PROTOCOL_VERSION}, got ${JSON.stringify(protocolVersion)}`
      );
    }

    return result;
  }

  // Health probe: initialize + kill. Resolves to agentCapabilities on success.
  // Throws if the agent fails to respond within timeoutMs.
  async probe(timeoutMs = 5000) {
    try {
      const result = await this.init({}, timeoutMs);
      return result?.agentCapabilities || result?.capabilities || {};
    } finally {
      this.kill();
    }
  }

  async newSession(workDir, mcpServers = [], timeoutMs = 30000) {
    const r = await this._rpc('session/new', {
      cwd: workDir,
      mcpServers,
    }, timeoutMs);
    return r.sessionId;
  }

  prompt(sessionId, content, timeoutMs = 0) {
    if (this._dead) return Promise.reject(this._dead);

    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];

    let accumulated = '';
    let direct = '';
    let accumulatedBytes = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const appendOutput = (chunk, source) => {
      const text = String(chunk || '');
      accumulatedBytes += utf8ByteLength(text);
      if (accumulatedBytes > this._maxOutput) {
        this._fail(new Error(`[${this.name}] ${source} output exceeded ${this._maxOutput} bytes`));
        return false;
      }
      return text;
    };

    const collector = msg => {
      if (msg.method !== 'session/update') return;
      const u = msg.params?.update;
      if (!u) return;

      if (u.sessionUpdate === 'agent_message_chunk' || u.type === 'agent_message_chunk') {
        const chunk = u.content?.text || '';
        const text = appendOutput(chunk, 'streamed');
        if (text === false) return;
        accumulated += text;
      }

      // Collect token usage reported via session/update (provider-specific field names)
      if (u.usage) {
        totalInputTokens  += u.usage.input_tokens  || u.usage.prompt_tokens     || 0;
        totalOutputTokens += u.usage.output_tokens || u.usage.completion_tokens || 0;
      }
    };
    this._notifs.push(collector);

    const cleanup = () => {
      this._notifs = this._notifs.filter(h => h !== collector);
    };

    return this._rpc('session/prompt', {
      sessionId,
      prompt: blocks,
    }, timeoutMs).then(result => {
      cleanup();
      for (const block of result?.content || []) {
        if (block?.type !== 'text') continue;
        const text = appendOutput(block.text, 'direct response');
        if (text === false) {
          throw this._dead || new Error(`[${this.name}] direct response output exceeded ${this._maxOutput} bytes`);
        }
        direct += text;
      }

      // Also capture usage from the final response if present
      if (result?.usage) {
        totalInputTokens  += result.usage.input_tokens  || result.usage.prompt_tokens     || 0;
        totalOutputTokens += result.usage.output_tokens || result.usage.completion_tokens || 0;
      }

      const text = accumulated || direct;
      const usage = (totalInputTokens || totalOutputTokens)
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : null;
      return { text, usage, stopReason: result?.stopReason || null };
    }, err => {
      cleanup();
      throw err;
    });
  }

  kill() {
    if (!this.proc) return;
    if (!this._dead) {
      const err = new Error(`[${this.name}] killed`);
      this._dead = err;
      for (const { reject } of this._pending.values()) reject(err);
      this._pending.clear();
    }
    this._terminateProcess();
  }

  waitForExit(timeoutMs = this._killGraceMs + 500) {
    if (!this.proc || this._exited || this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return Promise.resolve(true);
    }

    return new Promise(resolve => {
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const timer = timeoutMs >= 0
        ? setTimeout(() => finish(false), timeoutMs)
        : null;
      timer?.unref?.();
      this.proc.once('exit', () => finish(true));
      this.proc.once('close', () => finish(true));
    });
  }

  forceKill() {
    if (!this.proc || this._exited) return;
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    if (this._pid && process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(this._pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    } else if (this._pid) {
      try { process.kill(-this._pid, 'SIGKILL'); } catch {}
    }
    try { this.proc.kill('SIGKILL'); } catch {}
  }

  _terminateProcess() {
    if (!this.proc || this._exited) return;
    if (this._pid) {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(this._pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {}
      } else {
        try { process.kill(-this._pid, 'SIGTERM'); } catch {}
        if (!this._killTimer && this._killGraceMs >= 0) {
          this._killTimer = setTimeout(() => {
            try { process.kill(-this._pid, 'SIGKILL'); } catch {}
            try { this.proc.kill('SIGKILL'); } catch {}
          }, this._killGraceMs);
          this._killTimer.unref?.();
        }
      }
    }
    try { this.proc.kill(); } catch {}
  }
}

module.exports = AcpClient;
module.exports.SAFE_ENV_KEYS = SAFE_ENV_KEYS;
module.exports.REAL_HOME_KEYS = REAL_HOME_KEYS;
module.exports.CRED_HOME_KEYS = CRED_HOME_KEYS;
module.exports.buildChildEnv = buildChildEnv;
module.exports.applyCredHome = applyCredHome;
module.exports.isTildeHomePath = isTildeHomePath;
