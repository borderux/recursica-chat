// SPDX-License-Identifier: AGPL-3.0-only
// A person's avatar color. A person's avatar is their initials on a color; by default the web app
// picks the color from the account's id, and here anyone may choose their own instead.
//
//   PUT /api/me/look  { tone }   your own color: one of TONES, or null for the default
//   GET /api/looks               everyone's chosen colors, { looks: { <user id>: <tone> } }
//
// The color is a name from a fixed list, so nothing a person types reaches the page's styles. It
// lives in its own table, removed with the account.
import type { Hono } from "hono";

export const TONES = ["sand", "sky", "lilac", "sage", "rose", "peach", "mint", "slate"] as const;

interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...a: any[]): unknown[]; run(...a: any[]): unknown };
}

/** Adds the two routes. Register them after the session check: both need a signed-in person. */
export function registerProfile(api: Hono<any>, db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS user_looks (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, tone TEXT NOT NULL)");

  api.get("/api/looks", (c) => {
    const rows = db.prepare("SELECT user_id, tone FROM user_looks").all() as { user_id: string; tone: string }[];
    return c.json({ looks: Object.fromEntries(rows.map((r) => [r.user_id, r.tone])) });
  });

  api.put("/api/me/look", async (c) => {
    const me = c.get("user") as { id: string };
    const b = (await c.req.json().catch(() => null)) as { tone?: unknown } | null;
    const tone = b?.tone ?? null;
    if (tone === null) db.prepare("DELETE FROM user_looks WHERE user_id = ?").run(me.id);
    else if (typeof tone === "string" && (TONES as readonly string[]).includes(tone))
      db.prepare("INSERT INTO user_looks(user_id, tone) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET tone = excluded.tone").run(me.id, tone);
    else return c.json({ error: `tone must be one of ${TONES.join(", ")}, or null` }, 400);
    return c.json({ tone });
  });
}
