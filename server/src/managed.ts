// SPDX-License-Identifier: AGPL-3.0-only
// Managed agents: agents whose settings come from a repository, set on the server by its operator.
//
//   sudo node server/src/cli.ts manage <handle>               marks the agent managed
//   sudo node server/src/cli.ts unmanage <handle>             makes the agent editable again
//   sudo node server/src/cli.ts agent-get <handle>            prints the managed settings as JSON
//   sudo node server/src/cli.ts agent-set <handle> [--check]  sets them from JSON on stdin
//   sudo node server/src/cli.ts agent-models                  prints each agent's handle and model
//
// - Only root may run these, like `session` (clisession.ts).
// - For a managed agent, the API refuses a change to any of MANAGED_FIELDS from every session, the
//   owner's included, and the web app shows them read-only. The CLI is the one way to change them.
// - agent-set changes only a managed agent, and only the fields that differ. It refuses a model that
//   names a provider the server does not have. The server restarts an agent whose engine, model or
//   sandbox changed before the agent's next turn (runtime.ts).
import { createHash } from "node:crypto";
import type { DB } from "./db.ts";
import { now } from "./db.ts";

/** The settings a managed agent's repository owns, by their names in the API. */
export const MANAGED_FIELDS = ["instructions", "model", "autonomy", "sandbox", "budgetCents"] as const;
type Field = (typeof MANAGED_FIELDS)[number];
const COLUMN: Record<Field, string> = { instructions: "instructions", model: "model", autonomy: "autonomy", sandbox: "sandbox", budgetCents: "budget_cents" };
export const MAX_INSTRUCTIONS = 20_000;

const ready = new WeakSet<object>();
export function managedTables(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS managed_agents (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, since INTEGER NOT NULL);`);
  ready.add(db);
}

/** When the agent became managed, or null when it is not managed. */
export function managedSince(db: DB, agentId: string): number | null {
  managedTables(db);
  const r = db.prepare("SELECT since FROM managed_agents WHERE agent_id = ?").get(agentId) as any;
  return r ? r.since : null;
}

/** Why the API refuses this change, or null. Refuses any managed field on a managed agent. */
export function managedRefusal(db: DB, agentId: string, body: Record<string, unknown>): string | null {
  if (managedSince(db, agentId) === null) return null;
  const hit = MANAGED_FIELDS.filter((f) => body[f] !== undefined);
  return hit.length ? `This agent is managed: its ${hit.join(", ")} come from the repository, and can't be changed here.` : null;
}

function agentRow(db: DB, handle: string): any {
  const h = String(handle ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!h) throw new Error("give an agent's handle");
  const r = db.prepare("SELECT * FROM agents WHERE handle = ? AND archived = 0").get(h);
  if (!r) throw new Error(`no agent @${h}`);
  return r;
}

export function manage(db: DB, handle: string, on: boolean): "managed" | "already managed" | "unmanaged" | "was not managed" {
  managedTables(db);
  const a = agentRow(db, handle);
  if (on) return db.prepare("INSERT OR IGNORE INTO managed_agents(agent_id, since) VALUES(?, ?)").run(a.id, now()).changes ? "managed" : "already managed";
  return db.prepare("DELETE FROM managed_agents WHERE agent_id = ?").run(a.id).changes ? "unmanaged" : "was not managed";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The managed settings, with the instructions as a SHA-256 and a length only. */
export function agentGet(db: DB, handle: string): Record<string, unknown> {
  const a = agentRow(db, handle);
  return {
    handle: a.handle,
    managed: managedSince(db, a.id) !== null,
    model: a.model,
    autonomy: a.autonomy,
    sandbox: a.sandbox,
    budgetCents: a.budget_cents,
    instructionsSha256: sha(a.instructions),
    instructionsLength: a.instructions.length,
  };
}

/** Each agent's handle and model, one per line, tab-separated. */
export function agentModels(db: DB): string {
  return (db.prepare("SELECT handle, model FROM agents WHERE archived = 0 ORDER BY handle").all() as any[]).map((r) => `${r.handle}\t${r.model}`).join("\n");
}

/** Checks the settings from stdin. Returns them by field, or throws with the reason. */
export function parseSettings(text: string, providerIds: string[]): Partial<Record<Field, string | number>> {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("stdin must be a JSON object of settings");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("stdin must be a JSON object of settings");
  const out: Partial<Record<Field, string | number>> = {};
  for (const k of Object.keys(v))
    if (!(MANAGED_FIELDS as readonly string[]).includes(k)) throw new Error(`${k} is not a managed setting (${MANAGED_FIELDS.join(", ")})`);
  if (v.instructions !== undefined) {
    if (typeof v.instructions !== "string") throw new Error("instructions must be text");
    if (v.instructions.length > MAX_INSTRUCTIONS) throw new Error(`instructions are ${v.instructions.length} characters, over ${MAX_INSTRUCTIONS}`);
    out.instructions = v.instructions;
  }
  if (v.model !== undefined) {
    if (typeof v.model !== "string" || v.model.length > 120) throw new Error("model must be text of at most 120 characters");
    const pid = v.model.includes(":") ? v.model.split(":")[0] : "";
    if (pid && !providerIds.includes(pid)) throw new Error(`the model ${v.model} names the provider "${pid}", which the server does not have`);
    out.model = v.model;
  }
  if (v.autonomy !== undefined) {
    if (!["ask", "act", "auto"].includes(v.autonomy)) throw new Error("autonomy must be ask, act or auto");
    out.autonomy = v.autonomy;
  }
  if (v.sandbox !== undefined) {
    if (!["docker", "local"].includes(v.sandbox)) throw new Error("sandbox must be docker or local");
    out.sandbox = v.sandbox;
  }
  if (v.budgetCents !== undefined) {
    if (!Number.isInteger(v.budgetCents) || v.budgetCents < 0) throw new Error("budgetCents must be a whole number, 0 or more");
    out.budgetCents = v.budgetCents;
  }
  return out;
}

/** Sets the fields that differ on a managed agent. Returns the names of the fields that changed. */
export function agentSet(db: DB, handle: string, settings: Partial<Record<Field, string | number>>, { check = false } = {}): Field[] {
  const a = agentRow(db, handle);
  if (managedSince(db, a.id) === null) throw new Error(`@${a.handle} is not managed. Mark it first: cli.ts manage ${a.handle}`);
  const changed = (Object.keys(settings) as Field[]).filter((f) => a[COLUMN[f]] !== settings[f]);
  if (changed.length && !check)
    db.prepare(`UPDATE agents SET ${changed.map((f) => `${COLUMN[f]} = ?`).join(", ")} WHERE id = ?`).run(...changed.map((f) => settings[f]!), a.id);
  return changed;
}
