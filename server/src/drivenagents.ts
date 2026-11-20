// SPDX-License-Identifier: AGPL-3.0-only
// Agents a service drives. Root marks an agent as driven by a service account (cli.ts
// service-drive, serviceaccounts.ts). From then on:
//
// - Every message that would wake the agent goes to the service instead, as a request: from
//   people, from other agents (a hand-off), and from triggers. The routing rules don't change; only
//   where the delivery goes. The message itself still shows in the chat as before. Requests are kept
//   in the database (service_requests), so a service that was down picks up what waited.
// - Only the service's own messages reach the agent. The service posts in any chat the agent is in,
//   without being a member: a one-line note people see, and the full text, which goes only to the
//   agent. A note alone wakes nobody.
// - The service writes lines in the agent's Watch view (its activity), for the detail people don't
//   need in the chat.
// - The service attaches text files to a task for the agent, on the task alone and as the agent's
//   own, with attach_files's names, types and limits (files.ts's attachTaskText), zips the agent's
//   files of a plan onto a task (zipTaskFiles), and deletes such files of its agents, never anyone
//   else's (deleteTaskFile).
// - The service archives and restores the tasks of the agents it drives (archive.ts).
// - The service reads the text of a file in its chats, such as a PDF a person attached (uploads.ts),
//   and each request lists the files on its message.
// - A request nobody has picked up after two minutes gets one note in its chat, so people know the
//   agent isn't ignoring them.
//
// The service sees only the chats its agents are in, worked out on each request: take an agent out
// of a chat and the service loses that chat at once. In those chats it reads messages, tasks and
// files, changes tasks, attaches text files to tasks for its agents, and posts notes and messages to
// its agents. It never sees the people list, emails, other chats, settings or memories, and never
// decides an approval.
//
// The routes are /api/service/* (with serviceaccounts.ts's checks), and its live events come on
// /ws/service: its requests, and the chat events of its chats, filtered like a person's
// (eventfilter.ts). Requests never go on the shared bus, so no person's socket gets one.
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import { WebSocketServer, WebSocket } from "ws";
import type { App } from "./app.ts";
import type { Delivery } from "./services.ts";
import { now } from "./db.ts";
import { id } from "./crypto.ts";
import { personHandle } from "./profile.ts";
import { eventVisible, statusSeenBy } from "./eventfilter.ts";
import { attachTaskText, deleteTaskFile, fileJson, fileDownload, FileRefusal, zipTaskFiles } from "./files.ts";
import { ArchiveRefusal, setArchived, TASK_STATUSES } from "./archive.ts";
import { driverOf, drivenAgents, serviceById, serviceForToken, serviceRequest, serviceTables, type ServiceAccount } from "./serviceaccounts.ts";

export const NOTE_AFTER_MS = 2 * 60_000;
const STATES = ["pending", "taken", "done", "declined"] as const;
type RequestState = (typeof STATES)[number];
const NEXT: Record<RequestState, RequestState[]> = { pending: ["taken", "done", "declined"], taken: ["done", "declined"], done: [], declined: [] };
// the chat events a service's socket carries, for its own chats only
const EVENT_TYPES = new Set(["message", "message_updated", "task", "delivery", "agent_status", "agent_activity", "typing", "chat"]);
const MAX_TEXT = 200_000;

function requestTables(app: App): void {
  serviceTables(app.db);
  app.db.exec(
    `CREATE TABLE IF NOT EXISTS service_requests (
      id TEXT PRIMARY KEY, service_id TEXT NOT NULL, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      from_type TEXT NOT NULL, from_id TEXT NOT NULL, text TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
      hop INTEGER NOT NULL DEFAULT 0, goal_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','taken','done','declined')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, noted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS service_requests_state ON service_requests(service_id, state);`,
  );
}

class HttpRefusal extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, msg: string) {
    super(msg);
    this.status = status;
  }
}

export class DrivenAgents {
  private app: App;
  /** "request" (serviceId, request): never on the shared bus */
  private requests = new EventEmitter();
  private timer: ReturnType<typeof setInterval> | null = null;
  private wss = new WebSocketServer({ noServer: true });

  constructor(app: App) {
    this.app = app;
    requestTables(app);
    this.requests.setMaxListeners(0);
    app.svc.divert = (d) => this.take(d);
  }
  start(): void {
    this.timer = setInterval(() => this.noteWaiting(), 30_000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ws of this.wss.clients) ws.terminate();
  }

  // ---------------------------------------------------------------- requests
  /** Takes a delivery for a driven agent; returns it as queued, or null when no service drives the agent. */
  take(d: { agentId: string; chatId: string; fromType: Delivery["fromType"]; fromId: string; text: string; hop: number; goalId: string; sourceMessageId?: string }): Delivery | null {
    const sid = driverOf(this.app.db, d.agentId);
    if (!sid) return null;
    const rid = id("sreq_");
    const t = now();
    this.app.db
      .prepare(
        "INSERT INTO service_requests(id, service_id, agent_id, chat_id, from_type, from_id, text, message_id, hop, goal_id, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)",
      )
      .run(rid, sid, d.agentId, d.chatId, d.fromType, d.fromId, d.text, d.sourceMessageId ?? "", d.hop, d.goalId, t, t);
    this.requests.emit("request", sid, this.request(rid));
    return { id: rid, agentId: d.agentId, chatId: d.chatId, fromType: d.fromType, fromId: d.fromId, text: d.text, hop: d.hop, goalId: d.goalId, state: "queued", createdAt: t };
  }
  request(rid: string): any {
    const r = this.app.db.prepare("SELECT * FROM service_requests WHERE id = ?").get(rid) as any;
    if (!r) return undefined;
    const a = this.app.svc.agent(r.agent_id);
    const chat = this.app.svc.chat(r.chat_id);
    return {
      id: r.id,
      agent: a?.handle ?? "",
      chatId: r.chat_id,
      chatKind: chat?.kind ?? "",
      from: { type: r.from_type, handle: this.handleOf(r.from_type, r.from_id) },
      text: r.text,
      messageId: r.message_id,
      // the files a person attached to the message (uploads.ts), with whether each one's text is ready
      files: r.message_id
        ? (
            this.app.db
              .prepare("SELECT f.*, t.state AS text_state, t.reason AS text_reason, t.pages AS text_pages FROM files f LEFT JOIN file_texts t ON t.file_id = f.id WHERE f.message_id = ? ORDER BY f.created_at")
              .all(r.message_id) as any[]
          ).map(fileJson)
        : [],
      hop: r.hop,
      goalId: r.goal_id,
      state: r.state,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private handleOf(type: string, fid: string): string {
    if (type === "user") return personHandle(this.app.db as any, fid) ?? "";
    if (type === "agent") return this.app.svc.agent(fid)?.handle ?? "";
    return fid; // a trigger's name
  }
  /** One note in the chat for each request nobody picked up within NOTE_AFTER_MS. */
  noteWaiting(at = now()): number {
    const rows = this.app.db.prepare("SELECT * FROM service_requests WHERE state = 'pending' AND noted_at IS NULL AND created_at <= ?").all(at - NOTE_AFTER_MS) as any[];
    for (const r of rows) {
      this.app.db.prepare("UPDATE service_requests SET noted_at = ? WHERE id = ?").run(at, r.id);
      const handle = this.app.svc.agent(r.agent_id)?.handle ?? "the agent";
      const service = serviceById(this.app.db, r.service_id)?.name ?? "its service";
      this.app.svc.insertMessage({
        chatId: r.chat_id,
        authorType: "system",
        authorId: "",
        kind: "system",
        body: `Messages for @${handle} go to ${service}, which hasn't picked this one up yet.`,
        meta: { reason: "service_waiting", requestId: r.id },
      });
    }
    return rows.length;
  }

  // ---------------------------------------------------------------- scope
  /** The chats a service's agents are in, now. */
  chatIds(sid: string): Set<string> {
    const ids = drivenAgents(this.app.db, sid).map((a) => a.id);
    if (!ids.length) return new Set();
    const rows = this.app.db.prepare(`SELECT DISTINCT chat_id FROM chat_members WHERE member_type = 'agent' AND member_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
    return new Set(rows.map((r) => r.chat_id));
  }
  private chatFor(s: ServiceAccount, cid: string): any {
    const chat = cid && this.chatIds(s.id).has(cid) ? this.app.svc.chat(cid) : undefined;
    if (!chat) throw new HttpRefusal(404, "no such chat");
    return chat;
  }
  private agentFor(s: ServiceAccount, handle: string): { id: string; handle: string; name: string } {
    const a = drivenAgents(this.app.db, s.id).find((x) => x.handle === String(handle ?? "").replace(/^@/, "").toLowerCase());
    if (!a) throw new HttpRefusal(403, `${s.name} doesn't drive @${String(handle ?? "").replace(/^@/, "")}`);
    return a;
  }

  // ---------------------------------------------------------------- routes
  routes(api: Hono<any>): void {
    const { db, svc } = this.app;
    const me = (c: any) => c.get("service") as ServiceAccount;
    const body = async (c: any) => {
      try {
        return await c.req.json();
      } catch {
        throw new HttpRefusal(400, "the body must be JSON");
      }
    };
    const handled = (fn: (c: any) => any) => async (c: any) => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof HttpRefusal) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };
    const memberOut = (m: { type: string; id: string }) =>
      m.type === "agent" ? { type: "agent", handle: svc.agent(m.id)?.handle ?? "" } : { type: "user", handle: personHandle(db as any, m.id) ?? "" };
    const chatOut = (chat: any) => ({ id: chat.id, kind: chat.kind, name: chat.name, createdAt: chat.createdAt, members: (chat.members ?? []).map(memberOut) });

    api.get("/api/service/agents", (c) => c.json({ agents: drivenAgents(db, me(c).id) }));

    api.get("/api/service/requests", (c) => {
      const want = String(c.req.query("state") ?? "pending,taken")
        .split(",")
        .filter((x) => (STATES as readonly string[]).includes(x));
      if (!want.length) return c.json({ requests: [] });
      const rows = db
        .prepare(`SELECT id FROM service_requests WHERE service_id = ? AND state IN (${want.map(() => "?").join(",")}) ORDER BY created_at LIMIT 500`)
        .all(me(c).id, ...want) as any[];
      return c.json({ requests: rows.map((r) => this.request(r.id)) });
    });
    const ownRequest = (c: any) => {
      const r = db.prepare("SELECT id, service_id, state FROM service_requests WHERE id = ?").get(c.req.param("id")) as any;
      if (!r || r.service_id !== me(c).id) throw new HttpRefusal(404, "no such request");
      return r;
    };
    api.get("/api/service/requests/:id", handled((c) => c.json({ request: this.request(ownRequest(c).id) })));
    api.patch(
      "/api/service/requests/:id",
      handled(async (c) => {
        const r = ownRequest(c);
        const state = String((await body(c)).state ?? "") as RequestState;
        if (!NEXT[r.state as RequestState].includes(state)) throw new HttpRefusal(409, `a ${r.state} request can't become ${state || "that"}`);
        db.prepare("UPDATE service_requests SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), r.id);
        return c.json({ request: this.request(r.id) });
      }),
    );

    api.get("/api/service/chats", (c) => c.json({ chats: [...this.chatIds(me(c).id)].map((cid) => chatOut(svc.chat(cid))).filter((x) => x.id) }));
    api.get("/api/service/chats/:id", handled((c) => c.json({ chat: chatOut(this.chatFor(me(c), c.req.param("id"))) })));
    api.get(
      "/api/service/chats/:id/messages",
      handled((c) => {
        const chat = this.chatFor(me(c), c.req.param("id"));
        const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
        const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
        const messages = svc.messages(chat.id, before, limit).map((m: any) => ({ ...m, author: this.handleOf(m.authorType, m.authorId) }));
        return c.json({ messages });
      }),
    );
    api.get(
      "/api/service/chats/:id/tasks",
      handled((c) => c.json({ tasks: svc.tasks(this.chatFor(me(c), c.req.param("id")).id) })),
    );
    api.patch(
      "/api/service/tasks/:id",
      handled(async (c) => {
        const t = svc.task(c.req.param("id"));
        if (!t || !this.chatIds(me(c).id).has(t.chatId)) throw new HttpRefusal(404, "no such task");
        const b = await body(c);
        const patch: { status?: string; title?: string; assigneeType?: string; assigneeId?: string } = {};
        if (b.status !== undefined) {
          if (!TASK_STATUSES.includes(String(b.status))) throw new HttpRefusal(400, `status is ${TASK_STATUSES.join(", ")}`);
          patch.status = String(b.status);
        }
        if (b.title !== undefined) {
          const title = String(b.title).trim().slice(0, 200);
          if (!title) throw new HttpRefusal(400, "a task needs a title");
          patch.title = title;
        }
        if (b.assignee !== undefined) {
          if (b.assignee === "" || b.assignee === null) Object.assign(patch, { assigneeType: "", assigneeId: "" });
          else Object.assign(patch, { assigneeType: "agent", assigneeId: this.agentFor(me(c), b.assignee).id });
        }
        return c.json({ task: svc.updateTask(t.id, patch) });
      }),
    );

    api.get(
      "/api/service/files",
      handled((c) => {
        const ids = this.chatIds(me(c).id);
        const task = c.req.query("task");
        const chat = c.req.query("chat");
        if (!task && !chat) throw new HttpRefusal(400, "ask for a task's files (?task=) or a chat's (?chat=)");
        const rows = (task ? db.prepare("SELECT * FROM files WHERE task_id = ? ORDER BY created_at").all(task) : db.prepare("SELECT * FROM files WHERE chat_id = ? ORDER BY created_at").all(chat)) as any[];
        return c.json({ files: rows.filter((r) => ids.has(r.chat_id)).map(fileJson) });
      }),
    );
    // a zip on a task, for the agent, of the agent's files in the task's plan: on the task alone, as the
    // agent's own, so the service bundles a set without asking the agent for a turn
    api.post(
      "/api/service/agents/:handle/zip",
      handled(async (c) => {
        const s = me(c);
        const a = this.agentFor(s, c.req.param("handle"));
        const b = await body(c);
        const t = svc.task(String(b.task ?? ""));
        if (!t || !this.chatIds(s.id).has(t.chatId)) throw new HttpRefusal(404, "no such task");
        if (!svc.isMember(t.chatId, "agent", a.id)) throw new HttpRefusal(409, `@${a.handle} isn't in that task's chat`);
        let stored;
        try {
          stored = zipTaskFiles({ db, svc, dataDir: this.app.cfg.dataDir }, { chatId: t.chatId, taskId: t.id, agentId: a.id, name: b.name, include: b.include });
        } catch (e) {
          if (e instanceof FileRefusal) throw new HttpRefusal(400, e.message);
          throw e;
        }
        return c.json({ file: fileJson(db.prepare("SELECT * FROM files WHERE id = ?").get(stored.id)) });
      }),
    );

    // a file on a task alone that one of the service's agents attached, or the service for it: never
    // anyone else's, and never a file on a message
    api.delete(
      "/api/service/files/:id",
      handled((c) => {
        const s = me(c);
        const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
        if (!r || !this.chatIds(s.id).has(r.chat_id)) throw new HttpRefusal(404, "no such file");
        if (!drivenAgents(db, s.id).some((a) => a.id === r.agent_id)) throw new HttpRefusal(403, `${s.name} may delete only the files of the agents it drives`);
        try {
          return c.json({ deleted: deleteTaskFile({ db, svc, dataDir: this.app.cfg.dataDir }, r.id) });
        } catch (e) {
          if (e instanceof FileRefusal) throw new HttpRefusal(409, e.message);
          throw e;
        }
      }),
    );

    // a file's text: a person's PDF, .txt or .md (uploads.ts), or an agent's text file, and why there is none
    api.get("/api/service/files/:id/text", (c) => {
      const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
      if (!r || !this.chatIds(me(c).id).has(r.chat_id)) return c.json({ error: "no such file" }, 404);
      return c.json(this.app.uploads.text(r.id));
    });
    api.get("/api/service/files/:id", (c) => {
      const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
      if (!r || !this.chatIds(me(c).id).has(r.chat_id)) return c.json({ error: "no such file" }, 404);
      return fileDownload(c, this.app.cfg.dataDir, r);
    });

    // a note people see, and, with agent and text, a message only that agent gets
    api.post(
      "/api/service/chats/:id/messages",
      handled(async (c) => {
        const s = me(c);
        const chat = this.chatFor(s, c.req.param("id"));
        const b = await body(c);
        const note = String(b.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!note) throw new HttpRefusal(400, "a note for people is needed: one line");
        let agent: { id: string; handle: string } | undefined;
        let text = "";
        if (b.agent !== undefined) {
          agent = this.agentFor(s, b.agent);
          if (!svc.isMember(chat.id, "agent", agent.id)) throw new HttpRefusal(409, `@${agent.handle} isn't in that chat`);
          text = String(b.text ?? "");
          if (!text.trim()) throw new HttpRefusal(400, "the text for the agent is missing");
          if (text.length > MAX_TEXT) throw new HttpRefusal(400, `the text is longer than ${MAX_TEXT} characters`);
        } else if (b.text !== undefined) throw new HttpRefusal(400, "text goes to an agent: name the agent");
        const message = svc.insertMessage({ chatId: chat.id, authorType: "system", authorId: s.id, kind: "service", body: note, meta: { service: s.name, agent: agent?.handle ?? "" } });
        const delivery = agent
          ? svc.deliver({ agentId: agent.id, chatId: chat.id, fromType: "service", fromId: s.id, text, hop: 0, goalId: String(b.goalId ?? "") || id("goal_"), sourceMessageId: message.id })
          : null;
        return c.json({ message, delivery });
      }),
    );

    // archive or restore a task of an agent the service drives (archive.ts): it leaves every list, and stays
    for (const action of ["archive", "restore"] as const)
      api.post(
        `/api/service/tasks/:id/${action}`,
        handled((c) => {
          const s = me(c);
          const t = svc.task(c.req.param("id"));
          if (!t || !this.chatIds(s.id).has(t.chatId)) throw new HttpRefusal(404, "no such task");
          if (t.assigneeType !== "agent" || !drivenAgents(db, s.id).some((a) => a.id === t.assigneeId))
            throw new HttpRefusal(403, `${s.name} may ${action} only the tasks of the agents it drives`);
          try {
            return c.json({ ok: true, changed: setArchived(this.app, "task", t.id, action === "archive", `service:${s.id}`) });
          } catch (e) {
            if (e instanceof ArchiveRefusal) throw new HttpRefusal(e.status, e.message);
            throw e;
          }
        }),
      );

    // a text file on a task, for the agent: on the task alone, as the agent's own, so the agent can
    // bundle it with its own files later; with the same names, types and limits as attach_files
    api.post(
      "/api/service/agents/:handle/files",
      handled(async (c) => {
        const s = me(c);
        const a = this.agentFor(s, c.req.param("handle"));
        const b = await body(c);
        const t = svc.task(String(b.task ?? ""));
        if (!t || !this.chatIds(s.id).has(t.chatId)) throw new HttpRefusal(404, "no such task");
        if (!svc.isMember(t.chatId, "agent", a.id)) throw new HttpRefusal(409, `@${a.handle} isn't in that task's chat`);
        if (typeof b.text !== "string") throw new HttpRefusal(400, "text is missing: the file's text, as a string");
        let stored;
        try {
          stored = attachTaskText({ db, svc, dataDir: this.app.cfg.dataDir }, { chatId: t.chatId, taskId: t.id, agentId: a.id, name: b.name, text: b.text, markdown: b.markdown === true });
        } catch (e) {
          if (e instanceof FileRefusal) throw new HttpRefusal(400, e.message);
          throw e;
        }
        const ids = stored.map((f) => f.id);
        const rows = ids.map((fid) => db.prepare("SELECT * FROM files WHERE id = ?").get(fid));
        return c.json({ files: rows.map(fileJson) });
      }),
    );

    // a line in the agent's Watch view
    api.post(
      "/api/service/agents/:handle/activity",
      handled(async (c) => {
        const s = me(c);
        const a = this.agentFor(s, c.req.param("handle"));
        const b = await body(c);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpRefusal(400, "text is missing");
        const chatId = b.chatId ? this.chatFor(s, String(b.chatId)).id : "";
        this.app.runtime.worker(a.id).note(`${s.name}: ${text}`, chatId);
        return c.json({ ok: true });
      }),
    );
  }

  // ---------------------------------------------------------------- the service's socket
  /** Handles an upgrade to /ws/service. Returns false for any other path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!req.url?.startsWith("/ws/service")) return false;
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const r = serviceRequest(this.app.db, header, req.socket.remoteAddress);
    if ("error" in r) {
      socket.destroy();
      return true;
    }
    const tokenNow = String(header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, r.service, tokenNow));
    return true;
  }
  private attach(ws: WebSocket, s: ServiceAccount, tok: string): void {
    const send = (e: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e));
    const onRequest = (sid: string, request: unknown) => sid === s.id && send({ type: "service_request", request });
    this.requests.on("request", onRequest);
    const off = this.app.bus.onEvent((e) => {
      if (!EVENT_TYPES.has(e.type)) return;
      const ids = this.chatIds(s.id);
      const sees = (cid: string) => ids.has(cid);
      if (e.type === "agent_status" || e.type === "agent_activity") {
        if (!drivenAgents(this.app.db, s.id).some((a) => a.id === e.agentId)) return;
        if (e.type === "agent_status") return void send({ ...e, status: statusSeenBy(e.status, sees) });
      }
      if (eventVisible(e, { userId: "", isAdmin: false, seesChat: sees })) send(e);
    });
    // a token that is replaced or revoked closes the socket within a minute
    const check = setInterval(() => {
      if (!serviceForToken(this.app.db, tok)) ws.close(4001, "the service's token no longer works");
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    check.unref?.();
    ws.on("close", () => {
      off();
      this.requests.off("request", onRequest);
      clearInterval(check);
    });
    send({ type: "hello", service: s.name });
  }
}
