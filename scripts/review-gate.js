'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const REVIEW_GATE_TIMEOUT_MS = Number(process.env.REVIEW_GATE_TIMEOUT_MS || 300000);

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {}
    }
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }, 1000).unref?.();
  }
  try { child.kill('SIGTERM'); } catch {}
}

function collectJsFiles(entry, out = []) {
  const abs = path.resolve(root, entry);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      collectJsFiles(path.join(entry, name), out);
    }
  } else if (entry.endsWith('.js')) {
    out.push(entry);
  }
  return out;
}

function run(label, command, args, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const start = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs || REVIEW_GATE_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to start: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - start);
      process.stdout.write(`=== ${label} completed in ${(elapsedMs / 1000).toFixed(1)}s ===\n`);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${options.timeoutMs || REVIEW_GATE_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${code ?? `signal ${signal}`}`));
        return;
      }
      resolve();
    });
  });
}

async function syntaxCheck() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = new Set([...(pkg.files || []), 'scripts', 'test']);
  const files = [...entries].flatMap(entry => collectJsFiles(entry));

  for (const file of [...new Set(files)].sort()) {
    await run(`node --check ${file}`, process.execPath, ['--check', file]);
  }
}

(async () => {
  try {
    await syntaxCheck();
    await run('default config loads', process.execPath, ['-e', "require('./config'); console.log('ok')"]);
    await run('smoke tests', npmCmd, ['test']);
    await run('package dry-run', npmCmd, ['run', 'pack:check']);
    process.stdout.write('\nReview gate passed.\n');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
})();
