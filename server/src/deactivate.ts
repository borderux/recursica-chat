// SPDX-License-Identifier: AGPL-3.0-only
// Deactivated people: an admin can turn a person's account off, and on again. A person who took
// part is never deleted, so their messages keep their author: root deletes only a deactivated
// account with no work at all, from the CLI (deleteperson.ts).
//
// - Deactivating ends every session of the person at once, and closes their live connections.
// - A deactivated person can't sign in by any way: a password, Google, the hosted control plane's
//   one-time link, or a session from the server's CLI. A session that somehow still exists lets them
//   in nowhere either: the session check refuses it too.
// - Their messages, tasks and memories stay, attributed to them. The people list shows them as
//   deactivated.
// - Nobody can deactivate the owner, and an admin can't deactivate themselves.
import type { Hono } from "hono";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import type { Bus } from "./bus.ts";

export const DEACTIVATED = "This account is deactivated. Ask an admin to reactivate it.";

const ready = new WeakSet<object>();
export function deactivationTables(db: DB): void {
  if (ready.has(db)) return;
  db.exec(
    `CREATE TABLE IF NOT EXISTS deactivated_users (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, by_id TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);`,
  );
  ready.add(db);
}

export function isDeactivated(db: DB, userId: string): boolean {
  deactivationTables(db);
  return !!db.prepare("SELECT 1 FROM deactivated_users WHERE user_id = ?").get(userId);
}

export function deactivatedIds(db: DB): Set<string> {
  deactivationTables(db);
  return new Set((db.prepare("SELECT user_id FROM deactivated_users").all() as any[]).map((r) => r.user_id));
}

/** Turns the account off: ends every session, and tells live connections to close. Returns the sessions ended. */
export function deactivate(db: DB, bus: Bus, userId: string, byId: string): number {
  deactivationTables(db);
  db.prepare("INSERT OR IGNORE INTO deactivated_users(user_id, by_id, at) VALUES(?,?,?)").run(userId, byId, now());
  const ended = Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
  bus.emitEvent({ type: "person", userId, deactivated: true });
  return ended;
}

export function reactivate(db: DB, bus: Bus, userId: string): void {
  deactivationTables(db);
  db.prepare("DELETE FROM deactivated_users WHERE user_id = ?").run(userId);
  bus.emitEvent({ type: "person", userId, deactivated: false });
}

/** The routes, for admins. Register them after the session check. */
export function registerDeactivation(api: Hono<any>, db: DB, bus: Bus, requireAdmin: (u: any) => void, error: (status: number, msg: string) => Error): void {
  deactivationTables(db);
  const target = (c: any) => {
    const me = c.get("user");
    requireAdmin(me);
    const t = db.prepare("SELECT id, role FROM users WHERE id = ?").get(c.req.param("id")) as any;
    if (!t) throw error(404, "no such person");
    return { me, t };
  };
  api.post("/api/users/:id/deactivate", (c) => {
    const { me, t } = target(c);
    if (t.role === "owner") throw error(403, "The owner can't be deactivated.");
    if (t.id === me.id) throw error(400, "You can't deactivate yourself. Ask another admin.");
    const ended = deactivate(db, bus, t.id, me.id);
    return c.json({ ok: true, sessionsEnded: ended });
  });
  api.post("/api/users/:id/reactivate", (c) => {
    const { t } = target(c);
    reactivate(db, bus, t.id);
    return c.json({ ok: true });
  });
}
