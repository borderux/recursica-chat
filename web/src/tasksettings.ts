// SPDX-License-Identifier: AGPL-3.0-only
// Per-task settings in the web app (ui/tasksettings.tsx; the server: server/src/tasksettings.ts): who
// may change them, how a choice, a change and a move to a cloud model read.

export interface SettingChoice {
  value: string;
  label: string;
}
export interface SettingDecl {
  key: string;
  label: string;
  default: string;
  choices: SettingChoice[];
}
export interface SettingChange {
  id?: string;
  key: string;
  oldValue: string;
  newValue: string;
  byType?: string;
  byId?: string;
  at?: number;
}

/**
 * Whether this person may change a task's settings: its creator or an admin, while the task isn't done
 * or cancelled. Only what the menus offer: the server checks again, and its answer is the one that counts.
 */
export function canChangeSettings(t: { createdBy: string; status: string }, me: { id: string; role: string }): boolean {
  if (t.status === "done" || t.status === "cancelled") return false;
  return t.createdBy === me.id || me.role === "admin" || me.role === "owner";
}

/** A choice's label, or the value itself when the settings no longer offer it. */
export const choiceLabel = (s: SettingDecl | undefined, value: string) => s?.choices.find((c) => c.value === value)?.label ?? value;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The cloud mark's text: "Cloud since 14:32", with the day when it isn't today. */
export function cloudSince(since: number, now = Date.now()): string {
  const d = new Date(since);
  if (d.toDateString() === new Date(now).toDateString()) return `Cloud since ${hhmm(d)}`;
  return `Cloud since ${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${hhmm(d)}`;
}

/** One line of the history: "Speed: Slow to Fast". */
export function describeChange(decl: SettingDecl[], c: SettingChange): string {
  const s = decl.find((d) => d.key === c.key);
  return `${s?.label ?? c.key}: ${choiceLabel(s, c.oldValue)} to ${choiceLabel(s, c.newValue)}`;
}
