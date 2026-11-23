// SPDX-License-Identifier: AGPL-3.0-only
// Per-task settings, declared per install. An install names its settings in a JSON file
// (CIRCLECHAT_TASK_SETTINGS_FILE): each setting has a key, a label, its choices and a default. Every
// task then carries a choice for each one, which the task's creator or an admin may change. Programs
// outside the server read the choices (gatewayroute.ts) and act on them; nothing in here knows what a
// setting means.
//
// - The file: { "settings": [ { key, label, default, choices: [ { value, label } ] } ], "stall_minutes"? }.
//   Keys and values are [a-z0-9_]{1,40}, labels at most 80 characters, 2 to 10 choices, and the
//   default is one of them. A bad file logs one error and the server runs with no settings. Unset or
//   missing, there are no settings and nothing new shows.
// - Storage: three tables of their own, never upstream's:
//     task_settings          the current choice; a missing row means the default
//     task_setting_changes   every change, with who and when; append-only
//     task_cloud_switches    each time a program moved a task's work to a cloud model; append-only,
//                            at most one row per (task, n)
// - The task JSON gains `settings` (every declared key, defaults filled in) and `cloud` (the latest
//   switch, with the server's own text for it, or null).
// - People's routes: GET /api/task-settings, PUT /api/tasks/:id/settings and
//   GET /api/tasks/:id/settings/history (registerTaskSettings below).
import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import type { App } from "./app.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { id } from "./crypto.ts";

export interface Choice {
  value: string;
  label: string;
}
export interface TaskSetting {
  key: string;
  label: string;
  default: string;
  choices: Choice[];
}
export interface TaskSettingsConfig {
  settings: TaskSetting[];
  /** the wait before a stalled task moves to a cloud model, in minutes: for the chat line's text only */
  stallMinutes: number;
}
export interface CloudMark {
  since: number;
  reason: CloudReason;
  text: string;
}

export const NO_SETTINGS: TaskSettingsConfig = Object.freeze({ settings: [], stallMinutes: 15 }) as TaskSettingsConfig;
export const CLOUD_REASONS = ["stalled", "cloud_from_start"] as const;
export type CloudReason = (typeof CLOUD_REASONS)[number];

const NAME = /^[a-z0-9_]{1,40}$/;
const MAX_LABEL = 80;

// ---------------------------------------------------------------- the file

/** Checks a settings file's contents. Throws with the first problem found. */
export function parseTaskSettings(raw: unknown): TaskSettingsConfig {
  const obj = (v: unknown, what: string): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object`);
    return v as Record<string, unknown>;
  };
  const label = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be text`);
    if (v.length > MAX_LABEL) throw new Error(`${what} is ${v.length} characters, over ${MAX_LABEL}`);
    return v.trim();
  };
  const name = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !NAME.test(v)) throw new Error(`${what} must be 1 to 40 of a-z, 0-9 and _`);
    return v;
  };
  const top = obj(raw, "the file");
  for (const k of Object.keys(top)) if (k !== "settings" && k !== "stall_minutes") throw new Error(`unknown field "${k}"`);
  let stallMinutes = NO_SETTINGS.stallMinutes;
  if (top.stall_minutes !== undefined) {
    const m = top.stall_minutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 1440) throw new Error("stall_minutes must be a whole number from 1 to 1440");
    stallMinutes = m;
  }
  if (!Array.isArray(top.settings)) throw new Error('"settings" must be a list');
  const keys = new Set<string>();
  const settings = top.settings.map((s, i): TaskSetting => {
    const o = obj(s, `setting ${i + 1}`);
    for (const k of Object.keys(o)) if (!["key", "label", "default", "choices"].includes(k)) throw new Error(`setting ${i + 1}: unknown field "${k}"`);
    const key = name(o.key, `setting ${i + 1}'s key`);
    if (keys.has(key)) throw new Error(`setting "${key}" is declared twice`);
    keys.add(key);
    if (!Array.isArray(o.choices) || o.choices.length < 2 || o.choices.length > 10) throw new Error(`setting "${key}" needs 2 to 10 choices`);
    const values = new Set<string>();
    const choices = o.choices.map((c, j): Choice => {
      const co = obj(c, `setting "${key}", choice ${j + 1}`);
      for (const k of Object.keys(co)) if (k !== "value" && k !== "label") throw new Error(`setting "${key}", choice ${j + 1}: unknown field "${k}"`);
      const value = name(co.value, `setting "${key}", choice ${j + 1}'s value`);
      if (values.has(value)) throw new Error(`setting "${key}" has the choice "${value}" twice`);
      values.add(value);
      return { value, label: label(co.label, `setting "${key}", choice "${value}"'s label`) };
    });
    const dflt = name(o.default, `setting "${key}"'s default`);
    if (!values.has(dflt)) throw new Error(`setting "${key}"'s default "${dflt}" isn't one of its choices`);
    return { key, label: label(o.label, `setting "${key}"'s label`), default: dflt, choices };
  });
  return { settings, stallMinutes };
}

/**
 * The settings an install declares, from CIRCLECHAT_TASK_SETTINGS_FILE. Unset or missing: none. A
 * file that can't be read or doesn't pass the checks logs one error, and the server runs with none
 * (fail closed: a task with no setting gets the default).
 */
export function loadTaskSettings(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.error): TaskSettingsConfig {
  const file = env.CIRCLECHAT_TASK_SETTINGS_FILE ?? "";
  if (!file) return NO_SETTINGS;
  if (!existsSync(file)) {
    log(`Task settings: ${file} doesn't exist, so tasks have no settings.`);
    return NO_SETTINGS;
  }
  try {
    return parseTaskSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    log(`Task settings: ${file} can't be used, so tasks have no settings: ${(e as Error).message}`);
    return NO_SETTINGS;
  }
}

const configs = new WeakMap<DB, TaskSettingsConfig>();

/** The settings this server's tasks have: read from the environment the first time they're needed. */
export function taskSettingsOf(db: DB): TaskSettingsConfig {
  let c = configs.get(db);
  if (!c) {
    c = loadTaskSettings();
    configs.set(db, c);
  }
  return c;
}

/** Sets the declared settings directly, in place of the file (tests, and a server that loads them itself). */
export function useTaskSettings(db: DB, c: TaskSettingsConfig): void {
  configs.set(db, c);
}

// ---------------------------------------------------------------- the tables

const ready = new WeakSet<object>();
function tables(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_settings (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY(task_id, key)
    );
    CREATE TABLE IF NOT EXISTS task_setting_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      key TEXT NOT NULL,
      old_value TEXT NOT NULL,
      new_value TEXT NOT NULL,
      by_type TEXT NOT NULL,
      by_id TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_setting_changes_task ON task_setting_changes(task_id, at);
    CREATE TABLE IF NOT EXISTS task_cloud_switches (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      reason TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY(task_id, n)
    );
    CREATE TRIGGER IF NOT EXISTS task_setting_changes_append_only BEFORE UPDATE ON task_setting_changes
      BEGIN SELECT RAISE(ABORT, 'task_setting_changes is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS task_cloud_switches_append_only BEFORE UPDATE ON task_cloud_switches
      BEGIN SELECT RAISE(ABORT, 'task_cloud_switches is append-only'); END;
  `);
  ready.add(db);
}

/** A task's choice for each declared setting: the stored one, or the default. */
export function settingsOf(db: DB, taskId: string): Record<string, string> {
  const decl = taskSettingsOf(db).settings;
  if (!decl.length) return {};
  tables(db);
  const stored = new Map((db.prepare("SELECT key, value FROM task_settings WHERE task_id = ?").all(taskId) as any[]).map((r) => [r.key as string, r.value as string]));
  const out: Record<string, string> = {};
  for (const s of decl) {
    const v = stored.get(s.key);
    // a value the file no longer offers counts as the default
    out[s.key] = v !== undefined && s.choices.some((c) => c.value === v) ? v : s.default;
  }
  return out;
}

/** The time in a chat line: the server's local time, with its zone, such as "14:32 UTC". */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
}

/**
 * The setting a cloud_from_start line names: the first one this task has away from its default, or
 * else the first declared one. The text uses its label, never a name written here.
 */
function askingSetting(db: DB, settings: Record<string, string>): TaskSetting | undefined {
  const decl = taskSettingsOf(db).settings;
  return decl.find((s) => settings[s.key] !== undefined && settings[s.key] !== s.default) ?? decl[0];
}

/** The server's text for a switch: the chat line, and the task's `cloud.text`. */
export function cloudText(db: DB, title: string, reason: CloudReason, at: number, settings: Record<string, string>): string {
  if (reason === "stalled") {
    const m = taskSettingsOf(db).stallMinutes;
    return `${title} moved to a cloud model at ${clock(at)}: the local models gave no answer for ${m} minute${m === 1 ? "" : "s"}.`;
  }
  const s = askingSetting(db, settings);
  return s ? `${title} uses a cloud model from the start, as its ${s.label} setting asks.` : `${title} uses a cloud model from the start, as its settings ask.`;
}

/** The latest switch to a cloud model for a task, or null. */
export function cloudOf(db: DB, taskId: string, title: string, settings: Record<string, string>): CloudMark | null {
  tables(db);
  const r = db.prepare("SELECT reason, at FROM task_cloud_switches WHERE task_id = ? ORDER BY n DESC LIMIT 1").get(taskId) as any;
  if (!r) return null;
  const reason = r.reason as CloudReason;
  return { since: r.at, reason, text: cloudText(db, title, reason, r.at, settings) };
}

/** What a task's JSON gains here (services.ts task()): its settings, and its latest cloud switch. */
export function taskExtras(db: DB, row: { id: string; title: string }): { settings: Record<string, string>; cloud: CloudMark | null } {
  const settings = settingsOf(db, row.id);
  return { settings, cloud: cloudOf(db, row.id, row.title, settings) };
}

/** Whether switch n of a task is recorded. */
export function hasCloudSwitch(db: DB, taskId: string, n: number): boolean {
  tables(db);
  return !!db.prepare("SELECT 1 FROM task_cloud_switches WHERE task_id = ? AND n = ?").get(taskId, n);
}

/** Records a switch. Returns false, and changes nothing, when (task, n) is already recorded. */
export function recordCloudSwitch(db: DB, taskId: string, n: number, reason: CloudReason, at = now()): boolean {
  tables(db);
  return db.prepare("INSERT OR IGNORE INTO task_cloud_switches(task_id, n, reason, at) VALUES(?,?,?,?)").run(taskId, n, reason, at).changes > 0;
}

export interface SettingChange {
  id: string;
  taskId: string;
  key: string;
  oldValue: string;
  newValue: string;
  byType: string;
  byId: string;
  at: number;
}

/** A task's setting changes, newest first. */
export function changesOf(db: DB, taskId: string): SettingChange[] {
  tables(db);
  return (db.prepare("SELECT * FROM task_setting_changes WHERE task_id = ? ORDER BY at DESC, rowid DESC").all(taskId) as any[]).map((r) => ({
    id: r.id,
    taskId: r.task_id,
    key: r.key,
    oldValue: r.old_value,
    newValue: r.new_value,
    byType: r.by_type,
    byId: r.by_id,
    at: r.at,
  }));
}

/** A request to change settings that can't be applied: the status to answer with, and why. */
export class SettingsRefusal extends Error {
  readonly status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/** Checks a change request against the declared settings: `{ "<key>": "<value>", ... }`. Throws a 400. */
export function parseChange(db: DB, body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsRefusal(400, "send the settings as an object of key to value");
  const decl = taskSettingsOf(db).settings;
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) throw new SettingsRefusal(400, "no settings given");
  for (const [k, v] of entries) {
    const s = decl.find((d) => d.key === k);
    if (!s) throw new SettingsRefusal(400, `no setting "${k.slice(0, 40)}"`);
    if (typeof v !== "string" || !s.choices.some((c) => c.value === v)) throw new SettingsRefusal(400, `"${String(v).slice(0, 40)}" isn't a choice for ${s.label}`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Applies a person's change: one change row for each key whose value changes, then the task event.
 * The caller has checked who may (the routes below). Returns the task.
 */
export function changeSettings(app: App, taskId: string, change: Record<string, string>, by: { type: "user"; id: string }, at = now()): any {
  const { db, svc } = app;
  tables(db);
  const t = svc.task(taskId);
  if (!t) throw new SettingsRefusal(404, "no such task");
  if (t.status === "done" || t.status === "cancelled") throw new SettingsRefusal(400, `the task is ${t.status === "done" ? "done" : "cancelled"}, so its settings stay as they were`);
  const current = settingsOf(db, taskId);
  const put = db.prepare("INSERT INTO task_settings(task_id, key, value) VALUES(?,?,?) ON CONFLICT(task_id, key) DO UPDATE SET value = excluded.value");
  const log = db.prepare("INSERT INTO task_setting_changes(id, task_id, key, old_value, new_value, by_type, by_id, at) VALUES(?,?,?,?,?,?,?,?)");
  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const [k, v] of Object.entries(change)) {
      if (current[k] === v) continue;
      put.run(taskId, k, v);
      log.run(id("tsc_"), taskId, k, current[k], v, by.type, by.id, at);
      changed++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const task = svc.task(taskId);
  if (changed) svc.bus.emitEvent({ type: "task", chatId: task.chatId, task });
  return task;
}

// ---------------------------------------------------------------- people's routes

interface Person {
  id: string;
  role: string;
}

/**
 * GET /api/task-settings, PUT /api/tasks/:id/settings and GET /api/tasks/:id/settings/history, behind
 * the session check. Seeing a task is the same rule as PATCH /api/tasks/:id (`seesChat`: a member of
 * its chat, an agents-only chat, or an admin). Changing a setting is for the task's creator or an
 * admin, and never on a done or cancelled task. Nothing here edits or deletes a change row.
 */
export function registerTaskSettings(api: Hono<any>, app: App, can: { isAdmin: (u: any) => boolean; seesChat: (u: any, chatId: string) => boolean }): void {
  const visibleTask = (u: Person, tid: string) => {
    const t = app.svc.task(tid);
    if (!t || !can.seesChat(u, t.chatId)) throw new SettingsRefusal(404, "no such task");
    return t;
  };
  const answer = (c: any, f: () => unknown) => {
    try {
      return c.json(f());
    } catch (e) {
      if (e instanceof SettingsRefusal) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  api.get("/api/task-settings", (c) => c.json({ settings: taskSettingsOf(app.db).settings }));
  api.get("/api/tasks/:id/settings/history", (c) =>
    answer(c, () => {
      const t = visibleTask(c.get("user"), c.req.param("id"));
      return { changes: changesOf(app.db, t.id) };
    }),
  );
  api.put("/api/tasks/:id/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    return answer(c, () => {
      const u = c.get("user") as Person;
      const t = visibleTask(u, c.req.param("id"));
      if (t.createdBy !== u.id && !can.isAdmin(u)) throw new SettingsRefusal(403, "Only the task's creator or an admin can change its settings");
      const change = parseChange(app.db, body);
      return { task: changeSettings(app, t.id, change, { type: "user", id: u.id }) };
    });
  });
}
