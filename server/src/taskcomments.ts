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
// - Agents' core tools (taskCommentTools, registered in app.ts as attach_files is): task_comments reads
//   a task's comments and task_comment posts one as the agent, for a task in a chat the agent is in.
//
// Questions: a comment with 2 to 6 choices, which people answer with one click.
// - Storage: three nullable columns on task_comments, added in place to an older table: choices (JSON
//   [{ value, label }]) on a question; answer_to (the question's id) and choice (the chosen value) on an
//   answer. A unique index on answer_to keeps it to one answer per question.
// - A service asks one for the agent it drives: POST /api/service/tasks/:id/comments { body, choices }.
//   Agents' own tools don't ask questions.
// - A person who sees the task answers: POST /api/tasks/:id/comments/:cid/answer { choice }. The answer
//   is a comment from that person, its body the choice's label. It sends task_comment for the answer,
//   then for the question (now with its answer), then task. It doesn't change the task's status and
//   wakes no one: the service reads the answer with its comments route.
// - An answer is deleted like any comment, and the question stays answered. A deleted question loses
//   its choices with its body, and can't be answered.
// - The task JSON gains openQuestions (services.ts task()): its questions that aren't answered or deleted.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { id } from "./crypto.ts";
import { drivenAgents, type ServiceAccount } from "./serviceaccounts.ts";
import { personHandle } from "./profile.ts";
import type { CallContext, ToolDef } from "./gateway.ts";

export const MAX_COMMENT = 4000;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;
export const MAX_CHOICE_LABEL = 80;
const CHOICE_VALUE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Choice {
  value: string;
  label: string;
}
type Author = { type: "user" | "agent"; id: string; name: string };

export interface TaskComment {
  id: string;
  taskId: string;
  author: Author;
  body: string;
  createdAt: number;
  deleted: boolean;
  /** A question's choices; null on any other comment, and on a deleted question. */
  choices: Choice[] | null;
  /** On an answer: the question's id, and the value chosen. */
  answerTo: string | null;
  choice: string | null;
  /** On a question: its answer once there is one, else null. Always null on other comments. */
  answer: { by: Author; choice: string; at: number } | null;
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
  // questions and answers: added in place to a table made before them
  const cols = (db.prepare("SELECT name FROM pragma_table_info('task_comments')").all() as any[]).map((c) => c.name);
  for (const col of ["choices", "answer_to", "choice"]) if (!cols.includes(col)) db.exec(`ALTER TABLE task_comments ADD COLUMN ${col} TEXT`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_comments_answer ON task_comments(answer_to) WHERE answer_to IS NOT NULL");
  ready.add(db);
}

/** A request about comments that can't be done: the status to answer with, and why. */
export class CommentRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
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

/**
 * A question's choices from a request: 2 to 6 of { value, label }. A value is 1 to 40 of a-z, 0-9 and
 * "-", starting with a letter or digit, and unique in the question; a label is 1 to 80 characters after
 * trimming. Throws a 400 that says what's wrong.
 */
export function parseChoices(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) throw new CommentRefusal(400, "choices must be a list of { value, label }");
  if (raw.length < MIN_CHOICES || raw.length > MAX_CHOICES) throw new CommentRefusal(400, `a question has ${MIN_CHOICES} to ${MAX_CHOICES} choices, not ${raw.length}`);
  const out: Choice[] = [];
  raw.forEach((c: any, i) => {
    const n = i + 1;
    if (!c || typeof c !== "object") throw new CommentRefusal(400, `choice ${n} must be an object with a value and a label`);
    if (typeof c.value !== "string" || !CHOICE_VALUE.test(c.value)) throw new CommentRefusal(400, `choice ${n}'s value must be 1 to 40 of a-z, 0-9 and "-", starting with a letter or digit`);
    if (out.some((x) => x.value === c.value)) throw new CommentRefusal(400, `choice ${n}'s value, ${c.value}, is used twice`);
    const label = typeof c.label === "string" ? c.label.trim() : "";
    if (!label) throw new CommentRefusal(400, `choice ${n}'s label is empty`);
    if (label.length > MAX_CHOICE_LABEL) throw new CommentRefusal(400, `choice ${n}'s label is ${label.length} characters, over ${MAX_CHOICE_LABEL}`);
    out.push({ value: c.value, label });
  });
  return out;
}

function storedChoices(raw: unknown): Choice[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function authorName(db: DB, type: string, aid: string): string {
  const r = (type === "agent" ? db.prepare("SELECT name FROM agents WHERE id = ?") : db.prepare("SELECT name FROM users WHERE id = ?")).get(aid) as any;
  return typeof r?.name === "string" ? r.name : "";
}

const authorOf = (db: DB, type: string, aid: string): Author => ({ type: type as Author["type"], id: aid, name: authorName(db, type, aid) });

/** A comment row as JSON. `answerRow` is a question's answer row, if it has one (deleted or not). */
function toJson(db: DB, r: any, answerRow?: any): TaskComment {
  const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
  const choices = deleted ? null : storedChoices(r.choices);
  return {
    id: r.id,
    taskId: r.task_id,
    author: authorOf(db, r.author_type, r.author_id),
    body: deleted ? "" : r.body,
    createdAt: r.created_at,
    deleted,
    choices,
    answerTo: r.answer_to ?? null,
    choice: r.choice ?? null,
    answer: choices && answerRow ? { by: authorOf(db, answerRow.author_type, answerRow.author_id), choice: answerRow.choice, at: answerRow.created_at } : null,
  };
}

const answerRowOf = (db: DB, questionId: string) => db.prepare("SELECT * FROM task_comments WHERE answer_to = ?").get(questionId) as any;

/** One comment as JSON, with its answer if it's a question. */
function commentById(db: DB, commentId: string): TaskComment {
  const r = db.prepare("SELECT * FROM task_comments WHERE id = ?").get(commentId) as any;
  return toJson(db, r, r.choices ? answerRowOf(db, r.id) : undefined);
}

/** A task's comments, oldest first, deleted ones included (with no body); a question with its answer. */
export function commentsOf(db: DB, taskId: string): TaskComment[] {
  table(db);
  const rows = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as any[];
  const answers = new Map(rows.filter((r) => r.answer_to).map((r) => [r.answer_to, r]));
  return rows.map((r) => toJson(db, r, answers.get(r.id)));
}

/** How many of a task's questions wait for an answer, not deleted: the task JSON's openQuestions. */
export function openQuestionsOf(db: DB, taskId: string): number {
  table(db);
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_comments q WHERE q.task_id = ? AND q.choices IS NOT NULL AND q.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM task_comments a WHERE a.answer_to = q.id)",
      )
      .get(taskId) as any
  ).n;
}

/** How many of a task's comments aren't deleted: the task JSON's commentCount. */
export function commentCountOf(db: DB, taskId: string): number {
  table(db);
  return (db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND deleted_at IS NULL").get(taskId) as any).n;
}

/** Sends task_comment for each comment, in order, then task; returns the first comment. */
function announce(app: App, taskId: string, ...commentIds: string[]): TaskComment {
  const task = app.svc.task(taskId);
  const comments = commentIds.map((cid) => commentById(app.db, cid));
  for (const comment of comments) app.svc.bus.emitEvent({ type: "task_comment", chatId: task.chatId, taskId, comment });
  app.svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
  return comments[0];
}

/**
 * Adds a comment to a task, as a person or an agent; with choices, a question. The caller has checked
 * who may. Sends the task_comment and task events, and nothing else: no message, no delivery.
 */
export function addComment(app: App, taskId: string, author: { type: "user" | "agent"; id: string }, raw: unknown, at = now(), rawChoices?: unknown): TaskComment {
  table(app.db);
  const body = parseCommentBody(raw);
  const choices = rawChoices === undefined ? null : parseChoices(rawChoices);
  if (!app.svc.task(taskId)) throw new CommentRefusal(404, "no such task");
  const cid = id("tcm_");
  app.db
    .prepare("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, choices) VALUES(?,?,?,?,?,?,?)")
    .run(cid, taskId, author.type, author.id, body, at, choices ? JSON.stringify(choices) : null);
  return announce(app, taskId, cid);
}

/**
 * Answers a question on a task, as a person: once. The answer is a comment from the person, its body
 * the choice's label. The caller has checked the person sees the task. Sends task_comment for the
 * answer and for the question, then task. Changes nothing else: not the task's status, and no agent wakes.
 */
export function answerQuestion(app: App, taskId: string, questionId: string, userId: string, rawChoice: unknown, at = now()): TaskComment {
  table(app.db);
  const db = app.db;
  const q = db.prepare("SELECT * FROM task_comments WHERE id = ? AND task_id = ?").get(questionId, taskId) as any;
  if (!q) throw new CommentRefusal(404, "no such comment");
  // a delete clears a question's choices, so this comes first
  if (q.deleted_at !== null) throw new CommentRefusal(400, "That comment was deleted");
  const choices = storedChoices(q.choices);
  if (!choices) throw new CommentRefusal(400, "That comment isn't a question");
  const prior = answerRowOf(db, questionId);
  if (prior) throw new CommentRefusal(409, `This question was answered already by ${authorName(db, prior.author_type, prior.author_id) || "someone"}`);
  const picked = choices.find((c) => c.value === rawChoice);
  if (!picked) throw new CommentRefusal(400, `choice must be one of: ${choices.map((c) => c.value).join(", ")}`);
  const cid = id("tcm_");
  // the unique index on answer_to stands behind the check above
  db.prepare("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, answer_to, choice) VALUES(?,?,?,?,?,?,?,?)").run(
    cid,
    taskId,
    "user",
    userId,
    picked.label,
    at,
    questionId,
    picked.value,
  );
  return announce(app, taskId, cid, questionId);
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
  // a question's choices go with its body; an answer keeps answer_to and choice, so its question stays answered
  app.db.prepare("UPDATE task_comments SET body = '', choices = NULL, deleted_at = ?, deleted_by = ? WHERE id = ?").run(at, by.id, commentId);
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
const fieldOf = (b: any, k: string) => (b && typeof b === "object" ? b[k] : undefined);

/**
 * GET and POST /api/tasks/:id/comments, DELETE /api/tasks/:id/comments/:cid and POST
 * /api/tasks/:id/comments/:cid/answer { choice }, behind the session check. Seeing a task is GET
 * /api/tasks's rule: its chat is one of chatsForUser (open chats the person is in, and agents-only
 * chats), and neither the task nor its chat is archived.
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
  api.post("/api/tasks/:id/comments/:cid/answer", async (c) => {
    const b = await jsonBody(c);
    return answer(c, () => {
      const u = c.get("user");
      const t = visibleTask(u, c.req.param("id"));
      return c.json({ comment: answerQuestion(app, t.id, c.req.param("cid"), u.id, fieldOf(b, "choice")) }, 201);
    });
  });
}

/**
 * GET and POST /api/service/tasks/:id/comments, for a task in a chat the service drives (chatIds: the
 * chats its agents are in, drivenagents.ts). An archived task is 404, as for people. A comment from a
 * service is the driven agent's the task belongs to: the agent it's assigned to, or else the one that
 * created it. A task that is no driven agent's is 403. With `choices`, the comment is a question.
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
      const choices = fieldOf(b, "choices");
      return c.json({ comment: addComment(app, t.id, { type: "agent", id: a.id }, bodyOf(b), now(), choices === undefined || choices === null ? undefined : choices) }, 201);
    });
  });
}

// ---------------------------------------------------------------- agents' tools

/**
 * The task_comments and task_comment tools, core tools (gateway.ts addCoreTool): for a task in a chat
 * the calling agent is in, not archived. Anything else is a plain error. A comment the agent posts is
 * its own, with the people's limits, and wakes no one.
 */
export function taskCommentTools(app: App): ToolDef[] {
  const { db, svc } = app;
  const agentTask = (raw: unknown, ctx: CallContext) => {
    const tid = String(raw ?? "");
    const t = tid ? svc.task(tid) : undefined;
    if (!t || t.archivedAt || !svc.isMember(t.chatId, "agent", ctx.agent.id)) throw new Error(`there is no task ${tid || "(no id given)"} in a chat you are in`);
    return t;
  };
  // people appear to agents as @username, as in chat_history
  const who = (au: Author) => {
    if (au.type === "agent") return svc.agent(au.id)?.name ?? (au.name || "an agent");
    const h = personHandle(db, au.id);
    return h ? `@${h}` : au.name || "someone";
  };
  // a question shows its choices, and its answer once there is one; an answer, the value chosen
  const text = (c: TaskComment) => {
    if (c.deleted) return "(comment deleted)";
    if (c.choices) {
      const asked = `${c.body} [question: choices ${c.choices.map((x) => `${x.value} (${x.label})`).join(", ")}]`;
      if (!c.answer) return `${asked} (not answered yet)`;
      const label = c.choices.find((x) => x.value === c.answer!.choice)?.label ?? c.answer.choice;
      return `${asked} answered by ${who(c.answer.by)}: ${label}`;
    }
    return c.answerTo ? `${c.body} [answer: ${c.choice}]` : c.body;
  };
  return [
    {
      name: "task_comments",
      category: "core",
      description: "Read a task's comments, oldest first: notes people and agents left on the task, and any question with its choices and the answer a person picked. For a task in a chat you are in.",
      inputSchema: { type: "object", properties: { task_id: { type: "string", description: "the task's id, such as t_…" } }, required: ["task_id"] },
      run: async (a: any, ctx: CallContext) => {
        const t = agentTask(a.task_id, ctx);
        const list = commentsOf(db, t.id);
        const lines = list.map((c) => `[${new Date(c.createdAt).toISOString()}] ${who(c.author)}: ${text(c)}`);
        return `Comments on "${t.title}" (${t.id}), oldest first:\n${lines.join("\n") || "(no comments)"}`;
      },
    },
    {
      name: "task_comment",
      category: "core",
      description: `Leave a comment on a task, as you: plain text, 1 to ${MAX_COMMENT} characters. It shows on the task, not in the chat, and wakes no one. For a task in a chat you are in.`,
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "the task's id, such as t_…" }, body: { type: "string", description: "the comment" } },
        required: ["task_id", "body"],
      },
      run: async (a: any, ctx: CallContext) => {
        const t = agentTask(a.task_id, ctx);
        const c = addComment(app, t.id, { type: "agent", id: ctx.agent.id }, a.body);
        return `Comment ${c.id} added to "${t.title}".`;
      },
    },
  ];
}
