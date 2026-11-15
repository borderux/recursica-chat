// Fork: show that an agent is working where people look. While a task
// assignee's turn on that task runs, from the turn's start until its reply,
// the task card shows a live line ("designer is working, 2 min: reading
// skills") and the board card shows a working marker.
//
// The worker records the turn when it starts (startTaskWork) and removes it
// when the turn ends, however it ended (endTaskWork). The bridge sends the
// step the turn is on over the agent's socket (ws/agent-socket.ts →
// setTurnPhase); only TURN_PHASES are kept, since an agent's own container
// holds the token that opens that socket.
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, agents, members, taskAssignees } from "../db/schema.js";
import { taskTurnActivity } from "../db/fork-schema.js";
import { publishToWorkspace } from "./events.js";

export const TURN_PHASES = [
  "starting",
  "thinking",
  "reading skills",
  "reading files",
  "writing files",
  "running a command",
  "searching the web",
  "using the browser",
  "using tools",
  "delegating",
  "writing the reply",
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

export function isTurnPhase(x: unknown): x is TurnPhase {
  return typeof x === "string" && (TURN_PHASES as readonly string[]).includes(x);
}

// Only a turn of one of the task's assignees shows on the task.
export function showsOnTask(assignees: readonly string[], agentMemberId: string | null | undefined): boolean {
  return Boolean(agentMemberId) && assignees.includes(agentMemberId!);
}

export type TaskWork = {
  taskId: string;
  runId: string;
  agentId: string;
  agentMemberId: string;
  agentName: string;
  agentHandle: string;
  startedAt: string;
  phase: TurnPhase | null;
};

const changed = (workspaceId: string, taskId: string) =>
  publishToWorkspace(workspaceId, { type: "task.working", workspaceId, taskId }).catch(() => {});

// The turn starts. Records it when the agent is one of the task's assignees.
// Returns whether it did. Never throws: this is display, not the turn.
export async function startTaskWork(p: { runId: string; agentId: string; taskId: string; workspaceId: string }): Promise<boolean> {
  try {
    const [m] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.kind, "agent"), eq(members.refId, p.agentId), eq(members.workspaceId, p.workspaceId)))
      .limit(1);
    const assignees = (await db.select({ memberId: taskAssignees.memberId }).from(taskAssignees).where(eq(taskAssignees.taskId, p.taskId))).map((r) => r.memberId);
    if (!showsOnTask(assignees, m?.id)) return false;
    await db
      .insert(taskTurnActivity)
      .values({ runId: p.runId, agentId: p.agentId, taskId: p.taskId, workspaceId: p.workspaceId, phase: "starting", phaseAt: new Date() })
      .onConflictDoNothing();
    await changed(p.workspaceId, p.taskId);
    return true;
  } catch (e) {
    console.error(`[task-working] recording the turn on ${p.taskId} failed: ${(e as Error).message}`);
    return false;
  }
}

// The step the agent's running turn is on. An agent runs one turn at a time.
export async function setTurnPhase(agentId: string, phase: unknown): Promise<void> {
  if (!isTurnPhase(phase)) return;
  try {
    const rows = await db
      .update(taskTurnActivity)
      .set({ phase, phaseAt: new Date() })
      .where(and(eq(taskTurnActivity.agentId, agentId), sql`${taskTurnActivity.phase} IS DISTINCT FROM ${phase}`))
      .returning({ taskId: taskTurnActivity.taskId, workspaceId: taskTurnActivity.workspaceId });
    for (const r of rows) await changed(r.workspaceId, r.taskId);
  } catch (e) {
    console.error(`[task-working] recording a turn's step failed: ${(e as Error).message}`);
  }
}

// The turn is over: its reply is applied, or it failed or was cancelled.
export async function endTaskWork(runId: string): Promise<void> {
  try {
    const rows = await db
      .delete(taskTurnActivity)
      .where(eq(taskTurnActivity.runId, runId))
      .returning({ taskId: taskTurnActivity.taskId, workspaceId: taskTurnActivity.workspaceId });
    for (const r of rows) await changed(r.workspaceId, r.taskId);
  } catch (e) {
    console.error(`[task-working] removing the turn ${runId} failed: ${(e as Error).message}`);
  }
}

// After a restart: remove the rows of every turn that is no longer running.
export async function clearStaleTaskWork(): Promise<number> {
  const running = db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.status, "running"));
  const rows = await db
    .delete(taskTurnActivity)
    .where(notInArray(taskTurnActivity.runId, running))
    .returning({ taskId: taskTurnActivity.taskId, workspaceId: taskTurnActivity.workspaceId });
  for (const r of rows) await changed(r.workspaceId, r.taskId);
  return rows.length;
}

// Every running task turn in the workspace, optionally for some tasks only.
export async function listTaskWork(workspaceId: string, taskIds?: string[]): Promise<TaskWork[]> {
  if (taskIds && !taskIds.length) return [];
  const rows = await db
    .select({
      taskId: taskTurnActivity.taskId,
      runId: taskTurnActivity.runId,
      agentId: taskTurnActivity.agentId,
      agentMemberId: members.id,
      agentName: agents.name,
      agentHandle: agents.handle,
      startedAt: taskTurnActivity.startedAt,
      phase: taskTurnActivity.phase,
    })
    .from(taskTurnActivity)
    .innerJoin(agentRuns, and(eq(agentRuns.id, taskTurnActivity.runId), eq(agentRuns.status, "running")))
    .innerJoin(agents, eq(agents.id, taskTurnActivity.agentId))
    .innerJoin(members, and(eq(members.kind, "agent"), eq(members.refId, agents.id), eq(members.workspaceId, workspaceId)))
    .where(
      and(
        eq(taskTurnActivity.workspaceId, workspaceId),
        ...(taskIds ? [inArray(taskTurnActivity.taskId, taskIds)] : []),
      ),
    );
  return rows.map((r) => ({
    ...r,
    startedAt: new Date(r.startedAt).toISOString(),
    phase: isTurnPhase(r.phase) ? r.phase : null,
  }));
}
