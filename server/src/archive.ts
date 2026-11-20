// SPDX-License-Identifier: AGPL-3.0-only
// Archive: tasks, plans and chats a person puts away. An archived item leaves every list (chats, tasks,
// search, an agent's and a service's view of a chat's tasks) but stays in the database, and so in
// backups and in the workspace export. It shows under the Archived filter, and it can be restored.
// Nothing here deletes anything.
//
// - A task: archived on its own. A plan: every task of the plan, at once. A chat: the chat, and with
//   it the tasks in it, which leave the task lists too while the chat is archived.
// - A direct chat with an agent can't be archived: it is the one place to talk to that agent, and it
//   opens again whenever someone writes to the agent.
// - Who: an admin, or a person in the item's chat. A service archives the tasks of the agents it
//   drives (drivenagents.ts).
// - An archived chat is read-only for people until it is restored.
//
// The cancelled task status lives here too: a task that won't be done, beside done.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import { now } from "./db.ts";

export const TASK_STATUSES: readonly string[] = ["todo", "working", "needs_you", "checking", "done", "cancelled"];

export type ArchiveKind = "task" | "plan" | "chat";

/** An archive request refused: the status to answer with, and why. */
export class ArchiveRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** The chat an item is in: a task's or a plan's chat, or the chat itself. Throws 404 for an unknown item. */
export function chatOf(app: App, kind: ArchiveKind, id: string): string {
  const { svc, db } = app;
  if (kind === "chat") {
    const c = svc.chat(id);
    if (!c) throw new ArchiveRefusal(404, "no such chat");
    return c.id;
  }
  const r = (
    kind === "task"
      ? db.prepare("SELECT chat_id FROM tasks WHERE id = ?").get(id)
      : db.prepare("SELECT chat_id FROM tasks WHERE plan_id = ? AND plan_id != '' LIMIT 1").get(id)
  ) as any;
  if (!r) throw new ArchiveRefusal(404, `no such ${kind}`);
  return r.chat_id;
}

/**
 * Archives an item, or restores it. `by` says who, for the record: a person's id, or "service:<id>".
 * Returns how many rows changed; an item already in that state changes nothing.
 */
export function setArchived(app: App, kind: ArchiveKind, id: string, archive: boolean, by: string): number {
  const { svc, db } = app;
  const at = archive ? now() : null;
  const who = archive ? by : "";
  if (kind === "chat") {
    const c = svc.chat(id);
    if (!c) throw new ArchiveRefusal(404, "no such chat");
    if (c.kind === "dm") throw new ArchiveRefusal(409, "a direct chat with an agent can't be archived: it opens again whenever someone writes to the agent");
    const n = Number(
      db.prepare(`UPDATE chats SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS ${archive ? "" : "NOT "}NULL`).run(at, who, id).changes,
    );
    if (n) svc.bus.emitEvent({ type: "chat", chat: svc.chat(id) });
    return n;
  }
  const ids = (
    kind === "task" ? db.prepare("SELECT id FROM tasks WHERE id = ?").all(id) : db.prepare("SELECT id FROM tasks WHERE plan_id = ? AND plan_id != ''").all(id)
  ) as any[];
  if (!ids.length) throw new ArchiveRefusal(404, `no such ${kind}`);
  let n = 0;
  const plans = new Set<string>();
  for (const { id: tid } of ids) {
    if (
      !Number(
        db.prepare(`UPDATE tasks SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS ${archive ? "" : "NOT "}NULL`).run(at, who, tid).changes,
      )
    )
      continue;
    n++;
    const task = svc.task(tid);
    svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
    if (task.planId) plans.add(task.planId);
  }
  for (const p of plans) svc.refreshPlanCard(p);
  return n;
}

/**
 * The people's routes: archive and restore a task, a plan or a chat, and the Archived list. An admin
 * may archive anything; anyone else, items in the chats they are in.
 */
export function registerArchive(api: Hono<any>, app: App, isAdmin: (u: any) => boolean): void {
  const { svc } = app;
  const may = (u: any, chatId: string) => isAdmin(u) || svc.isMember(chatId, "user", u.id);
  const handled = (fn: (c: any) => any) => async (c: any) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof ArchiveRefusal) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  for (const kind of ["task", "plan", "chat"] as const)
    for (const action of ["archive", "restore"] as const)
      api.post(
        `/api/${kind}s/:id/${action}`,
        handled((c) => {
          const u = c.get("user");
          const id = c.req.param("id");
          const chatId = chatOf(app, kind, id);
          if (!may(u, chatId)) throw new ArchiveRefusal(403, `only an admin or a person in its chat may ${action} this ${kind}`);
          const changed = setArchived(app, kind, id, action === "archive", u.id);
          return c.json({ ok: true, changed });
        }),
      );
  // the Archived filter: archived chats, and archived tasks in chats the person can see (an admin: all)
  api.get("/api/archived", (c) => {
    const u = c.get("user");
    const chats = isAdmin(u)
      ? (app.db.prepare("SELECT id FROM chats WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").all() as any[]).map((r) => svc.chat(r.id))
      : svc.chatsForUser(u.id, "archived");
    const sees = isAdmin(u)
      ? () => true
      : (
          (ids: Set<string>) => (cid: string) =>
            ids.has(cid)
        )(new Set(svc.chatsForUser(u.id, "all").map((x: any) => x.id)));
    const tasks = svc.tasks(undefined, "archived").filter((t) => sees(t.chatId));
    return c.json({ chats, tasks });
  });
}
