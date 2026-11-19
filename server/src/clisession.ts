// SPDX-License-Identifier: AGPL-3.0-only
// A short session for a member account, made on the server by its operator. For a check that
// drives the app through its API (an agent check, say) on a server where password sign-in is off.
//
//   sudo node server/src/cli.ts session <email> [--minutes N]   prints only the session's token
//   sudo node server/src/cli.ts end-sessions <email>            signs that account out everywhere
//
// - Only root may run either: the token is a way in, so it takes the same power as reading the
//   database. The command then runs as the data folder's owner, so any file SQLite makes stays
//   the server's own.
// - Only for an account that isn't an owner or an admin: a check never needs to run the server.
// - The session lasts at most an hour (60 minutes, the default). Nothing renews it.
// - The token goes to stdout and nowhere else: not to the log, not to stderr, not to an argument.
//   It works as `Authorization: Bearer <token>`, or as the cc_session cookie.
import { statSync } from "node:fs";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { token } from "./crypto.ts";
import { isDeactivated } from "./deactivate.ts";

export const SESSION_MAX_MINUTES = 60;
const REFUSED_ROLES = new Set(["owner", "admin"]);

interface Proc {
  getuid?: () => number;
  setuid?: (id: number) => void;
  setgid?: (id: number) => void;
}

/** Refuses anyone but root; then becomes the data folder's owner. Returns why it refused, or null. */
export function asDataOwner(dataDir: string, proc: Proc = process): string | null {
  if (!proc.getuid || proc.getuid() !== 0) return "only root may run this: use sudo";
  let st;
  try {
    st = statSync(dataDir);
  } catch {
    return `no data folder at ${dataDir}`;
  }
  // a data folder root owns stays root's; any other owner is who the server runs as
  if (st.uid !== 0) {
    proc.setgid!(st.gid);
    proc.setuid!(st.uid);
  }
  return null;
}

/** Parses `<email> [--minutes N]`. Throws with a message for the person at the keyboard. */
export function sessionArgs(args: string[]): { email: string; minutes: number } {
  const [email, flag, value, ...rest] = args;
  if (!email || email.startsWith("-") || rest.length) throw new Error("usage: cli.ts session <email> [--minutes N]");
  let minutes = SESSION_MAX_MINUTES;
  if (flag !== undefined) {
    if (flag !== "--minutes" || value === undefined || !/^\d+$/.test(value)) throw new Error("usage: cli.ts session <email> [--minutes N]");
    minutes = Number(value);
    if (minutes < 1 || minutes > SESSION_MAX_MINUTES) throw new Error(`--minutes must be 1 to ${SESSION_MAX_MINUTES}`);
  }
  return { email: email.toLowerCase(), minutes };
}

function account(db: DB, email: string): { id: string; role: string } {
  const u = db.prepare("SELECT id, role FROM users WHERE email = ?").get(email.toLowerCase()) as { id: string; role: string } | undefined;
  if (!u) throw new Error(`no user ${email}`);
  if (REFUSED_ROLES.has(u.role)) throw new Error(`${email} is an ${u.role}: sessions from here are only for members and builders`);
  return u;
}

/** A new session for the account; returns its token and when it ends. */
export function memberSession(db: DB, email: string, minutes = SESSION_MAX_MINUTES): { token: string; expiresAt: number } {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > SESSION_MAX_MINUTES) throw new Error(`minutes must be 1 to ${SESSION_MAX_MINUTES}`);
  const u = account(db, email);
  if (isDeactivated(db, u.id)) throw new Error(`${email} is deactivated: no session`);
  const t = token();
  const expiresAt = now() + minutes * 60_000;
  db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)").run(t, u.id, expiresAt);
  return { token: t, expiresAt };
}

/** Ends every session of the account. Returns how many ended. */
export function endSessions(db: DB, email: string): number {
  const u = account(db, email);
  return Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id).changes);
}
