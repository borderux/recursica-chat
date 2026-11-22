// SPDX-License-Identifier: AGPL-3.0-only
// Starters: the suggestions an empty chat with an agent shows, one tap each. An agent with none shows
// the web app's generic ones. A managed agent's starters come from its repository, like its other
// settings (managed.ts): cli.ts agent-set takes them as "starters", a list of text, and agent-get
// prints them. The API returns them with the agent and changes them for no one.
//
// A starter with a [placeholder] in square brackets fills the message box for editing instead of
// sending (web/src/screens/Chats.tsx).
import type { DB } from "./db.ts";

export const MAX_STARTERS = 8;
export const MAX_STARTER_LENGTH = 200;

const ready = new WeakSet<object>();
function starterTables(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_starters (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, starters TEXT NOT NULL);`);
  ready.add(db);
}

/** The agent's starters, in order; none when it has none. */
export function startersOf(db: DB, agentId: string): string[] {
  starterTables(db);
  const r = db.prepare("SELECT starters FROM agent_starters WHERE agent_id = ?").get(agentId) as any;
  if (!r) return [];
  try {
    const v = JSON.parse(r.starters);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Checks a list of starters. Returns it, each trimmed, or throws with the reason. */
export function parseStarters(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("starters must be a list of text");
  if (v.length > MAX_STARTERS) throw new Error(`starters are ${v.length}, over ${MAX_STARTERS}`);
  const out = v.map((s, k) => {
    if (typeof s !== "string" || !s.trim()) throw new Error(`starter ${k + 1} must be text`);
    const t = s.trim();
    if (t.length > MAX_STARTER_LENGTH) throw new Error(`starter ${k + 1} is ${t.length} characters, over ${MAX_STARTER_LENGTH}`);
    if (/[\r\n]/.test(t)) throw new Error(`starter ${k + 1} must be one line`);
    return t;
  });
  if (new Set(out).size !== out.length) throw new Error("each starter must differ from the others");
  return out;
}

/** Sets the agent's starters; an empty list removes them. Returns whether they changed. */
export function setStarters(db: DB, agentId: string, starters: string[], { check = false } = {}): boolean {
  const before = startersOf(db, agentId);
  if (JSON.stringify(before) === JSON.stringify(starters)) return false;
  if (check) return true;
  if (starters.length) db.prepare("INSERT INTO agent_starters(agent_id, starters) VALUES(?, ?) ON CONFLICT(agent_id) DO UPDATE SET starters = excluded.starters").run(agentId, JSON.stringify(starters));
  else db.prepare("DELETE FROM agent_starters WHERE agent_id = ?").run(agentId);
  return true;
}
