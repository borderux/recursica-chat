// SPDX-License-Identifier: AGPL-3.0-only
// People's profiles: a username, an avatar color, and a copy of their Google photo.
//
// Username: like an agent's handle (a letter, then 1-29 of a-z 0-9 _ -), unique across people and
// agents, and never one of the words that mention every agent (@all and so on). It defaults to the
// part of the email before the @. People appear as @username everywhere, agents included; the full
// name (users.name) shows only in settings and behind the initials. Kept in user_handles; triggers
// in the database refuse a handle that a person and an agent would share, whatever code writes it.
//
// Avatar: initials of the full name, on the color the person chose (user_looks) or one picked from
// the account's id, or their Google photo when they have one and haven't turned it off.
//
// Google photo: at each Google sign-in, the server fetches the ID token's `picture` from Google's
// photo host only (exact host, https, no redirects), at most PHOTO.maxBytes within PHOTO.timeoutMs,
// keeps it only if its first bytes are a JPEG, PNG or WebP, and stores a copy in user_photos.
// Browsers load it from us (GET /api/people/:id/photo), never from Google. A sign-in without a
// picture removes the copy; a failed fetch keeps the previous one and never stops the sign-in.
//
//   GET /api/profiles             { profiles: { <user id>: { handle, tone, photo } } }; photo is a
//                                 version to put in the photo's address, or null
//   PUT /api/me/handle { handle } your own username
//   PUT /api/me/look   { tone }   your own color: one of TONES, or null for the default
//   PUT /api/me/photo  { use }    whether your Google photo is your avatar (true by default)
//   GET /api/people/:id/photo     the stored copy
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { MENTION_ALL } from "./services.ts";

export const TONES = ["sand", "sky", "lilac", "sage", "rose", "peach", "mint", "slate"] as const;
export const HANDLE = /^[a-z][a-z0-9_-]{1,29}$/;

/** Where a photo may come from, and how much of it. The tests point it at a fake host. */
export const PHOTO = { protocol: "https:", host: "lh3.googleusercontent.com", maxBytes: 256 * 1024, timeoutMs: 3000 };

interface Stmt {
  get(...a: any[]): unknown;
  all(...a: any[]): unknown[];
  run(...a: any[]): unknown;
}
export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): Stmt;
}

const ready = new WeakSet<object>();
/** Creates the tables and triggers once per database. */
export function profileTables(db: Db): void {
  if (ready.has(db)) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS user_looks (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, tone TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_handles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, handle TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_photos (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type TEXT, bytes BLOB, sha256 TEXT, fetched_at INTEGER, use_photo INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER IF NOT EXISTS agents_handle_not_a_person BEFORE INSERT ON agents
  WHEN EXISTS (SELECT 1 FROM user_handles WHERE handle = NEW.handle)
  BEGIN SELECT RAISE(ABORT, 'that handle is a person''s username'); END;
CREATE TRIGGER IF NOT EXISTS agents_handle_change_not_a_person BEFORE UPDATE OF handle ON agents
  WHEN EXISTS (SELECT 1 FROM user_handles WHERE handle = NEW.handle)
  BEGIN SELECT RAISE(ABORT, 'that handle is a person''s username'); END;
CREATE TRIGGER IF NOT EXISTS user_handle_not_an_agent BEFORE INSERT ON user_handles
  WHEN EXISTS (SELECT 1 FROM agents WHERE handle = NEW.handle)
  BEGIN SELECT RAISE(ABORT, 'that username is an agent''s handle'); END;
CREATE TRIGGER IF NOT EXISTS user_handle_change_not_an_agent BEFORE UPDATE OF handle ON user_handles
  WHEN EXISTS (SELECT 1 FROM agents WHERE handle = NEW.handle)
  BEGIN SELECT RAISE(ABORT, 'that username is an agent''s handle'); END;
`);
  ready.add(db);
}

/** Whether a handle is taken: reserved, an agent's, or another person's username. */
export function handleTaken(db: Db, handle: string, exceptUserId = ""): boolean {
  profileTables(db);
  if (MENTION_ALL.has(handle)) return true;
  if (db.prepare("SELECT 1 FROM agents WHERE handle = ?").get(handle)) return true;
  return !!db.prepare("SELECT 1 FROM user_handles WHERE handle = ? AND user_id != ?").get(handle, exceptUserId);
}

/** The default username from an email: the part before the @, lowercase, a-z 0-9 _ - only. */
export function defaultHandle(db: Db, email: string): string {
  let base = String(email)
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  if (!/^[a-z]/.test(base)) base = "u" + base;
  if (base.length < 2) base = base + "user";
  base = base.slice(0, 27);
  if (!handleTaken(db, base)) return base;
  for (let n = 2; ; n++) if (!handleTaken(db, `${base}-${n}`)) return `${base}-${n}`;
}

/** Gives everyone who has no username yet their default, oldest account first. */
export function ensureHandles(db: Db): void {
  profileTables(db);
  const missing = db.prepare("SELECT id, email FROM users WHERE id NOT IN (SELECT user_id FROM user_handles) ORDER BY created_at").all() as {
    id: string;
    email: string;
  }[];
  for (const u of missing) db.prepare("INSERT INTO user_handles(user_id, handle) VALUES(?, ?)").run(u.id, defaultHandle(db, u.email));
}

/** A person's username, or null when there's no such person. */
export function personHandle(db: Db, userId: string): string | null {
  ensureHandles(db);
  const r = db.prepare("SELECT handle FROM user_handles WHERE user_id = ?").get(userId) as { handle: string } | undefined;
  return r?.handle ?? null;
}

// ---------------------------------------------------------------- the Google photo

/** JPEG, PNG or WebP by its first bytes, or null for anything else. Never by a Content-Type. */
export function imageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** The photo's address, asking Google for 256 pixels, or null when it isn't from Google's photo host. */
export function photoUrl(picture: unknown): URL | null {
  let u: URL;
  try {
    u = new URL(String(picture));
  } catch {
    return null;
  }
  if (u.protocol !== PHOTO.protocol || u.host !== PHOTO.host || u.username || u.password) return null;
  u.pathname = u.pathname.replace(/=s\d+(-c)?$/, "=s256-c");
  return u;
}

/** Fetches a photo within the limits. Returns its bytes and type, or why it was refused. */
export async function fetchPhoto(picture: unknown): Promise<{ type: string; bytes: Uint8Array } | { refused: string }> {
  const url = photoUrl(picture);
  if (!url) return { refused: "not from Google's photo host" };
  let r: Response;
  try {
    r = await fetch(url, { redirect: "error", headers: { accept: "image/*", "user-agent": "RecursicaChat" }, signal: AbortSignal.timeout(PHOTO.timeoutMs) });
  } catch (e) {
    return { refused: `fetch failed (${(e as Error).name})` };
  }
  if (!r.ok || !r.body) return { refused: `HTTP ${r.status}` };
  if (Number(r.headers.get("content-length") ?? 0) > PHOTO.maxBytes) {
    await r.body.cancel().catch(() => {});
    return { refused: "too large" };
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > PHOTO.maxBytes) {
        await reader.cancel().catch(() => {});
        return { refused: "too large" };
      }
      parts.push(value);
    }
  } catch (e) {
    return { refused: `fetch failed (${(e as Error).name})` };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (bytes.set(p, at), (at += p.length));
  const type = imageType(bytes);
  if (!type) return { refused: "not a JPEG, PNG or WebP" };
  return { type, bytes };
}

/** At a Google sign-in: store a copy of the photo, remove it when Google sends none, and keep the
 *  previous copy when the fetch fails. Never throws. */
export async function refreshPhoto(db: Db, userId: string, picture: unknown): Promise<void> {
  try {
    profileTables(db);
    if (picture === undefined || picture === null || picture === "") {
      db.prepare("UPDATE user_photos SET type = NULL, bytes = NULL, sha256 = NULL, fetched_at = ? WHERE user_id = ?").run(Date.now(), userId);
      return;
    }
    const got = await fetchPhoto(picture);
    if ("refused" in got) {
      console.warn(`[profile] Google photo refused: ${got.refused}`);
      return;
    }
    const sha = createHash("sha256").update(got.bytes).digest("hex");
    db.prepare(
      `INSERT INTO user_photos(user_id, type, bytes, sha256, fetched_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET type = excluded.type, bytes = excluded.bytes, sha256 = excluded.sha256, fetched_at = excluded.fetched_at`,
    ).run(userId, got.type, got.bytes, sha, Date.now());
  } catch (e) {
    console.warn(`[profile] Google photo not stored: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- routes

/** Adds the routes. Register them after the session check: they all need a signed-in person. */
export function registerProfile(api: Hono<any>, db: Db): void {
  ensureHandles(db);
  const body = async (c: any) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const me = (c: any) => (c.get("user") as { id: string }).id;

  api.get("/api/profiles", (c) => {
    ensureHandles(db);
    const out: Record<string, { handle: string; tone: string | null; photo: string | null; usePhoto?: boolean; hasPhoto?: boolean }> = {};
    for (const r of db.prepare("SELECT user_id, handle FROM user_handles").all() as any[]) out[r.user_id] = { handle: r.handle, tone: null, photo: null };
    for (const r of db.prepare("SELECT user_id, tone FROM user_looks").all() as any[]) if (out[r.user_id]) out[r.user_id].tone = r.tone;
    for (const r of db.prepare("SELECT user_id, sha256, use_photo FROM user_photos").all() as any[]) {
      const p = out[r.user_id];
      if (!p) continue;
      if (r.sha256 && r.use_photo) p.photo = String(r.sha256).slice(0, 16);
      if (r.user_id === me(c)) ((p.usePhoto = !!r.use_photo), (p.hasPhoto = !!r.sha256));
    }
    const mine = out[me(c)];
    if (mine && mine.usePhoto === undefined) ((mine.usePhoto = true), (mine.hasPhoto = false));
    return c.json({ profiles: out });
  });

  api.put("/api/me/handle", async (c) => {
    const handle = String((await body(c)).handle ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    if (!HANDLE.test(handle)) return c.json({ error: "A username starts with a letter and has 2-30 of a-z, 0-9, _ and -." }, 400);
    if (MENTION_ALL.has(handle)) return c.json({ error: `@${handle} is kept for mentioning every agent in a chat. Pick another username.` }, 400);
    if (handleTaken(db, handle, me(c))) return c.json({ error: `@${handle} is taken` }, 400);
    ensureHandles(db);
    db.prepare("UPDATE user_handles SET handle = ? WHERE user_id = ?").run(handle, me(c));
    return c.json({ handle });
  });

  api.put("/api/me/look", async (c) => {
    const tone = (await body(c)).tone ?? null;
    if (tone === null) db.prepare("DELETE FROM user_looks WHERE user_id = ?").run(me(c));
    else if (typeof tone === "string" && (TONES as readonly string[]).includes(tone))
      db.prepare("INSERT INTO user_looks(user_id, tone) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET tone = excluded.tone").run(me(c), tone);
    else return c.json({ error: `tone must be one of ${TONES.join(", ")}, or null` }, 400);
    return c.json({ tone });
  });

  api.put("/api/me/photo", async (c) => {
    const use = (await body(c)).use;
    if (typeof use !== "boolean") return c.json({ error: "use must be true or false" }, 400);
    db.prepare("INSERT INTO user_photos(user_id, use_photo) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET use_photo = excluded.use_photo").run(
      me(c),
      use ? 1 : 0,
    );
    return c.json({ use });
  });

  api.get("/api/people/:id/photo", (c) => {
    const r = db.prepare("SELECT type, bytes, sha256 FROM user_photos WHERE user_id = ? AND use_photo = 1 AND bytes IS NOT NULL").get(c.req.param("id")) as
      { type: string; bytes: Uint8Array; sha256: string } | undefined;
    if (!r) return c.json({ error: "no photo" }, 404);
    const headers = {
      "content-type": r.type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400",
      etag: `"${r.sha256}"`,
    };
    if (c.req.header("if-none-match") === headers.etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(r.bytes), 200, headers);
  });
}
