// SPDX-License-Identifier: AGPL-3.0-only
// The gateway's route: a narrow listener of its own for one program outside the server, the model
// gateway in front of the agents, which reads tasks' settings (tasksettings.ts) and records when it
// moved a task's work to a cloud model. Off unless CIRCLECHAT_GATEWAY_PORT is set.
//
//   CIRCLECHAT_GATEWAY_PORT      the port; unset, there is no listener
//   CIRCLECHAT_GATEWAY_HOST      the address it binds to (default 127.0.0.1)
//   CIRCLECHAT_GATEWAY_KEY_FILE  a file holding the key itself, read once at start. Without it,
//                                every request is refused.
//
// - Auth: `Authorization: Bearer <key>`, its sha256 compared in constant time. This key works on no
//   other route, and no other credential (a session, an agent's token, a service account's key) works
//   here. A wrong or missing key gets 401 with no detail.
// - Routes, and nothing else (the main port never serves /gateway/...; server.ts answers 404):
//     GET  /gateway/tasks/:id                  { task, status, settings, open }
//     GET  /gateway/agents/:handle/tasks       { tasks: [ids] }: the agent's open assigned tasks in the
//                                              chat of the turn it has running now; [] when idle
//     GET  /gateway/agents/:handle/tasks/:id   { on }: the agent created the task or is assigned to it
//     POST /gateway/tasks/:id/cloud-switch     { n, reason }: the only write (see cloudSwitch)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { App } from "./app.ts";
import { CLOUD_REASONS, cloudText, hasCloudSwitch, recordCloudSwitch, settingsOf, type CloudReason } from "./tasksettings.ts";

/** The statuses of a task still being worked on. */
const OPEN_STATUSES = ["todo", "working", "needs_you", "checking"];
/** Agent states while a turn runs (agents/runtime.ts): its status then names the turn's chat. */
const TURN_STATES = new Set(["working", "waiting_approval"]);
const MAX_BODY = 4096;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** The key's sha256, from the key file, or null when there is no usable key (then nothing gets in). */
export function readGatewayKey(file: string | undefined, log: (line: string) => void = console.error): Buffer | null {
  if (!file) {
    log("Gateway route: CIRCLECHAT_GATEWAY_KEY_FILE isn't set, so it refuses every request.");
    return null;
  }
  try {
    if (!existsSync(file)) throw new Error("no such file");
    const key = readFileSync(file, "utf8").trim();
    if (!key) throw new Error("the file is empty");
    return sha256(key);
  } catch (e) {
    log(`Gateway route: the key file can't be used, so it refuses every request: ${(e as Error).message}`);
    return null;
  }
}

/** Whether a request carries the key. Constant time in the key's contents. */
export function hasKey(header: string | undefined, keyHash: Buffer | null): boolean {
  if (!keyHash) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), keyHash);
}

/** Whether a task is still open for the gateway: not done or cancelled, not archived, nor in an archived chat. */
function isOpen(app: App, t: any): boolean {
  if (!OPEN_STATUSES.includes(t.status) || t.archivedAt) return false;
  return !app.svc.chat(t.chatId)?.archivedAt;
}

/** An agent by its handle (never by id), or undefined. */
function agentByHandle(app: App, handle: string) {
  const a = app.svc.agent(handle.toLowerCase());
  return a && a.handle === handle.toLowerCase() ? a : undefined;
}

/** The open tasks assigned to the agent in the chat of the turn it has running now. */
export function runningTasks(app: App, handle: string): string[] {
  const a = agentByHandle(app, handle);
  if (!a) return [];
  const s = app.runtime.statusOf(a.id);
  if (!TURN_STATES.has(s.state) || !s.chatId) return [];
  return app.svc
    .tasks(s.chatId)
    .filter((t) => t.assigneeType === "agent" && t.assigneeId === a.id && isOpen(app, t))
    .map((t) => t.id as string);
}

type Answer = { status: number; body?: unknown };

/**
 * Records a switch to a cloud model: `{ n: <int ≥ 1>, reason: "stalled" | "cloud_from_start" }`, no
 * other fields. 404 for no such task, 400 for a bad body, 200 `{ duplicate: true }` when (task, n) is
 * recorded already (nothing changes), 409 when the task is done, cancelled or archived, and 201 when
 * recorded: then a system line in the task's chat, with the server's own text, and the task event.
 */
export function cloudSwitch(app: App, taskId: string, body: unknown): Answer {
  const { svc, db } = app;
  const t = svc.task(taskId);
  if (!t) return { status: 404, body: { error: "no such task" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "send { n, reason }" } };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "n" && k !== "reason")) return { status: 400, body: { error: "only n and reason" } };
  if (typeof b.n !== "number" || !Number.isSafeInteger(b.n) || b.n < 1) return { status: 400, body: { error: "n must be a whole number from 1" } };
  if (typeof b.reason !== "string" || !(CLOUD_REASONS as readonly string[]).includes(b.reason)) return { status: 400, body: { error: `reason must be one of ${CLOUD_REASONS.join(", ")}` } };
  const n = b.n;
  const reason = b.reason as CloudReason;
  if (hasCloudSwitch(db, t.id, n)) return { status: 200, body: { duplicate: true } };
  if (!isOpen(app, t)) return { status: 409, body: { error: "the task is done, cancelled or archived" } };
  const at = Date.now();
  if (!recordCloudSwitch(db, t.id, n, reason, at)) return { status: 200, body: { duplicate: true } };
  svc.insertMessage({
    chatId: t.chatId,
    authorType: "system",
    authorId: "",
    kind: "system",
    body: cloudText(db, t.title, reason, at, settingsOf(db, t.id)),
    meta: { reason: "task_cloud_switch", taskId: t.id, cloud: reason, n },
  });
  const task = svc.task(t.id);
  svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
  return { status: 201, body: { ok: true } };
}

const SEG = "([A-Za-z0-9_-]{1,100})";
const ROUTES: { method: string; re: RegExp; run: (app: App, m: RegExpExecArray, body: unknown) => Answer }[] = [
  {
    method: "GET",
    re: new RegExp(`^/gateway/tasks/${SEG}$`),
    run: (app, m) => {
      const t = app.svc.task(m[1]);
      if (!t) return { status: 404, body: { error: "no such task" } };
      return { status: 200, body: { task: t.id, status: t.status, settings: settingsOf(app.db, t.id), open: isOpen(app, t) } };
    },
  },
  {
    method: "GET",
    re: new RegExp(`^/gateway/agents/${SEG}/tasks$`),
    run: (app, m) => ({ status: 200, body: { tasks: runningTasks(app, m[1]) } }),
  },
  {
    method: "GET",
    re: new RegExp(`^/gateway/agents/${SEG}/tasks/${SEG}$`),
    run: (app, m) => {
      const a = agentByHandle(app, m[1]);
      const t = app.svc.task(m[2]);
      const on = !!a && !!t && (t.createdBy === a.id || (t.assigneeType === "agent" && t.assigneeId === a.id));
      return { status: 200, body: { on } };
    },
  },
  {
    method: "POST",
    re: new RegExp(`^/gateway/tasks/${SEG}/cloud-switch$`),
    run: (app, m, body) => cloudSwitch(app, m[1], body),
  },
];

/** The body as text, or null when it is over MAX_BODY (the rest is read and dropped, so the answer still arrives). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res: ServerResponse, a: Answer) => res.writeHead(a.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(a.body ?? {}));

/** The listener's request handler. `keyHash`: the key's sha256, or null to refuse everything. */
export function createGatewayRouteServer(app: App, keyHash: Buffer | null): Server {
  return createServer(async (req, res) => {
    try {
      if (!hasKey(req.headers.authorization, keyHash)) return send(res, { status: 401, body: { error: "unauthorized" } });
      const path = (req.url ?? "/").split("?")[0];
      const route = ROUTES.find((r) => r.re.test(path));
      if (!route) return send(res, { status: 404, body: { error: "not found" } });
      if (req.method !== route.method) return send(res, { status: 405, body: { error: "method not allowed" } });
      let body: unknown;
      if (route.method === "POST") {
        const raw = await readBody(req);
        if (raw === null) return send(res, { status: 400, body: { error: "body too large" } });
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return send(res, { status: 400, body: { error: "the body isn't JSON" } });
        }
      }
      send(res, route.run(app, route.re.exec(path)!, body));
    } catch (e) {
      console.error(`Gateway route: ${(e as Error).message}`);
      if (!res.headersSent) send(res, { status: 500, body: { error: "server error" } });
      else res.end();
    }
  });
}

/**
 * Starts the listener from the environment, and returns it at once (it emits "listening" when it
 * does). Null, and nothing listens, without CIRCLECHAT_GATEWAY_PORT or with a port that isn't one.
 * A failed listen logs and tries again.
 */
export function startGatewayRoute(app: App, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): Server | null {
  const raw = env.CIRCLECHAT_GATEWAY_PORT ?? "";
  if (!raw) return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    console.error(`Gateway route: CIRCLECHAT_GATEWAY_PORT "${raw}" isn't a port, so there is no gateway route.`);
    return null;
  }
  const host = env.CIRCLECHAT_GATEWAY_HOST || "127.0.0.1";
  const server = createGatewayRouteServer(app, readGatewayKey(env.CIRCLECHAT_GATEWAY_KEY_FILE));
  const tryListen = () => {
    server.once("error", (e) => {
      server.removeAllListeners("listening");
      console.error(`Gateway route on ${host}:${port} failed: ${e.message}. Retrying.`);
      setTimeout(tryListen, 5000).unref();
    });
    server.listen(port, host, () => {
      server.removeAllListeners("error");
      server.on("error", (e) => console.error(`Gateway route: ${e.message}`));
      log(`Gateway route (tasks' settings only) on http://${host.includes(":") ? `[${host}]` : host}:${(server.address() as any)?.port ?? port}/gateway/`);
    });
  };
  tryListen();
  return server;
}
