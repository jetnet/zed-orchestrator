'use strict';

const PATTERNS = [
  // Anthropic / OpenAI style bearer keys
  [/sk-[A-Za-z0-9_-]{20,}/g,                           'sk-…REDACTED…'],
  // Generic Bearer tokens in headers
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,                  'Bearer …REDACTED…'],
  // Google / GCP API keys (AIza…, ya29…)
  [/AIza[A-Za-z0-9_-]{35,}/g,                          'AIza…REDACTED…'],
  [/ya29\.[A-Za-z0-9._-]{50,}/g,                       'ya29.…REDACTED…'],
  // GitHub, AWS, Slack, JWTs, PEM private keys, and URLs with embedded credentials
  [/gh[pousr]_[A-Za-z0-9_]{36,}/g,                      'gh…REDACTED…'],
  [/AKIA[0-9A-Z]{16}/g,                                 'AKIA…REDACTED…'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----…REDACTED…-----END PRIVATE KEY-----'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'eyJ…REDACTED…'],
  [/(https?:\/\/)([^:\s/@]+):([^@\s]+)@/g,              '$1…REDACTED…@'],
  [/xox[baprs]-[A-Za-z0-9-]+/g,                         'xox…REDACTED…'],
  // Generic "token = <value>" patterns, including quoted JSON/config forms.
  [
    /(^|[{\s,])((["']?)(api[_-]?key|token|secret|password|credential)\3\s*[:=]\s*)(["'])([^"'\r\n]{8,})\5/gi,
    (_match, lead, prefix, _keyQuote, _key, valueQuote) => `${lead}${prefix}${valueQuote}…REDACTED…${valueQuote}`,
  ],
  [
    /(^|[{\s,])((["']?)(api[_-]?key|token|secret|password|credential)\3\s*[:=]\s*)([^\s,\]}"']{8,})/gi,
    (_match, lead, prefix) => `${lead}${prefix}…REDACTED…`,
  ],
];

function redact(value) {
  let s = String(value == null ? '' : value);
  for (const [pattern, replacement] of PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

module.exports = { redact };
