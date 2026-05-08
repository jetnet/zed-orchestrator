'use strict';

const fs = require('fs/promises');
const path = require('path');

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent';
}

function safeInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

async function safeInsideReal(root, target) {
  const rootReal = await fs.realpath(root);
  const targetReal = await fs.realpath(target);
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
}

// Pre-mkdir check: walk up from targetDir to find the first existing ancestor and verify
// its realpath is inside root. Prevents mkdir from creating directories outside the workspace
// when an intermediate component is a symlink pointing outside.
async function assertCreatableInside(root, targetDir) {
  let rootReal;
  try { rootReal = await fs.realpath(root); } catch { return; }
  let cur = path.resolve(targetDir);
  while (true) {
    try {
      const real = await fs.realpath(cur);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`Refusing to write artifact through symlink outside workspace: ${targetDir}`);
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

async function writeArtifact(workDir, relDir, relFile, content) {
  if (path.isAbsolute(relDir) || path.isAbsolute(relFile)) {
    throw new Error('Refusing to write artifact with absolute path');
  }

  const root = path.resolve(workDir);
  const dir = path.resolve(root, relDir);
  const file = path.resolve(dir, relFile);

  if (!safeInside(root, dir) || !safeInside(root, file)) {
    throw new Error(`Refusing to write artifact outside workspace: ${file}`);
  }

  await assertCreatableInside(root, dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await safeInsideReal(root, dir))) {
    throw new Error(`Refusing to write artifact through symlink outside workspace: ${dir}`);
  }

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}

function frontmatter(meta) {
  return [
    '---',
    ...Object.entries(meta)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
    '---',
    '',
  ].join('\n');
}

function roundRelDir(artifactDir, runId, groupName, turn) {
  const round = `round-${String(turn).padStart(3, '0')}`;
  return path.join(artifactDir, slug(runId), slug(groupName), round);
}

async function writeManifest(workDir, artifactDir, runId, manifest) {
  return writeArtifact(
    workDir,
    path.join(artifactDir, slug(runId)),
    'manifest.json',
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

async function writeInputPrompt(workDir, artifactDir, runId, text, meta = {}) {
  return writeArtifact(
    workDir,
    path.join(artifactDir, slug(runId)),
    'input-prompt.md',
    frontmatter({
      runId,
      sessionId: meta.sessionId || runId,
      promptId: meta.promptId,
      group: meta.group,
      status: 'input',
      createdAt: new Date().toISOString(),
    }) + `${text || ''}\n`,
  );
}

async function writeRoundReports(workDir, artifactDir, runId, groupName, turn, results, meta = {}) {
  const relDir = roundRelDir(artifactDir, runId, groupName, turn);
  const written = [];

  for (const [i, result] of results.entries()) {
    const name = result.name || `agent-${i + 1}`;
    const file = `${String(i + 1).padStart(2, '0')}-${slug(name)}.md`;
    const body = result.error
      ? `FAILED: ${result.error}\n`
      : `${result.result || ''}\n`;
    const content = frontmatter({
      runId,
      sessionId: meta.sessionId || runId,
      promptId: meta.promptId,
      group: groupName,
      round: turn,
      agent: name,
      status: result.error ? 'rejected' : 'fulfilled',
      createdAt: new Date().toISOString(),
    }) + body;
    written.push(await writeArtifact(workDir, relDir, file, content));
  }

  return written;
}

async function writeReviewerReport(workDir, artifactDir, runId, groupName, turn, reviewerName, text, meta = {}) {
  const relDir = roundRelDir(artifactDir, runId, groupName, turn);
  return writeArtifact(
    workDir,
    relDir,
    'reviewer.md',
    frontmatter({
      runId,
      sessionId: meta.sessionId || runId,
      promptId: meta.promptId,
      group: groupName,
      round: turn,
      agent: reviewerName,
      status: 'fulfilled',
      createdAt: new Date().toISOString(),
    }) + `${text || ''}\n`,
  );
}

async function writeReviewerPrompt(workDir, artifactDir, runId, groupName, turn, text, meta = {}) {
  const relDir = roundRelDir(artifactDir, runId, groupName, turn);
  return writeArtifact(
    workDir,
    relDir,
    'reviewer-prompt.md',
    frontmatter({
      runId,
      sessionId: meta.sessionId || runId,
      promptId: meta.promptId,
      group: groupName,
      round: turn,
      status: 'reviewer_prompt',
      createdAt: new Date().toISOString(),
    }) + `${text || ''}\n`,
  );
}

async function writeApprovedPlan(workDir, artifactDir, runId, groupName, text, meta = {}) {
  return writeArtifact(
    workDir,
    path.join(artifactDir, slug(runId)),
    'approved-plan.md',
    frontmatter({
      runId,
      sessionId: meta.sessionId || runId,
      promptId: meta.promptId,
      group: groupName,
      status: 'approved',
      sha256: meta.sha256,
      createdAt: new Date().toISOString(),
    }) + `${text || ''}\n`,
  );
}

async function writeApprovedPlanIndex(workDir, artifactDir, sessionId, planMeta) {
  const relFile = 'index.json';
  const root = path.resolve(workDir, artifactDir);
  const file = path.resolve(root, relFile);
  let index = { latestApprovedBySession: {} };

  try {
    if (safeInside(root, file)) {
      const stat = await fs.lstat(file);
      // Never follow a symlinked index while reading. writeArtifact() will later
      // replace the symlink with a regular file inside the workspace, but the
      // read side must not copy JSON from outside the artifact root.
      if (stat.isFile() && await safeInsideReal(root, file)) {
        const existing = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(existing);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          index = {
            latestApprovedBySession: parsed.latestApprovedBySession || {},
          };
        }
      }
    }
  } catch {}

  index.latestApprovedBySession[sessionId] = {
    path: path.relative(path.resolve(workDir), planMeta.path),
    sha256: planMeta.sha256,
    group: planMeta.group,
    createdAt: planMeta.createdAt,
  };

  return writeArtifact(
    workDir,
    artifactDir,
    relFile,
    JSON.stringify(index, null, 2) + '\n',
  );
}

module.exports = {
  slug,
  safeInside,
  safeInsideReal,
  writeArtifact,
  writeManifest,
  writeInputPrompt,
  writeRoundReports,
  writeReviewerPrompt,
  writeReviewerReport,
  writeApprovedPlan,
  writeApprovedPlanIndex,
};
