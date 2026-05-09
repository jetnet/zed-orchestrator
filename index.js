"use strict";

const { createInterface } = require("readline");
const { version } = require("./package.json");
const {
    orchestrate,
    requestedGroupName,
    stripGroupDirective,
    nextGroupName,
    rewriteSessionId,
    mergeMcpServers,
    log,
} = require("./orchestrator");
const {
    AGENT_GROUPS,
    DEFAULT_GROUP,
    MCP_SERVERS,
    AGENT_TIMEOUT_MS,
} = require("./config");
const { groupAllowsMutation } = require("./policy");

// ─── ACP framing ──────────────────────────────────────────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

const maybeReply = (id, result) => {
    if (id !== undefined && id !== null) reply(id, result);
};

const notifyText = (sessionId, text) =>
    send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
            sessionId,
            update: {
                type: "agent_message_chunk",
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
            },
        },
    });

const availableGroupCommands = () =>
    Object.values(AGENT_GROUPS).map((group) => ({
        name: group.name,
        description:
            group.description || `Use the "${group.name}" orchestrator group.`,
        input: { hint: "task or instructions" },
    }));

const notifyAvailableCommands = (sessionId) =>
    send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
            sessionId,
            update: {
                type: "available_commands_update",
                sessionUpdate: "available_commands_update",
                availableCommands: availableGroupCommands(),
            },
        },
    });

const scheduleAvailableCommands = (sessionId) => {
    // Zed inserts the session into its foreground session map after session/new
    // resolves. Immediate post-response notifications can race that insertion
    // and be dropped as "unknown session", so publish after a short delay and
    // repeat once for older/slower clients.
    for (const delayMs of [100, 1000]) {
        setTimeout(() => {
            if (sessions.has(sessionId)) notifyAvailableCommands(sessionId);
        }, delayMs);
    }
};

// ─── Zed RPC (proxied child requests) ────────────────────────────────────────

const pendingZedRequests = new Map();
let zedRequestId = 1;
let zedClientCapabilities = {};

function rejectPendingZedRequests(err) {
    for (const { reject, timer } of pendingZedRequests.values()) {
        if (timer) clearTimeout(timer);
        reject(err);
    }
    pendingZedRequests.clear();
}

function rpcToZed(method, params, timeoutMs = AGENT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const id = `orch-req-${zedRequestId++}`;
        const timer =
            timeoutMs > 0
                ? setTimeout(() => {
                      pendingZedRequests.delete(id);
                      const err = new Error(
                          `TIMEOUT:${timeoutMs}ms — ${method} did not respond`,
                      );
                      err.code = -32000;
                      reject(err);
                  }, timeoutMs)
                : null;
        pendingZedRequests.set(id, { resolve, reject, timer });
        send({ jsonrpc: "2.0", id, method, params });
    });
}

// ─── Session table ────────────────────────────────────────────────────────────

// sessionId → { workDir, mcpServers, groupName, ctx? }
const sessions = new Map();

// ─── Message loop ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
process.stdin.resume();

rl.on("line", async (line) => {
    let msg;
    try {
        msg = JSON.parse(line.trim());
    } catch {
        return;
    }

    // Responses to our outbound Zed requests
    if (msg.method == null && msg.id != null) {
        const pending = pendingZedRequests.get(msg.id);
        if (!pending) return;
        pendingZedRequests.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) {
            const err = new Error(msg.error.message || "RPC error");
            err.code = Number.isInteger(msg.error.code)
                ? msg.error.code
                : -32000;
            if (msg.error.data !== undefined) err.data = msg.error.data;
            pending.reject(err);
        } else {
            pending.resolve(msg.result);
        }
        return;
    }

    if (msg.method === "initialize") {
        zedClientCapabilities = msg.params?.clientCapabilities || {};
        reply(msg.id, {
            protocolVersion: 1,
            agentInfo: { name: "zed-orchestrator", version },
            agentCapabilities: {
                promptCapabilities: { image: true, embeddedContext: true },
                mcpCapabilities: { http: true, sse: false },
                sessionCapabilities: { close: {} },
            },
            authMethods: [],
        });
    } else if (msg.method === "session/new") {
        const sessionId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        sessions.set(sessionId, {
            workDir:
                msg.params?.cwd ||
                msg.params?.workingDirectory ||
                process.cwd(),
            mcpServers: msg.params?.mcpServers || [],
            groupName: DEFAULT_GROUP,
            promptCounter: 0,
        });
        log(`Session created: ${sessionId}, group=${DEFAULT_GROUP}`);
        reply(msg.id, { sessionId });
        scheduleAvailableCommands(sessionId);
    } else if (msg.method === "session/prompt") {
        const { sessionId, prompt } = msg.params;
        const session = sessions.get(sessionId);
        if (!session) {
            send({
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                    code: -32000,
                    message: `Unknown session: ${sessionId}`,
                },
            });
            return;
        }
        if (session.ctx) {
            send({
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                    code: -32000,
                    message: "Session busy: a prompt is already in progress",
                },
            });
            return;
        }

        let task = prompt || [];
        const { workDir } = session;
        const requestedGroup = requestedGroupName(task);
        if (requestedGroup) {
            if (!AGENT_GROUPS[requestedGroup]) {
                send({
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                        code: -32602,
                        message: `Unknown orchestrator group: ${requestedGroup}`,
                    },
                });
                return;
            }
            session.groupName = requestedGroup;
            task = stripGroupDirective(task);
        }
        const group = AGENT_GROUPS[session.groupName];
        const activeGroupName = group.name;
        const promptId = ++session.promptCounter;
        const runId = `${sessionId}-prompt-${String(promptId).padStart(4, "0")}`;

        const ctx = {
            cancelled: false,
            clients: new Set(),
            rpcToZed,
            latestApprovedPlans: session.latestApprovedPlans || {},
        };
        session.ctx = ctx;

        log(
            `Task received (${task.length} block(s)), group=${group.name}, orchestrating…`,
        );
        let finalResult;
        try {
            const outcome = await orchestrate(
                sessionId,
                runId,
                promptId,
                task,
                workDir,
                group,
                ctx,
                session.mcpServers,
                notifyText,
                zedClientCapabilities,
            );
            finalResult = outcome.text;
            if (outcome.approved && !ctx.cancelled) {
                const next = nextGroupName(group.name);
                const nextGroup = next ? AGENT_GROUPS[next] : null;
                if (nextGroup && !groupAllowsMutation(nextGroup)) {
                    session.groupName = next;
                    notifyText(
                        sessionId,
                        `\n> Group "${group.name}" approved. Next prompt will use group "${next}".\n`,
                    );
                } else if (nextGroup) {
                    notifyText(
                        sessionId,
                        `\n> Group "${group.name}" approved. Use /${next} explicitly for that one prompt.\n`,
                    );
                }
            }
        } catch (err) {
            log(`fatal error: ${err.message}\n${err.stack}`);
            finalResult = `Orchestrator fatal error: ${err.message}`;
        } finally {
            if (ctx.latestApprovedPlans)
                session.latestApprovedPlans = ctx.latestApprovedPlans;
            const activeGroup = AGENT_GROUPS[activeGroupName];
            if (
                activeGroup?.persist === false ||
                activeGroup?.strategy === "single_writer"
            ) {
                session.groupName = DEFAULT_GROUP;
            }
            session.ctx = null;
        }

        if (finalResult) {
            notifyText(sessionId, `\n${finalResult}\n`);
        }
        reply(msg.id, { stopReason: ctx.cancelled ? "cancelled" : "end_turn" });
    } else if (msg.method === "session/cancel") {
        const { sessionId } = msg.params || {};
        const session = sessions.get(sessionId);
        if (session?.ctx) {
            session.ctx.cancelled = true;
            for (const c of session.ctx.clients) c.kill();
            log(`Session cancelled: ${sessionId}`);
        }
        maybeReply(msg.id, {});
    } else if (
        msg.method === "session/release" ||
        msg.method === "session/close"
    ) {
        const { sessionId } = msg.params || {};
        const session = sessions.get(sessionId);
        if (session?.ctx) {
            session.ctx.cancelled = true;
            for (const c of session.ctx.clients) c.kill();
        }
        sessions.delete(sessionId);
        maybeReply(msg.id, {});
    } else if (msg.method && msg.id != null) {
        send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
        });
    }
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down…`);
    rejectPendingZedRequests(
        new Error(`orchestrator shutting down: ${signal}`),
    );
    const clients = new Set();
    for (const session of sessions.values()) {
        if (session.ctx) {
            session.ctx.cancelled = true;
            for (const c of session.ctx.clients) clients.add(c);
        }
    }
    for (const c of clients) c.kill();
    await Promise.allSettled([...clients].map((c) => c.waitForExit?.(1500)));
    for (const c of clients) c.forceKill?.();
    await Promise.allSettled([...clients].map((c) => c.waitForExit?.(250)));
    process.exit(0);
}

process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
rl.on("close", () => {
    void shutdown("stdin-closed");
});
process.stdin.on("end", () => {
    void shutdown("stdin-end");
});

process.on("uncaughtException", (err) =>
    log(`uncaughtException: ${err.message}\n${err.stack}`),
);
process.on("unhandledRejection", (err) =>
    log(`unhandledRejection: ${err?.message || err}`),
);

log(`Started. defaultGroup=${DEFAULT_GROUP}`);
