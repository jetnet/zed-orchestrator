# Zed Orchestrator ACP Development Skill (Consolidated)

> **Purpose** – This skill guides any model that edits the local Zed custom ACP orchestrator.  
> The orchestrator runs *planning/review* agents in **read‑only** mode and a single **writer** agent for code changes.  
> Do **not** add public‑service‑style complexity (databases, auth, background daemons, git worktrees, distributed locks, etc.) unless explicitly requested.

---

## 1. Product Model

| Strategy            | Behaviour                                    |
|---------------------|----------------------------------------------|
| `parallel_reports`  | Many independent, **read‑only** agents produce reports → `.plan/orchestrator` artifacts. |
| `single_writer`     | Exactly **one** writer agent may mutate code; an optional read‑only reviewer may synthesize. |

*Read‑only* means the orchestrator’s **ACP‑mediated** policy denies any `writeFiles`, `terminal`, or other mutating capabilities. The child process may still have OS‑level access; that is outside the ACP contract.

---

## 2. Invariant Checklist (Non‑Negotiable)

1. **`parallel_reports` is always read‑only**  
   - Startup must reject any write‑capable config (e.g., `permissions: "writer_only"`, `writeFiles: true`, `terminal: true`).  
   - `writer` / `writerPermissions` fields are illegal in this strategy.

2. **`single_writer` has exactly one writer**  
   - Must specify `writer` that matches a single `subAgents[].name`.  
   - Only that agent receives write/terminal permissions; reviewer stays read‑only.  
   - No auto‑advance into a write‑capable group; user must invoke it explicitly (e.g., via `/code`).

3. **Strategy, not name, drives behaviour**  
   - Do not hard‑code logic to group names like `plan`, `review`, or `code`.  
   - Apply read‑only rules to *any* group where `strategy === "parallel_reports"` and mutation rules to `strategy === "single_writer"`.

4. **Policy enforcement** – All child requests are filtered **before** reaching Zed. Unknown or future methods are denied by default in read‑only phases.

5. **Artifact safety**  
   - Paths are workspace‑relative, no `..` traversal, no absolute paths, no symlink escapes.  
   - Write via temp file + atomic rename.  
   - All secrets are redacted before writing prompts, reports, errors, or logs.

6. **Reviewer‑prompt injection defenses**  
   - Escape `<`, `>`, `&`, quotes in `<agent_report …>` wrappers.  
   - Neutralize line‑starting `APPROVED:` / `QUESTIONS:` in child reports.  
   - Truncate each child report before embedding in the reviewer prompt.

7. **Child process lifecycle** – Every child is terminated on success, error, timeout, cancellation, or session close (SIGTERM → short wait → SIGKILL).

8. **Config validation must be actionable** – Errors must mention the exact JSON‑path (e.g., `agentGroups.plan.permissions: unknown policy "bad"`).

9. **Read‑only ≠ OS sandbox** – Document that ACP read‑only only blocks mediated requests; the child binary can still modify the filesystem directly.

---

## 3. Required Pre‑Edit Reading

Before making any modification, read the following files (they are referenced throughout the skill):

- `README.md`
- `package.json`
- `index.js`
- `orchestrator.js`
- `acp-client.js`
- `policy.js`
- `config.js`
- `artifact-store.js`
- `rate-limiter.js`
- `concurrency.js`
- `redact.js`
- `agents.config.json`
- `agents.config.schema.json`
- `scripts/review-gate.js`
- `test/smoke.js`
- All `*.review/*.md` reports

---

## 4. Detailed Rules & Code Snippets

### 4.1 Parallel‑Reports Read‑Only Guard

```js
const { normalizePolicy, READ_ONLY_POLICY } = require('./policy');

function policyAllowsMutation(p) {
  return Boolean(p.writeFiles || p.terminal);
}

function assertReadOnlyParallelReports(name, group) {
  if ((group.strategy || 'parallel_reports') !== 'parallel_reports') return;
  const sub = normalizePolicy(group.permissions, READ_ONLY_POLICY);
  const rev = normalizePolicy(group.reviewerPermissions, READ_ONLY_POLICY);
  if (policyAllowsMutation(sub) || policyAllowsMutation(rev)) {
    throw new Error(
      `agentGroups.${name}: parallel_reports groups must be read-only; ` +
      `use single_writer for mutation`
    );
  }
  if (group.writer !== undefined || group.writerPermissions !== undefined) {
    throw new Error(
      `agentGroups.${name}: writer fields only valid for single_writer groups`
    );
  }
}
```

*Add a unit test that a write‑capable `parallel_reports` config causes a non‑zero exit with the exact error text.*

### 4.2 Single‑Writer Validation

```js
function validateSingleWriter(name, group) {
  if (group.strategy !== 'single_writer') return;
  if (!group.writer) throw new Error(`agentGroups.${name}: missing writer`);
  const writerNames = group.subAgents.map(a => a.name);
  if (!writerNames.includes(group.writer)) {
    throw new Error(`agentGroups.${name}: writer "${group.writer}" not in subAgents`);
  }
  if (writerNames.filter(n => n === group.writer).length > 1) {
    throw new Error(`agentGroups.${name}: duplicate writer name "${group.writer}"`);
  }
}
```

*Test cases:* missing writer, unknown writer, duplicate writer, and that only the writer receives write/terminal permissions.

### 4.3 Reviewer Prompt Construction (Injection Safety)

```js
function escapeForXml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildAgentReport(name, body) {
  const safeName = escapeForXml(name);
  const safeBody = escapeForXml(truncateForReviewer(body));
  return `<agent_report name="${safeName}">\n${safeBody}\n</agent_report>`;
}
```

*Add tests covering `APPROVED:`, `QUESTIONS:`, stray `</agent_report>` and fake nested tags.*

### 4.4 Artifact Path Safety

```js
function safeArtifactPath(p) {
  if (path.isAbsolute(p)) throw new Error('artifact path must be relative');
  if (p.includes('..')) throw new Error('artifact path must not escape workspace');
  const full = path.resolve(workspaceRoot, p);
  if (!full.startsWith(workspaceRoot)) throw new Error('artifact path resolves outside workspace');
  // symlink check omitted for brevity; use fs.realpathSync and compare again.
  return full;
}
```

*Tests must verify rejection of absolute paths, `../` traversal, and symlink escapes.*

### 4.5 Config Validation Error Style

```
rateLimits.node.requestsPerMinute must be a number > 0
mcpServers[0].url must be a non‑empty string
subAgents[0].env.TOKEN must be a string
agentGroups.plan.permissions: unknown permissions policy "bad"
```

*Prefer explicit manual checks; schema validation (AJV) may supplement but must not replace these messages.*

---

## 5. Test Suite Requirements

| Category | Example Test Description |
|----------|--------------------------|
| **Policy** | Reject write‑capable `parallel_reports`; deny `fs/write_text_file` in read‑only phases. |
| **Writer** | Fail when `single_writer` missing or duplicate writer; ensure only writer can write. |
| **Strategy‑Based Logic** | Custom‑named `parallel_reports` still receives read‑only behavior. |
| **Protocol** | `session/prompt` returns only `stopReason`; `session/cancel` emits no response. |
| **Child Contract** | Proper forwarding of supported resource types; denial of unsupported ones. |
| **Artifact Safety** | Reject absolute, `..`, symlink‑escape paths. |
| **Reviewer Injection** | Child report cannot dictate approval or inject malformed tags. |
| **Lifecycle** | Cancellation during a hanging health probe returns promptly; SIGTERM → SIGKILL fallback works. |
| **Config Errors** | Exact path‑based messages for every validation failure. |
| **Read‑Only Clarification** | Documentation contains explicit “not an OS sandbox” statement. |

Run the full gate after any change:

```bash
npm test
npm run pack:check
npm run review:gate
```

Optionally run integration tests only when real credentials are present:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

---

## 6. Summary of What This Consolidated Skill Covers

- **Authority rules** for both strategies.  
- **Validation logic** (policy, writer, config).  
- **Safety mechanisms** (artifact paths, reviewer injection, child lifecycle).  
- **Required pre‑edit reading** and **testing workflow**.  
- **Documentation stance** on read‑only vs OS sandbox.  
- **Code snippets** that can be copied into the project to enforce the above.  

Use this document as the single source of truth when reviewing, editing, or extending the Zed orchestrator.
