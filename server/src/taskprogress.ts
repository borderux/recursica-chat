// SPDX-License-Identifier: AGPL-3.0-only
// A task's progress line: a short line, such as "Step 17 of 43", that a program driving an agent sets
// while the task runs (PATCH /api/service/tasks/:id with "progress"). The task and the plan card show
// the line in place, so progress never needs a chat message. An empty line clears it. The line lives
// in a table of its own, not in upstream's tasks table.
import type { DB } from "./db.ts";

export const MAX_PROGRESS = 80;

const ready = new WeakSet<object>();
function progressTable(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS task_progress (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, progress TEXT NOT NULL);`);
  ready.add(db);
}

/** The task's progress line, or "" when it has none. */
export function progressOf(db: DB, taskId: string): string {
  progressTable(db);
  return ((db.prepare("SELECT progress FROM task_progress WHERE task_id = ?").get(taskId) as any)?.progress as string) ?? "";
}

/** Checks a progress line: one line of at most MAX_PROGRESS characters, trimmed. Throws with the reason. */
export function parseProgress(v: unknown): string {
  if (typeof v !== "string") throw new Error("progress must be text");
  const p = v.trim();
  if (/[\r\n]/.test(p)) throw new Error("progress must be one line");
  if (p.length > MAX_PROGRESS) throw new Error(`progress is ${p.length} characters, over ${MAX_PROGRESS}`);
  return p;
}

/** Sets the task's progress line; "" clears it. Returns whether it changed. */
export function writeProgress(db: DB, taskId: string, progress: string): boolean {
  if (progressOf(db, taskId) === progress) return false;
  if (progress) db.prepare("INSERT INTO task_progress(task_id, progress) VALUES(?, ?) ON CONFLICT(task_id) DO UPDATE SET progress = excluded.progress").run(taskId, progress);
  else db.prepare("DELETE FROM task_progress WHERE task_id = ?").run(taskId);
  return true;
}
