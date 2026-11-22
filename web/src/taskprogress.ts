// SPDX-License-Identifier: AGPL-3.0-only
// What a task card shows in place while the task runs (server/src/taskprogress.ts).

/** The progress line to show under a task's title: none once the task is done or cancelled. */
export const progressLine = (t: { status: string; progress?: string }) => (t.status === "done" || t.status === "cancelled" ? "" : (t.progress ?? "").trim());

/** Whether a task shows the live "Working" mark: only a task at "working", never one that waits its turn. */
export const showsWorking = (t: { status: string }) => t.status === "working";
