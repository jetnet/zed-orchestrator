'use strict';

const fs = require('fs');
const path = require('path');

function unquoteEnvValue(value) {
  const raw = String(value || '').trim();
  if (raw.length < 2) return raw;

  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return raw;
  }

  const inner = raw.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2] || '';
    if (!value.startsWith('"') && !value.startsWith("'")) {
      value = value.replace(/\s+#.*$/, '');
    }
    out[match[1]] = unquoteEnvValue(value);
  }
  return out;
}

function loadDotEnvForConfig(configPath, env = process.env) {
  const envPath = path.join(path.dirname(path.resolve(configPath)), '.env');
  if (!fs.existsSync(envPath)) return { path: envPath, loaded: false, keys: [] };

  const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  const keys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    keys.push(key);
  }
  return { path: envPath, loaded: true, keys };
}

function expandConfigString(str) {
  if (typeof str !== 'string') return str;
  const wholeBareEnv = str.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (wholeBareEnv) return process.env[wholeBareEnv[1]] || '';

  // Replace {env:VAR} then ${VAR}. Bare $VAR is only expanded when it is the
  // entire string, so JSON payloads containing keys such as "$schema" survive.
  const step1 = str.replace(/\{env:([A-Za-z0-9_]+)\}/g, function(_, v) { return process.env[v] || ''; });
  return step1.replace(/\$\{([^}]+)\}/g, function(_, v) { return process.env[v] || ''; });
}

function expandConfigPlaceholders(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return expandConfigString(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = expandConfigPlaceholders(obj[i]);
    return obj;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) obj[k] = expandConfigPlaceholders(obj[k]);
    return obj;
  }
  return obj;
}

module.exports = {
  expandConfigPlaceholders,
  expandConfigString,
  loadDotEnvForConfig,
  parseDotEnv,
};
