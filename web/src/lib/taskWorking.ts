// Fork: an agent working on a task, where people look (api/src/lib/task-working.ts).
// While an assignee's turn on a task runs, from its start until its reply,
// the task card shows a live line and the board card a working marker.

export interface TaskWork {
  taskId: string;
  runId: string;
  agentId: string;
  agentMemberId: string;
  agentName: string;
  agentHandle: string;
  startedAt: string;
  phase: string | null;
}

// How long the turn has run: "<1 min", "2 min", "1 h 5 min".
export function workingFor(startedAt: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// "designer is working, 2 min: reading skills"
export function workingLine(w: Pick<TaskWork, "agentName" | "agentHandle" | "startedAt" | "phase">, now = Date.now()): string {
  const who = w.agentName || w.agentHandle;
  return `${who} is working, ${workingFor(w.startedAt, now)}${w.phase ? `: ${w.phase}` : ""}`;
}

// The running turns on one task, oldest first.
export function workOnTask(all: readonly TaskWork[] | undefined, taskId: string): TaskWork[] {
  return (all ?? []).filter((w) => w.taskId === taskId).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

// The board marker's tooltip: one line per agent working on the card.
export function markerTitle(work: readonly TaskWork[], now = Date.now()): string {
  return work.map((w) => workingLine(w, now)).join("\n");
}
