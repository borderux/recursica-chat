// SPDX-License-Identifier: AGPL-3.0-only
// Who set a task's status (server/src/taskstatusby.ts): a person's change through PATCH /api/tasks/:id
// is recorded, and every task JSON carries `statusBy` while that status stands. Agents' tools and the
// service route never write it, and a later change by either makes it null. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { recordStatusBy, statusByOf } from "../server/src/taskstatusby.ts";

const svcCall = (h: Harness, t: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(h.url + path, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
};

async function person(h: Harness, owner: Client, name: string, email: string): Promise<{ c: Client; id: string }> {
  const r = await owner.post("/api/users", { email, name, password: "example-password-1", role: "member" });
  assert.equal(r.status, 200);
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email, password: "example-password-1" })).status, 200);
  return { c, id: r.json.user.id };
}

/** Two people in a chat with an agent a service drives, one person outside it, and two of the agent's tasks. */
async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const b = await person(h, owner, "Person B", "person-b@example.com");
  const outsider = await person(h, owner, "Person C", "person-c@example.com");
  const designer = await mockAgent(owner, "designer");
  const db = h.app.db;
  serviceCommand(db, "service-create", ["example-service"]);
  serviceCommand(db, "service-drive", ["example-service", "designer"]);
  const service = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
  const chat = (await a.c.post("/api/chats", { name: "acme launch", users: [b.id], agents: [designer.id] })).json.chat;
  const make = (title: string) => h.app.svc.createTask({ chatId: chat.id, title, assigneeType: "agent", assigneeId: designer.id, createdBy: designer.id });
  return { owner, a, b, outsider, designer, service, chat, task: make("Part 1 of 2"), other: make("Part 2 of 2") };
}

const rows = (h: Harness) =>
  (h.app.db.prepare("SELECT task_id, status, by_type, by_id FROM task_status_by ORDER BY task_id").all() as any[]).map((r) => ({ ...r }));

test("a person's cancel records them: in the answer, the task list, the board and the task event", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: s.b.c.cookie } });
    sockets.push(ws);
    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));

    assert.equal(s.task.statusBy, null, "a new task: no one set its status");
    const before = Date.now();
    const r = await s.a.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" });
    assert.equal(r.status, 200);
    assert.equal(r.json.task.status, "cancelled");
    const by = r.json.task.statusBy;
    assert.deepEqual({ ...by, at: 0 }, { type: "user", id: s.a.id, name: "Person A", at: 0 });
    assert.ok(by.at >= before && by.at <= Date.now(), "when");

    assert.deepEqual((await s.b.c.get("/api/tasks")).json.tasks.find((t: any) => t.id === s.task.id).statusBy, by, "the task list");
    assert.deepEqual((await s.b.c.get("/api/board")).json.tasks.find((t: any) => t.id === s.task.id)?.statusBy, by, "the board");
    await waitFor(() => events.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.statusBy?.id === s.a.id), "the task event with statusBy");
    assert.deepEqual(rows(h), [{ task_id: s.task.id, status: "cancelled", by_type: "user", by_id: s.a.id }], "one row");

    // no change of status: nothing new recorded
    const title = await s.b.c.patch(`/api/tasks/${s.task.id}`, { title: "Part 1 of 2, renamed" });
    assert.equal(title.status, 200);
    assert.deepEqual(title.json.task.statusBy, by, "a title change keeps it");
    assert.equal((await s.b.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).json.task.statusBy.id, s.a.id, "the same status again changes no one");

    // a new change by a person replaces the row (a person's own task, which anyone in the chat may move)
    const mine = (await s.a.c.post("/api/tasks", { chatId: s.chat.id, title: "Check the notes" })).json.task;
    assert.equal((await s.a.c.patch(`/api/tasks/${mine.id}`, { status: "working" })).json.task.statusBy.id, s.a.id);
    const next = await s.b.c.patch(`/api/tasks/${mine.id}`, { status: "done" });
    assert.equal(next.json.task.statusBy.id, s.b.id);
    assert.equal(next.json.task.statusBy.name, "Person B");
    assert.deepEqual(
      rows(h).filter((r) => r.task_id === mine.id),
      [{ task_id: mine.id, status: "done", by_type: "user", by_id: s.b.id }],
      "still one row, replaced",
    );

    // a refused change records nothing
    const fresh = (await s.a.c.post("/api/tasks", { chatId: s.chat.id, title: "Tidy the list" })).json.task;
    assert.equal((await s.a.c.patch(`/api/tasks/${fresh.id}`, { status: "lost" })).status, 400);
    assert.equal(h.app.svc.task(fresh.id).statusBy, null);
    assert.equal(rows(h).filter((r) => r.task_id === fresh.id).length, 0);
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("an agent's or a service's later change makes statusBy null, and neither writes it", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    assert.equal((await s.a.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).json.task.statusBy.id, s.a.id);

    // the agent's task_update tool calls updateTask
    assert.equal(h.app.svc.updateTask(s.task.id, { status: "todo" }).statusBy, null, "the agent moved it");
    assert.equal((await s.a.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).json.task.statusBy.id, s.a.id);
    const moved = await s.service("PATCH", `/api/service/tasks/${s.task.id}`, { status: "working" });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.task.statusBy, null, "the service moved it");
    assert.equal((await s.a.c.get("/api/tasks")).json.tasks.find((t: any) => t.id === s.task.id).statusBy, null);

    // neither records: the row is still the person's cancel
    assert.equal((await s.service("PATCH", `/api/service/tasks/${s.other.id}`, { status: "cancelled" })).json.task.statusBy, null);
    h.app.svc.updateTask(s.other.id, { status: "done" });
    assert.deepEqual(rows(h), [{ task_id: s.task.id, status: "cancelled", by_type: "user", by_id: s.a.id }]);
  } finally {
    await h.close();
  }
});

test("the service's task routes carry statusBy", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const by = (await s.a.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).json.task.statusBy;
    const list = await s.service("GET", `/api/service/chats/${s.chat.id}/tasks`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.tasks.map((t: any) => [t.title, t.status, t.statusBy]),
      [
        ["Part 1 of 2", "cancelled", by],
        ["Part 2 of 2", "todo", null],
      ],
    );
    const progress = await s.service("PATCH", `/api/service/tasks/${s.task.id}`, { progress: "" });
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.json.task.statusBy, by, "a change that leaves the status keeps it");
  } finally {
    await h.close();
  }
});

test("a person outside the chat records nothing and gets nothing", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: s.outsider.c.cookie } });
    sockets.push(ws);
    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));

    assert.equal((await s.outsider.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).status, 404);
    assert.equal(h.app.svc.task(s.task.id).status, "todo");
    assert.deepEqual(rows(h), [], "nothing recorded");
    assert.equal((await new Client(h.url).patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).status, 401, "signed out");

    assert.equal((await s.a.c.patch(`/api/tasks/${s.task.id}`, { status: "cancelled" })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      events.filter((e) => e.type !== "hello" && e.type !== "agent_status"),
      [],
      "no task event reaches someone outside the chat",
    );
    assert.equal((await s.outsider.c.get("/api/tasks")).json.tasks.length, 0);
    assert.ok(!JSON.stringify(await s.outsider.c.get("/api/board")).includes("Person A"));
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("recordStatusBy, for another people's route: replaces the row; a missing account means null", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    recordStatusBy(h.app.db, s.task.id, "todo", s.b.id, 1000);
    assert.deepEqual(h.app.svc.task(s.task.id).statusBy, { type: "user", id: s.b.id, name: "Person B", at: 1000 });
    recordStatusBy(h.app.db, s.task.id, "todo", "u_gone", 2000);
    assert.equal(statusByOf(h.app.db, { id: s.task.id, status: "todo" }), null, "no such person: null");
    assert.equal(rows(h).length, 1);
  } finally {
    await h.close();
  }
});
