// SPDX-License-Identifier: AGPL-3.0-only
// Per-task settings (server/src/tasksettings.ts, web/src/tasksettings.ts): the install's settings file
// and its checks, defaults filled in, who may change a setting, the append-only history, and the task
// events following the socket's visibility rule. Generic settings only: speed, fast and slow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { loadTaskSettings, parseTaskSettings, taskSettingsOf, useTaskSettings, NO_SETTINGS, recordCloudSwitch } from "../server/src/tasksettings.ts";
import { canChangeSettings, choiceLabel, cloudSince, describeChange } from "../web/src/tasksettings.ts";

const SPEED = {
  key: "speed",
  label: "Speed",
  default: "slow",
  choices: [
    { value: "fast", label: "Fast" },
    { value: "slow", label: "Slow" },
  ],
};
const SIZE = {
  key: "size",
  label: "Size",
  default: "m",
  choices: [
    { value: "s", label: "Small" },
    { value: "m", label: "Medium" },
    { value: "l", label: "Large" },
  ],
};
const FILE = { settings: [SPEED, SIZE], stall_minutes: 20 };

test("the settings file: checked, and a bad one means no settings", () => {
  const ok = parseTaskSettings(FILE);
  assert.deepEqual(ok.settings.map((s) => s.key), ["speed", "size"]);
  assert.equal(ok.stallMinutes, 20);
  assert.equal(parseTaskSettings({ settings: [SPEED] }).stallMinutes, 15, "the stall wait defaults to 15 minutes");
  assert.deepEqual(parseTaskSettings({ settings: [] }).settings, []);

  const bad: [string, unknown][] = [
    ["not an object", []],
    ["no settings list", {}],
    ["unknown top field", { settings: [SPEED], extra: 1 }],
    ["key with capitals", { settings: [{ ...SPEED, key: "Speed" }] }],
    ["key too long", { settings: [{ ...SPEED, key: "k".repeat(41) }] }],
    ["value with a dash", { settings: [{ ...SPEED, default: "fast", choices: [{ value: "fast", label: "Fast" }, { value: "very-slow", label: "Slow" }] }] }],
    ["label too long", { settings: [{ ...SPEED, label: "L".repeat(81) }] }],
    ["choice label too long", { settings: [{ ...SPEED, choices: [{ value: "fast", label: "F".repeat(81) }, { value: "slow", label: "Slow" }] }] }],
    ["one choice", { settings: [{ ...SPEED, default: "fast", choices: [{ value: "fast", label: "Fast" }] }] }],
    ["eleven choices", { settings: [{ ...SPEED, default: "c0", choices: Array.from({ length: 11 }, (_, i) => ({ value: `c${i}`, label: `C${i}` })) }] }],
    ["default not a choice", { settings: [{ ...SPEED, default: "medium" }] }],
    ["duplicate key", { settings: [SPEED, SPEED] }],
    ["duplicate value", { settings: [{ ...SPEED, choices: [{ value: "slow", label: "A" }, { value: "slow", label: "B" }] }] }],
    ["stall minutes not whole", { settings: [SPEED], stall_minutes: 1.5 }],
  ];
  for (const [why, raw] of bad) assert.throws(() => parseTaskSettings(raw), Error, why);
  assert.ok(parseTaskSettings({ settings: [{ ...SPEED, label: "L".repeat(80) }] }), "80 characters is fine");

  const dir = mkdtempSync(join(tmpdir(), "cc-ts-"));
  try {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    assert.equal(loadTaskSettings({}, log), NO_SETTINGS, "unset: none");
    assert.equal(logs.length, 0, "unset logs nothing");
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(FILE));
    assert.equal(loadTaskSettings({ CIRCLECHAT_TASK_SETTINGS_FILE: good }, log).settings.length, 2);
    assert.equal(logs.length, 0);
    for (const [name, text] of [
      ["broken.json", "{ not json"],
      ["wrong.json", JSON.stringify({ settings: [{ ...SPEED, default: "medium" }] })],
    ]) {
      logs.length = 0;
      const f = join(dir, name);
      writeFileSync(f, text);
      assert.equal(loadTaskSettings({ CIRCLECHAT_TASK_SETTINGS_FILE: f }, log), NO_SETTINGS, `${name}: no settings`);
      assert.equal(logs.length, 1, `${name}: one error`);
      assert.match(logs[0], /can't be used/);
    }
    logs.length = 0;
    assert.equal(loadTaskSettings({ CIRCLECHAT_TASK_SETTINGS_FILE: join(dir, "missing.json") }, log), NO_SETTINGS);
    assert.equal(logs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the web app's helpers: who may change, labels, the cloud mark, a change's line", () => {
  const me = { id: "u_1", role: "member" };
  assert.equal(canChangeSettings({ createdBy: "u_1", status: "todo" }, me), true, "the creator");
  assert.equal(canChangeSettings({ createdBy: "u_2", status: "todo" }, me), false, "another member");
  assert.equal(canChangeSettings({ createdBy: "u_2", status: "todo" }, { id: "u_1", role: "admin" }), true, "an admin");
  assert.equal(canChangeSettings({ createdBy: "u_2", status: "todo" }, { id: "u_1", role: "owner" }), true, "an owner");
  assert.equal(canChangeSettings({ createdBy: "u_1", status: "done" }, me), false, "not once done");
  assert.equal(canChangeSettings({ createdBy: "u_1", status: "cancelled" }, me), false, "nor cancelled");
  const s = parseTaskSettings(FILE).settings;
  assert.equal(choiceLabel(s[0], "fast"), "Fast");
  assert.equal(choiceLabel(s[0], "gone"), "gone", "an unknown value shows as it is");
  const at = new Date(2026, 10, 23, 14, 32).getTime();
  assert.equal(cloudSince(at, at + 60_000), "Cloud since 14:32");
  assert.match(cloudSince(at, at + 3 * 86400_000), /^Cloud since .+ 14:32$/, "another day names the day");
  assert.equal(describeChange(s, { key: "speed", oldValue: "slow", newValue: "fast" }), "Speed: Slow to Fast");
});

async function person(h: Harness, owner: Client, name: string, email: string, role = "member"): Promise<{ c: Client; id: string }> {
  const r = await owner.post("/api/users", { email, name, password: "example-password-1", role });
  assert.equal(r.status, 200);
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email, password: "example-password-1" })).status, 200);
  return { c, id: r.json.user.id };
}

async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const ownerId = (await owner.get("/api/me")).json.user.id;
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const b = await person(h, owner, "Person B", "person-b@example.com");
  const c = await person(h, owner, "Person C", "person-c@example.com");
  const admin = await person(h, owner, "Person D", "person-d@example.com", "admin");
  const designer = await mockAgent(owner, "designer");
  const shared = (await a.c.post("/api/chats", { name: "acme launch", users: [b.id], agents: [designer.id] })).json.chat;
  const task = (await a.c.post("/api/tasks", { chatId: shared.id, title: "Draft the page" })).json.task;
  const byAgent = h.app.svc.createTask({ chatId: shared.id, title: "Review the copy", assigneeType: "agent", assigneeId: designer.id, createdBy: designer.id });
  return { owner, ownerId, a, b, c, admin, designer, shared, task, byAgent };
}

test("with no settings file, a task's JSON gains only empty settings and no cloud", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const t = (await s.a.c.get("/api/tasks")).json.tasks.find((x: any) => x.id === s.task.id);
    assert.deepEqual(t.settings, {});
    assert.equal(t.cloud, null);
    const keys = Object.keys(t).sort();
    assert.deepEqual(keys, ["archivedAt", "archivedBy", "assigneeId", "assigneeType", "chatId", "cloud", "commentCount", "createdAt", "createdBy", "id", "planId", "progress", "settings", "status", "statusBy", "title", "updatedAt"]);
    assert.deepEqual((await s.a.c.get("/api/task-settings")).json, { settings: [] });
    const r = await s.a.c.put(`/api/tasks/${s.task.id}/settings`, { speed: "fast" });
    assert.equal(r.status, 400, "no such setting");
  } finally {
    await h.close();
  }
});

test("settings from the file: defaults filled in on every task, on the board and the task list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ts-"));
  const f = join(dir, "settings.json");
  writeFileSync(f, JSON.stringify(FILE));
  process.env.CIRCLECHAT_TASK_SETTINGS_FILE = f;
  const h = await startApp();
  taskSettingsOf(h.app.db); // read at start, as index.ts does
  delete process.env.CIRCLECHAT_TASK_SETTINGS_FILE;
  try {
    const s = await seed(h);
    const decl = (await s.a.c.get("/api/task-settings")).json.settings;
    assert.deepEqual(decl.map((d: any) => d.key), ["speed", "size"]);
    const listed = (await s.a.c.get("/api/tasks")).json.tasks.find((x: any) => x.id === s.task.id);
    assert.deepEqual(listed.settings, { speed: "slow", size: "m" });
    assert.equal(listed.cloud, null);
    const board = (await s.a.c.get("/api/board")).json.tasks.find((x: any) => x.id === s.task.id);
    assert.deepEqual(board.settings, { speed: "slow", size: "m" }, "the board's tasks too");
    // a stored value the file no longer offers counts as the default
    h.app.db.prepare("INSERT INTO task_settings(task_id, key, value) VALUES(?,?,?)").run(s.task.id, "size", "xl");
    assert.deepEqual(h.app.svc.task(s.task.id).settings, { speed: "slow", size: "m" });
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing a setting: the creator and an admin may; others get 403, non-members 404, bad input 400", async () => {
  const h = await startApp();
  useTaskSettings(h.app.db, parseTaskSettings(FILE));
  try {
    const s = await seed(h);
    const path = `/api/tasks/${s.task.id}/settings`;
    const mine = await s.a.c.put(path, { speed: "fast" });
    assert.equal(mine.status, 200, "the creator");
    assert.deepEqual(mine.json.task.settings, { speed: "fast", size: "m" });
    const adm = await s.admin.c.put(path, { size: "l" });
    assert.equal(adm.status, 200, "an admin, though not in the chat");
    const own = await s.owner.put(path, { size: "s" });
    assert.equal(own.status, 200, "the owner");
    const other = await s.b.c.put(path, { speed: "slow" });
    assert.equal(other.status, 403, "a member of the chat who didn't create it");
    assert.match(other.json.error, /creator or an admin/);
    assert.equal((await s.c.c.put(path, { speed: "slow" })).status, 404, "not in the chat");
    assert.equal((await s.a.c.put("/api/tasks/t_nope/settings", { speed: "slow" })).status, 404, "no such task");
    assert.equal((await s.a.c.put(path, { colour: "red" })).status, 400, "unknown key");
    assert.equal((await s.a.c.put(path, { speed: "medium" })).status, 400, "unknown value");
    assert.equal((await s.a.c.put(path, { speed: 1 })).status, 400, "not text");
    assert.equal((await s.a.c.put(path, {})).status, 400, "nothing");
    assert.equal((await s.a.c.put(path, ["speed"])).status, 400, "not an object");
    assert.equal((await s.a.c.put(path, { speed: "slow", colour: "red" })).status, 400, "one bad key refuses the lot");
    assert.equal(h.app.svc.task(s.task.id).settings.speed, "fast", "unchanged by refused requests");
    // an agent's task: only an admin, as its creator is the agent
    assert.equal((await s.a.c.put(`/api/tasks/${s.byAgent.id}/settings`, { speed: "fast" })).status, 403);
    assert.equal((await s.owner.put(`/api/tasks/${s.byAgent.id}/settings`, { speed: "fast" })).status, 200);
    assert.equal((await new Client(h.url).put(path, { speed: "slow" })).status, 401, "signed out");

    for (const status of ["done", "cancelled"]) {
      h.app.svc.updateTask(s.task.id, { status });
      const r = await s.a.c.put(path, { speed: "slow" });
      assert.equal(r.status, 400, `a ${status} task`);
      assert.equal(h.app.svc.task(s.task.id).settings.speed, "fast");
    }
  } finally {
    await h.close();
  }
});

test("each change writes a history row with who and when; nothing edits or deletes history", async () => {
  const h = await startApp();
  useTaskSettings(h.app.db, parseTaskSettings(FILE));
  try {
    const s = await seed(h);
    const path = `/api/tasks/${s.task.id}/settings`;
    const before = Date.now();
    await s.a.c.put(path, { speed: "fast", size: "l" });
    await s.a.c.put(path, { speed: "fast" }); // no change: no row
    await s.admin.c.put(path, { speed: "slow" });
    const hist = await s.b.c.get(`${path}/history`);
    assert.equal(hist.status, 200, "anyone who can see the chat");
    const rows = hist.json.changes;
    assert.equal(rows.length, 3, "one row per changed key");
    assert.deepEqual(
      rows.map((r: any) => [r.key, r.oldValue, r.newValue, r.byType, r.byId]),
      [
        ["speed", "fast", "slow", "user", s.admin.id],
        ["size", "m", "l", "user", s.a.id],
        ["speed", "slow", "fast", "user", s.a.id],
      ],
      "newest first",
    );
    for (const r of rows) assert.ok(r.at >= before && r.at <= Date.now(), "when");
    assert.equal((await s.c.c.get(`${path}/history`)).status, 404, "not in the chat");

    // no route edits or deletes history
    for (const [m, p] of [
      ["DELETE", `${path}/history`],
      ["PUT", `${path}/history`],
      ["PATCH", `${path}/history`],
      ["POST", `${path}/history`],
      ["DELETE", path],
      ["DELETE", `${path}/history/${rows[0].id}`],
      ["PATCH", `${path}/history/${rows[0].id}`],
    ])
      assert.ok([404, 405].includes((await s.owner.req(m, p, m === "DELETE" ? undefined : {})).status), `${m} ${p}`);
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM task_setting_changes").get() as any).n, 3, "all rows still there");
    assert.throws(() => h.app.db.prepare("UPDATE task_setting_changes SET new_value = 'fast'").run(), /append-only/, "the table refuses edits");
    recordCloudSwitch(h.app.db, s.task.id, 1, "stalled");
    assert.equal(recordCloudSwitch(h.app.db, s.task.id, 1, "cloud_from_start"), false, "one row per (task, n)");
    assert.throws(() => h.app.db.prepare("UPDATE task_cloud_switches SET reason = 'cloud_from_start'").run(), /append-only/);
  } finally {
    await h.close();
  }
});

test("a setting changed, and a switch to a cloud model, reach the sockets of those who can see the chat only", async () => {
  const h = await startApp();
  useTaskSettings(h.app.db, parseTaskSettings(FILE));
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const listen = async (c: Client) => {
      const events: any[] = [];
      const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: c.cookie } });
      sockets.push(ws);
      await new Promise((r, j) => {
        ws.on("open", r);
        ws.on("error", j);
      });
      ws.on("message", (d) => events.push(JSON.parse(String(d))));
      return events;
    };
    const inChat = await listen(s.b.c);
    const outside = await listen(s.c.c);
    assert.equal((await s.a.c.put(`/api/tasks/${s.task.id}/settings`, { speed: "fast" })).status, 200);
    await waitFor(() => inChat.some((e) => e.type === "task" && e.task.settings?.speed === "fast"), "the member's event");
    recordCloudSwitch(h.app.db, s.task.id, 1, "stalled");
    h.app.bus.emitEvent({ type: "task", chatId: s.shared.id, task: h.app.svc.task(s.task.id) });
    await waitFor(() => inChat.some((e) => e.type === "task" && e.task.cloud?.reason === "stalled"), "the cloud mark's event");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      outside.filter((e) => e.type !== "hello" && e.type !== "agent_status"),
      [],
      "a non-member gets nothing",
    );
    assert.ok(!JSON.stringify(outside).includes("Draft the page"));
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});
