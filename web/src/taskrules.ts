// SPDX-License-Identifier: AGPL-3.0-only
// Who can change a task's status, as the web app offers it (the server's rule, and its answer:
// server/src/taskrules.ts). A task assigned to an agent is agent-run: a person may only cancel it
// while it runs, answer it in its chat when it needs them, and reopen it once it's finished. A
// person's task, or one assigned to no one, takes every status.
import type { Task } from "./api.ts";
import { STATUS_LABELS, type Status } from "./board.ts";

export const isAgentRun = (t: Pick<Task, "assigneeType">) => t.assigneeType === "agent";
export const isFinished = (t: Pick<Task, "status">) => t.status === "done" || t.status === "cancelled";

/** The statuses a person may pick for this task, with their labels; the current one always included. */
export function statusChoices(t: Pick<Task, "status" | "assigneeType">): [Status, string][] {
  if (!isAgentRun(t)) return STATUS_LABELS;
  if (isFinished(t)) return STATUS_LABELS.filter(([s]) => s === t.status);
  return STATUS_LABELS.filter(([s]) => s === t.status || s === "cancelled");
}

/** Whether a person may move this task to another column, or tick it done. */
export const personMoves = (t: Pick<Task, "assigneeType">) => !isAgentRun(t);

/** Why a person can't move it: for a title, or a screen reader. */
export const agentRunNote = (name: string) => `${name} runs this task: you can cancel it or answer it, not move it`;
