// SPDX-License-Identifier: AGPL-3.0-only
// Comments on a task: short plain-text notes, kept with the task, that people (and, through a
// service, the agent the task belongs to) leave on it.
//
// - Storage: one table of its own, never upstream's: task_comments, one row per comment. There are no
//   edits. A delete is soft: the row stays, its body is cleared, and it shows as "Comment deleted".
// - The body is plain text, 1 to 4000 characters after trimming. The web app renders it the way it
//   renders a chat message, with no HTML.
// - Who: anyone who can see the task's chat, by the same rule as GET /api/tasks (chatsForUser), reads
//   and posts. A task that is archived, or in a chat the person can't see, is 404. A finished task
//   (done, cancelled) still takes comments. The author, or an admin (admin or owner), deletes one.
// - The task JSON gains `commentCount` (services.ts task()): its comments that aren't deleted.
// - Events: `task_comment` { chatId, taskId, comment } for a new or deleted comment, then the `task`
//   event, so commentCount changes live. Both go to sockets by the task's chat, like every `task` event
//   (eventfilter.ts).
// - A comment never wakes an agent and never posts a chat message: nothing here delivers anything.
// - People's routes: GET and POST /api/tasks/:id/comments, DELETE /api/tasks/:id/comments/:cid.
//   Service routes, for a task in a chat the service drives (drivenagents.ts): GET and POST
//   /api/service/tasks/:id/comments; a service posts as the driven agent the task belongs to.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { id } from "./crypto.ts";
import { drivenAgents, type ServiceAccount } from "./serviceaccounts.ts";

export const MAX_COMMENT = 4000;

export interface TaskComment {
  id: string;
  taskId: string;
  author: { type: "user" | "agent"; id: string; name: string };
  body: string;
  createdAt: number;
  deleted: boolean;
}

const ready = new WeakSet<object>();
function table(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('user','agent')),
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, created_at);`);
  ready.add(db);
}

/** A request about comments that can't be done: the status to answer with, and why. */
export class CommentRefusal extends Error {
  readonly status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/** A comment's body from a request: trimmed, 1 to MAX_COMMENT characters. Throws a 400. */
export function parseCommentBody(raw: unknown): string {
  if (typeof raw !== "string") throw new CommentRefusal(400, "body is missing: the comment's text, as a string");
  const body = raw.trim();
  if (!body) throw new CommentRefusal(400, "the comment is empty");
  if (body.length > MAX_COMMENT) throw new CommentRefusal(400, `the comment is ${body.length} characters, over ${MAX_COMMENT}`);
  return body;
}

function authorName(db: DB, type: string, aid: string): string {
  const r = (type === "agent" ? db.prepare("SELECT name FROM agents WHERE id = ?") : db.prepare("SELECT name FROM users WHERE id = ?")).get(aid) as any;
  return typeof r?.name === "string" ? r.name : "";
}

function toJson(db: DB, r: any): TaskComment {
  const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
  return {
    id: r.id,
    taskId: r.task_id,
    author: { type: r.author_type, id: r.author_id, name: authorName(db, r.author_type, r.author_id) },
    body: deleted ? "" : r.body,
    createdAt: r.created_at,
    deleted,
  };
}

/** A task's comments, oldest first, deleted ones included (with no body). */
export function commentsOf(db: DB, taskId: string): TaskComment[] {
  table(db);
  return (db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as any[]).map((r) => toJson(db, r));
}

/** How many of a task's comments aren't deleted: the task JSON's commentCount. */
export function commentCountOf(db: DB, taskId: string): number {
  table(db);
  return (db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND deleted_at IS NULL").get(taskId) as any).n;
}

function announce(app: App, taskId: string, commentId: string): TaskComment {
  const comment = toJson(app.db, app.db.prepare("SELECT * FROM task_comments WHERE id = ?").get(commentId));
  const task = app.svc.task(taskId);
  app.svc.bus.emitEvent({ type: "task_comment", chatId: task.chatId, taskId, comment });
  app.svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
  return comment;
}

/**
 * Adds a comment to a task, as a person or an agent. The caller has checked who may. Sends the
 * task_comment and task events, and nothing else: no message, no delivery.
 */
export function addComment(app: App, taskId: string, author: { type: "user" | "agent"; id: string }, raw: unknown, at = now()): TaskComment {
  table(app.db);
  const body = parseCommentBody(raw);
  if (!app.svc.task(taskId)) throw new CommentRefusal(404, "no such task");
  const cid = id("tcm_");
  app.db.prepare("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES(?,?,?,?,?,?)").run(cid, taskId, author.type, author.id, body, at);
  return announce(app, taskId, cid);
}

/**
 * Deletes a comment on a task: the author or an admin. The body is cleared in the table. A comment
 * already deleted stays as it is, with no event. The caller has checked the person sees the task.
 */
export function deleteComment(app: App, taskId: string, commentId: string, by: { id: string; admin: boolean }, at = now()): void {
  table(app.db);
  const r = app.db.prepare("SELECT * FROM task_comments WHERE id = ? AND task_id = ?").get(commentId, taskId) as any;
  if (!r) throw new CommentRefusal(404, "no such comment");
  if (!(r.author_type === "user" && r.author_id === by.id) && !by.admin) throw new CommentRefusal(403, "Only the comment's author or an admin can delete it");
  if (r.deleted_at !== null) return;
  app.db.prepare("UPDATE task_comments SET body = '', deleted_at = ?, deleted_by = ? WHERE id = ?").run(at, by.id, commentId);
  announce(app, taskId, commentId);
}

const answer = async (c: any, f: () => unknown) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof CommentRefusal) return c.json({ error: e.message }, e.status);
    throw e;
  }
};
const jsonBody = async (c: any): Promise<any> => {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
};
const bodyOf = (b: any) => (b && typeof b === "object" ? b.body : undefined);

/**
 * GET and POST /api/tasks/:id/comments and DELETE /api/tasks/:id/comments/:cid, behind the session
 * check. Seeing a task is GET /api/tasks's rule: its chat is one of chatsForUser (open chats the person
 * is in, and agents-only chats), and neither the task nor its chat is archived.
 */
export function registerTaskComments(api: Hono<any>, app: App, can: { isAdmin: (u: any) => boolean }): void {
  const { db, svc } = app;
  const visibleTask = (u: { id: string }, tid: string) => {
    const t = svc.task(tid);
    if (!t || t.archivedAt || !svc.chatsForUser(u.id).some((x: any) => x.id === t.chatId)) throw new CommentRefusal(404, "no such task");
    return t;
  };
  api.get("/api/tasks/:id/comments", (c) =>
    answer(c, () => {
      const t = visibleTask(c.get("user"), c.req.param("id"));
      return c.json({ comments: commentsOf(db, t.id) });
    }),
  );
  api.post("/api/tasks/:id/comments", async (c) => {
    const b = await jsonBody(c);
    return answer(c, () => {
      const u = c.get("user");
      const t = visibleTask(u, c.req.param("id"));
      return c.json({ comment: addComment(app, t.id, { type: "user", id: u.id }, bodyOf(b)) }, 201);
    });
  });
  api.delete("/api/tasks/:id/comments/:cid", (c) =>
    answer(c, () => {
      const u = c.get("user");
      const t = visibleTask(u, c.req.param("id"));
      deleteComment(app, t.id, c.req.param("cid"), { id: u.id, admin: can.isAdmin(u) });
      return c.body(null, 204);
    }),
  );
}

/**
 * GET and POST /api/service/tasks/:id/comments, for a task in a chat the service drives (chatIds: the
 * chats its agents are in, drivenagents.ts). An archived task is 404, as for people. A comment from a
 * service is the driven agent's the task belongs to: the agent it's assigned to, or else the one that
 * created it. A task that is no driven agent's is 403.
 */
export function registerServiceTaskComments(api: Hono<any>, app: App, chatIds: (serviceId: string) => Set<string>): void {
  const { db, svc } = app;
  const me = (c: any) => c.get("service") as ServiceAccount;
  const serviceTask = (s: ServiceAccount, tid: string) => {
    const t = svc.task(tid);
    if (!t || t.archivedAt || !chatIds(s.id).has(t.chatId)) throw new CommentRefusal(404, "no such task");
    return t;
  };
  api.get("/api/service/tasks/:id/comments", (c) =>
    answer(c, () => {
      const t = serviceTask(me(c), c.req.param("id"));
      return c.json({ comments: commentsOf(db, t.id) });
    }),
  );
  api.post("/api/service/tasks/:id/comments", async (c) => {
    const b = await jsonBody(c);
    return answer(c, () => {
      const s = me(c);
      const t = serviceTask(s, c.req.param("id"));
      const driven = drivenAgents(db, s.id);
      const a = (t.assigneeType === "agent" && driven.find((x) => x.id === t.assigneeId)) || driven.find((x) => x.id === t.createdBy);
      if (!a) throw new CommentRefusal(403, `${s.name} may comment only on the tasks of the agents it drives`);
      return c.json({ comment: addComment(app, t.id, { type: "agent", id: a.id }, bodyOf(b)) }, 201);
    });
  });
}
