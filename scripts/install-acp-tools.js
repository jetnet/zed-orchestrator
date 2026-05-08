#!/usr/bin/env node
// Installs the ACP CLIs that agents.config.json fronts with `npx --yes --package …`,
// so the orchestrator can spawn them by bare binary name. Saves the per-spawn npx
// overhead (~100–500 ms after the first cached run) and removes the duplicate npm
// cache between Zed's bundled Node and the user's npm.
//
// Auth state is unaffected — credentials live in $HOME (e.g. ~/.claude/.credentials.json,
// ~/.gemini/, ~/.codex/, ~/.config/opencode/, ~/.config/kilo/) regardless of which
// binary spawns the process.

const { spawnSync } = require('child_process');

const PACKAGES = [
  { pkg: '@agentclientprotocol/claude-agent-acp@0.32.0', bin: 'claude-agent-acp' },
  { pkg: '@google/gemini-cli@0.41.1',                    bin: 'gemini' },
  { pkg: '@zed-industries/codex-acp@0.5.0',              bin: 'codex-acp' },
  { pkg: '@kilocode/cli@1.0.0',                          bin: 'kilo' },
  { pkg: 'opencode-ai@0.6.0',                            bin: 'opencode' },
];

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

process.stdout.write(`Installing ${PACKAGES.length} ACP CLIs globally via ${npmCmd}...\n\n`);

const result = spawnSync(npmCmd, ['install', '-g', ...PACKAGES.map(p => p.pkg)], {
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`\nFailed to launch ${npmCmd}: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(`\nnpm install exited with status ${result.status}.\n`);
  process.exit(result.status || 1);
}

process.stdout.write('\nInstalled. Update agents.config.json to use bare binary names:\n\n');
for (const { pkg, bin } of PACKAGES) {
  process.stdout.write(`  ${pkg}\n`);
  process.stdout.write(`    Replace:  "command": "npx", "args": ["--yes", "--package", "${pkg}", "${bin}", ...rest]\n`);
  process.stdout.write(`    With:     "command": "${bin}", "args": [...rest]\n\n`);
}
process.stdout.write('Existing env keys (e.g. ANTHROPIC_MODEL, OPENCODE_CONFIG_CONTENT) and rateLimitKey stay the same.\n');
