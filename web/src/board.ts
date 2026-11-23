// SPDX-License-Identifier: AGPL-3.0-only
// The Board's columns, its address and its moves (screens/Board.tsx; the data: server/src/board.ts).
import type { Task } from "./api.ts";

export type Status = Task["status"];
export type ColumnKey = "needs_you" | "todo" | "progress" | "done";

export interface Column {
  key: ColumnKey;
  label: string;
  /** the statuses whose cards sit in this column */
  statuses: Status[];
  /** the status a card dropped here gets */
  target: Status;
}

/** 2.0's task states, in four columns: checking sits with working, cancelled with done. */
export const COLUMNS: Column[] = [
  { key: "needs_you", label: "Needs you", statuses: ["needs_you"], target: "needs_you" },
  { key: "todo", label: "To do", statuses: ["todo"], target: "todo" },
  { key: "progress", label: "In progress", statuses: ["working", "checking"], target: "working" },
  { key: "done", label: "Done", statuses: ["done", "cancelled"], target: "done" },
];

/** The statuses a person may set, as the Tasks screen offers them (the card's status menu). */
export const STATUS_LABELS: [Status, string][] = [
  ["todo", "To do"],
  ["working", "In progress"],
  ["checking", "Checking"],
  ["needs_you", "Needs you"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

export const columnOf = (s: Status): ColumnKey => COLUMNS.find((c) => c.statuses.includes(s))?.key ?? "todo";

/** The status a card gets when it's dropped on a column, or null when it's already there. */
export function dropStatus(from: Status, to: ColumnKey): Status | null {
  if (columnOf(from) === to) return null;
  return COLUMNS.find((c) => c.key === to)!.target;
}

export interface BoardQuery {
  agent: string;
  chat: string;
  person: string;
  plan: string;
  /** every done and cancelled task, not only the last 14 days */
  allDone: boolean;
}
const KEYS = ["agent", "chat", "person", "plan"] as const;

/** The board's filters from its address: /board?agent=…&chat=…&person=…&plan=…&done=all */
export function readQuery(search: string): BoardQuery {
  const p = new URLSearchParams(search);
  return { agent: p.get("agent") ?? "", chat: p.get("chat") ?? "", person: p.get("person") ?? "", plan: p.get("plan") ?? "", allDone: p.get("done") === "all" };
}

/** The address part for these filters: empty ones and the default Done window stay out of it. */
export function writeQuery(q: BoardQuery): string {
  const p = new URLSearchParams();
  for (const k of KEYS) if (q[k]) p.set(k, q[k]);
  if (q.allDone) p.set("done", "all");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** How many filters are on (the Done window doesn't count). */
export const filterCount = (q: BoardQuery) => KEYS.filter((k) => q[k]).length;

/** The agent a card names: the one it's assigned to, else the one that created it, if any. */
export function cardAgent(t: Pick<Task, "assigneeType" | "assigneeId" | "createdBy">, isAgent: (id: string) => boolean): string {
  if (t.assigneeType === "agent" && t.assigneeId) return t.assigneeId;
  return isAgent(t.createdBy) ? t.createdBy : "";
}

/** The open task's id from the board's address (/board?…&task=…), or "". */
export const readTask = (search: string) => new URLSearchParams(search).get("task") ?? "";

/** The board's address for these filters, with a task open (`id`) or none (""). */
export function boardUrl(q: BoardQuery, id = ""): string {
  const s = writeQuery(q);
  if (!id) return `/board${s}`;
  return `/board${s ? `${s}&` : "?"}task=${encodeURIComponent(id)}`;
}
