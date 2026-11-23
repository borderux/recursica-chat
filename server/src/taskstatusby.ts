// SPDX-License-Identifier: AGPL-3.0-only
// Who last set a task's status, when a person set it. A program that drives an agent reads it to tell
// a task a person cancelled from one its agent or the program itself moved.
//
// - Storage: one table of its own, never upstream's: task_status_by, one row per task, the latest
//   status a person set on it and who. Each new change by a person replaces the row.
// - Written only when a person changes a task's status through PATCH /api/tasks/:id, after the route
//   answers 200 and only when the status changed. Agents' tools and the service route
//   (/api/service/tasks/:id) never write it. Another people's route that sets a status (such as a
//   reopen) calls recordStatusBy itself.
// - The task JSON gains `statusBy` (services.ts task()): null, or { type: "user", id, name, at }. It is
//   set only while the task's status is still the one the person set: once an agent or a service
//   moves the task to another status, it is null. Also null when the person's account is gone.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";

export interface StatusBy {
  type: "user";
  id: string;
  name: string;
  at: number;
}

const ready = new WeakSet<object>();
function table(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS task_status_by (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    by_type TEXT NOT NULL,
    by_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );`);
  ready.add(db);
}

/** Records that a person set this status on the task, replacing any earlier row. */
export function recordStatusBy(db: DB, taskId: string, status: string, userId: string, at = now()): void {
  table(db);
  db.prepare(
    "INSERT INTO task_status_by(task_id, status, by_type, by_id, at) VALUES(?,?,'user',?,?) " +
      "ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, by_type = excluded.by_type, by_id = excluded.by_id, at = excluded.at",
  ).run(taskId, status, userId, at);
}

/** Who set the task's current status, or null: no person set it, or someone else has changed it since. */
export function statusByOf(db: DB, row: { id: string; status: string }): StatusBy | null {
  table(db);
  const r = db
    .prepare("SELECT s.status, s.by_id, s.at, u.name FROM task_status_by s LEFT JOIN users u ON u.id = s.by_id WHERE s.task_id = ? AND s.by_type = 'user'")
    .get(row.id) as any;
  if (!r || r.status !== row.status || typeof r.name !== "string") return null;
  return { type: "user", id: r.by_id, name: r.name, at: r.at };
}

/**
 * Records a person's status change on PATCH /api/tasks/:id. Registered after the session check and
 * before the route in api.ts. It runs around the route and any check before it, and records only
 * after a 200, so a refused change records nothing. It then answers with the task as it now is and
 * sends the `task` event again, so both carry `statusBy`.
 */
export function registerTaskStatusBy(api: Hono<any>, app: App): void {
  const { db, svc } = app;
  api.use("/api/tasks/:id", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    const tid = c.req.param("id");
    const before = svc.task(tid)?.status as string | undefined;
    await next();
    if (before === undefined || c.res.status !== 200) return;
    let asked: unknown;
    try {
      asked = (await c.req.json())?.status;
    } catch {
      return;
    }
    const u = c.get("user");
    const t = svc.task(tid);
    if (!u?.id || !t || typeof asked !== "string" || t.status !== asked || t.status === before) return;
    recordStatusBy(db, t.id, t.status, u.id);
    const task = svc.task(t.id);
    c.res = new Response(JSON.stringify({ task }), { status: 200, headers: { "content-type": "application/json" } });
    svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
    if (task.planId) svc.refreshPlanCard(task.planId);
  });
}
