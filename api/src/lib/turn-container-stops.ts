// Fork: the turn containers the bridge stopped because they ran past their
// deadline plus the stop grace (hermes-multi-bridge.mjs, the overdue sweep).
// The bridge reports each one on the agent's socket; the api records it in
// turn_container_stops, where an operator's notifier reads it and posts it.
// Neither the bridge nor the api holds a Slack token.
//
// An agent's own container holds the token that opens its socket, so a report
// is kept only when it names one of that agent's own turn containers, once
// per container, and at most STOPS_PER_HOUR per agent.
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { turnContainerStops } from "../db/fork-schema.js";

export const STOPS_PER_HOUR = 20;

// As the bridge names an agent's turn containers (turnContainerAgent).
function turnContainerAgent(handle: string): string {
  return (
    String(handle ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

export function isOwnTurnContainer(name: unknown, handle: string): name is string {
  if (typeof name !== "string") return false;
  const agent = turnContainerAgent(handle).replace(/[.]/g, "\\.");
  return new RegExp(`^cc-turn-${agent}-[0-9a-f]{8}$`).test(name);
}

export function overdueMsOf(x: unknown): number {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30 * 24 * 3600_000) : 0;
}

// Records one report. Returns whether it was kept. Never throws.
export async function recordTurnContainerStop(agent: { id: string; handle: string }, frame: { container?: unknown; overdueMs?: unknown }): Promise<boolean> {
  if (!isOwnTurnContainer(frame.container, agent.handle)) return false;
  try {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(turnContainerStops)
      .where(and(eq(turnContainerStops.agentId, agent.id), gt(turnContainerStops.stoppedAt, sql`now() - interval '1 hour'`)));
    if (n >= STOPS_PER_HOUR) return false;
    const rows = await db
      .insert(turnContainerStops)
      .values({ container: frame.container, agentId: agent.id, overdueMs: overdueMsOf(frame.overdueMs) })
      .onConflictDoNothing()
      .returning({ container: turnContainerStops.container });
    return rows.length > 0;
  } catch (e) {
    console.error(`[turn-container-stops] recording ${frame.container} failed: ${(e as Error).message}`);
    return false;
  }
}
