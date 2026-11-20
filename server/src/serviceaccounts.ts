// SPDX-License-Identifier: AGPL-3.0-only
// Service accounts: an identity for a program, not a person. A program that works with the server
// from outside, on the server's own computer, uses a service account's token instead of a person's
// session.
//
//   sudo node server/src/cli.ts service-create <name>   a new service account, with no token yet
//   sudo node server/src/cli.ts service-token <name>    a new token, printed once, to stdout only;
//                                                        the old token stops working at once
//   sudo node server/src/cli.ts service-revoke <name>   ends its token; service-token starts it again
//   sudo node server/src/cli.ts service-list            names and dates, never a token (stdout)
//
// - A service account is not a user: it has no row in users, can't sign in, isn't listed among
//   people and can't be a chat's member.
// - Only root makes, changes or ends one: the token is a way in, so it takes the same power as
//   reading the database.
// - The token doesn't expire. It is stored only as its SHA-256, so the database never holds it.
// - It works only on /api/service/* (and the service event socket). Every person's route refuses
//   it, and the service routes refuse a person's session.
// - The service routes take only a request made on the server's own computer, straight to the
//   server: from a loopback address, with no cookie, no Origin or Sec-Fetch-Site (a browser) and no
//   proxy headers (X-Forwarded-For, Forwarded, Tailscale's). A token that leaks is no use from
//   anywhere else.
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { id, token } from "./crypto.ts";

export const SERVICE_TOKEN_PREFIX = "ccsvc_";
const NAME = /^[a-z][a-z0-9-]{1,39}$/;
// headers that mean a browser made the request, or a proxy passed it on
const REFUSED_HEADERS = ["cookie", "origin", "sec-fetch-site", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "tailscale-user-login", "tailscale-user-name"];

export interface ServiceAccount {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  hasToken: boolean;
}

export function serviceTables(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS service_accounts (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
    );`,
  );
}

const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");
const row = (r: any): ServiceAccount => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? null,
  revokedAt: r.revoked_at ?? null,
  hasToken: !!r.token_hash,
});

export function serviceByName(db: DB, name: string): ServiceAccount | undefined {
  serviceTables(db);
  const r = db.prepare("SELECT * FROM service_accounts WHERE name = ?").get(name) as any;
  return r ? row(r) : undefined;
}
export function serviceById(db: DB, sid: string): ServiceAccount | undefined {
  serviceTables(db);
  const r = db.prepare("SELECT * FROM service_accounts WHERE id = ?").get(sid) as any;
  return r ? row(r) : undefined;
}
export function listServices(db: DB): ServiceAccount[] {
  serviceTables(db);
  return (db.prepare("SELECT * FROM service_accounts ORDER BY name").all() as any[]).map(row);
}

export function createService(db: DB, name: string): ServiceAccount {
  serviceTables(db);
  if (!NAME.test(name)) throw new Error("a service's name is 2 to 40 of a-z, 0-9 and -, starting with a letter");
  if (serviceByName(db, name)) throw new Error(`there is already a service ${name}`);
  db.prepare("INSERT INTO service_accounts(id, name, created_at) VALUES(?,?,?)").run(id("svc_"), name, now());
  return serviceByName(db, name)!;
}

/** A new token for the service; the old one stops working. Returns the token, which is kept nowhere. */
export function newServiceToken(db: DB, name: string): string {
  const s = serviceByName(db, name);
  if (!s) throw new Error(`no service ${name}`);
  const t = SERVICE_TOKEN_PREFIX + token(32);
  db.prepare("UPDATE service_accounts SET token_hash = ?, revoked_at = NULL WHERE id = ?").run(hashOf(t), s.id);
  return t;
}

/** Ends the service's token. */
export function revokeService(db: DB, name: string): void {
  const s = serviceByName(db, name);
  if (!s) throw new Error(`no service ${name}`);
  db.prepare("UPDATE service_accounts SET token_hash = NULL, revoked_at = ? WHERE id = ?").run(now(), s.id);
}

/** The service a token belongs to, or undefined. */
export function serviceForToken(db: DB, t: string): ServiceAccount | undefined {
  if (!t.startsWith(SERVICE_TOKEN_PREFIX)) return undefined;
  serviceTables(db);
  const r = db.prepare("SELECT * FROM service_accounts WHERE token_hash = ? AND revoked_at IS NULL").get(hashOf(t)) as any;
  if (!r) return undefined;
  // when it was last used, for service-list; written at most once a minute
  if (!r.last_used_at || now() - r.last_used_at > 60_000) db.prepare("UPDATE service_accounts SET last_used_at = ? WHERE id = ?").run(now(), r.id);
  return row(r);
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Who is asking on a service route: the service, or why the request is refused, with its HTTP status.
 * `header` reads a request header by its lower-case name; `remote` is the connection's address.
 */
export function serviceRequest(db: DB, header: (name: string) => string | undefined, remote: string | undefined): { service: ServiceAccount } | { status: 401 | 403; error: string } {
  for (const h of REFUSED_HEADERS)
    if (header(h) !== undefined) return { status: 403, error: "A service's token works only for a program on the server's own computer, straight to the server, never from a browser or through a proxy." };
  if (!remote || !LOOPBACK.test(remote)) return { status: 403, error: "A service's token works only from the server's own computer." };
  const t = (header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const service = t ? serviceForToken(db, t) : undefined;
  if (!service) return { status: 401, error: "This needs a service's token." };
  return { service };
}

/** The service routes. Registered before the session check, which they don't use. */
export function registerServiceAccounts(api: Hono<any>, db: DB, extend?: (svcApi: Hono<any>) => void): void {
  serviceTables(db);
  api.use("/api/service/*", async (c, next) => {
    const r = serviceRequest(db, (n) => c.req.header(n), (c.env as any)?.incoming?.socket?.remoteAddress);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    c.set("service", r.service);
    await next();
  });
  api.get("/api/service/me", (c) => {
    const s = c.get("service") as ServiceAccount;
    return c.json({ service: { name: s.name, createdAt: s.createdAt } });
  });
  extend?.(api);
  // any other /api/service/* path: not found here, rather than falling through to a person's routes
  api.all("/api/service/*", (c) => c.json({ error: "not found" }, 404));
}

export const SERVICE_COMMANDS = ["service-create", "service-token", "service-revoke", "service-list"];

/** Runs a service-* command. Returns what goes to stdout (the token only) and to stderr. Throws with a message. */
export function serviceCommand(db: DB, cmd: string, args: string[]): { stdout?: string; stderr?: string } {
  const one = () => {
    if (args.length !== 1 || !args[0]) throw new Error(`usage: cli.ts ${cmd} <name>`);
    return args[0];
  };
  if (cmd === "service-create") {
    const s = createService(db, one());
    return { stderr: `Made the service ${s.name}. Make its token with: cli.ts service-token ${s.name}` };
  }
  if (cmd === "service-token") {
    const name = one();
    const t = newServiceToken(db, name);
    return { stdout: t, stderr: `A new token for ${name}. Its old token, if any, no longer works.` };
  }
  if (cmd === "service-revoke") {
    const name = one();
    revokeService(db, name);
    return { stderr: `Ended the token of ${name}. A new one starts it again: cli.ts service-token ${name}` };
  }
  if (cmd === "service-list") {
    if (args.length) throw new Error("usage: cli.ts service-list");
    const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "never");
    const lines = listServices(db).map((s) => `${s.name}  token: ${s.hasToken ? "yes" : s.revokedAt ? "revoked" : "none"}  made: ${day(s.createdAt)}  last used: ${day(s.lastUsedAt)}`);
    return lines.length ? { stdout: lines.join("\n") } : { stderr: "No services." };
  }
  throw new Error(`unknown command ${cmd}`);
}
