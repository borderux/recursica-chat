// SPDX-License-Identifier: AGPL-3.0-only
// Deleting a person's account, from the server's CLI, as root only:
//
//   sudo node server/src/cli.ts delete-person <email>
//
// For an account that never took part, such as one made for a program before service accounts.
// Everyone else is deactivated instead (deactivate.ts), so their work keeps its author. So the
// command refuses:
// - the owner and admins;
// - an account that isn't deactivated: deactivate it in the app first;
// - an account that wrote any message, made or holds any task, attached any file, decided any
//   approval, wrote any memory, or owns any connection: its work would point at nobody.
//
// Otherwise it removes, in one transaction, the account with its sessions, username, look, photo and
// deactivated record, and its chat memberships and read marks, and prints what it removed. Records
// that only name it as who did something to someone else (who made a chat or an agent, who
// deactivated someone) keep the id, as history.
import type { DB } from "./db.ts";
import { deactivationTables } from "./deactivate.ts";
import { profileTables } from "./profile.ts";
import { fileTables } from "./files.ts";

export class DeleteRefusal extends Error {}

/** Deletes the account, or throws DeleteRefusal saying why not. Returns the lines to print. */
export function deletePerson(db: DB, rawEmail: string): string[] {
  deactivationTables(db);
  profileTables(db);
  fileTables(db);
  const email = String(rawEmail ?? "")
    .trim()
    .toLowerCase();
  if (!email) throw new DeleteRefusal("usage: cli.ts delete-person <email>");
  const u = db.prepare("SELECT id, email, role FROM users WHERE email = ?").get(email) as { id: string; email: string; role: string } | undefined;
  if (!u) throw new DeleteRefusal(`no account for ${email}`);
  if (u.role === "owner" || u.role === "admin") throw new DeleteRefusal(`${email} is ${u.role === "owner" ? "the owner" : "an admin"}: refused`);
  if (!db.prepare("SELECT 1 FROM deactivated_users WHERE user_id = ?").get(u.id))
    throw new DeleteRefusal(`${email} isn't deactivated: deactivate the account first`);

  const count = (sql: string) => Number((db.prepare(sql).get(u.id) as any).n);
  const work: [string, number][] = [
    ["messages", count("SELECT COUNT(*) AS n FROM messages WHERE author_type = 'user' AND author_id = ?")],
    ["tasks", count("SELECT COUNT(*) AS n FROM tasks WHERE created_by = ?1 OR (assignee_type = 'user' AND assignee_id = ?1)")],
    ["files", count("SELECT COUNT(*) AS n FROM files f JOIN messages m ON m.id = f.message_id WHERE m.author_type = 'user' AND m.author_id = ?")],
    ["approvals", count("SELECT COUNT(*) AS n FROM approvals WHERE decided_by = ?")],
    ["memories", count("SELECT COUNT(*) AS n FROM memories WHERE by_type = 'user' AND by_id = ?")],
    ["connections", count("SELECT COUNT(*) AS n FROM connections WHERE owner_user_id = ?")],
  ];
  const held = work.filter(([, n]) => n > 0);
  if (held.length)
    throw new DeleteRefusal(
      `${email} still has work: ${held.map(([what, n]) => `${n} ${what}`).join(", ")}. Refused: deactivated, the account keeps it attributed`,
    );

  const removed: string[] = [];
  const del = (what: string, sql: string) => {
    const n = Number(db.prepare(sql).run(u.id).changes);
    if (n) removed.push(`${what}${n > 1 ? ` (${n})` : ""}`);
  };
  db.exec("BEGIN");
  try {
    const handle = (db.prepare("SELECT handle FROM user_handles WHERE user_id = ?").get(u.id) as any)?.handle;
    del("sessions", "DELETE FROM sessions WHERE user_id = ?");
    del(handle ? `username @${handle}` : "username", "DELETE FROM user_handles WHERE user_id = ?");
    del("look", "DELETE FROM user_looks WHERE user_id = ?");
    del("photo", "DELETE FROM user_photos WHERE user_id = ?");
    del("deactivated record", "DELETE FROM deactivated_users WHERE user_id = ?");
    del("chat memberships", "DELETE FROM chat_members WHERE member_type = 'user' AND member_id = ?");
    del("read marks", "DELETE FROM chat_reads WHERE user_id = ?");
    del("account", "DELETE FROM users WHERE id = ?");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return [`Deleted ${email} (${u.id}): ${removed.join(", ")}.`];
}
