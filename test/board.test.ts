// SPDX-License-Identifier: AGPL-3.0-only
// The Board (server/src/board.ts, web/src/board.ts, web/src/screens/Board.tsx): every task a person
// may see, across their chats, in columns by status. The same visibility rule as GET /api/tasks, with
// no admin override; plan titles only from those chats; the filters; Done's 14-day window; and moves
// through PATCH /api/tasks/:id with its own permission check.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { boardFor, DONE_WINDOW_MS } from "../server/src/board.ts";
import { COLUMNS, cardAgent, columnOf, dropStatus, filterCount, readQuery, writeQuery } from "../web/src/board.ts";

test("columns: 2.0's six states in four columns, and where a dropped card goes", () => {
  assert.deepEqual(
    COLUMNS.map((c) => c.label),
    ["Needs you", "To do", "In progress", "Done"],
  );
  assert.equal(columnOf("checking"), "progress", "checking sits with working");
  assert.equal(columnOf("cancelled"), "done", "cancelled sits with done");
  assert.equal(dropStatus("todo", "progress"), "working");
  assert.equal(dropStatus("working", "done"), "done");
  assert.equal(dropStatus("done", "todo"), "todo");
  assert.equal(dropStatus("todo", "needs_you"), "needs_you");
  assert.equal(dropStatus("checking", "progress"), null, "already there: no move");
  assert.equal(dropStatus("cancelled", "done"), null, "a cancelled card stays cancelled in Done");
});

test("the board's address: filters in the query string, the default Done window left out", () => {
  assert.equal(writeQuery({ agent: "", chat: "", person: "", plan: "", allDone: false }), "");
  const q = { agent: "a_1", chat: "c_1", person: "u_1", plan: "plan_1", allDone: true };
  const s = writeQuery(q);
  assert.equal(s, "?agent=a_1&chat=c_1&person=u_1&plan=plan_1&done=all");
  assert.deepEqual(readQuery(s), q, "it reads back the same");
  assert.deepEqual(readQuery("?chat=c_2&done=recent"), { agent: "", chat: "c_2", person: "", plan: "", allDone: false });
  assert.equal(filterCount(readQuery("?chat=c_2&plan=p&done=all")), 2, "the Done window isn't a filter");
});

test("a card's agent: the assigned agent, else the agent that created it", () => {
  const isAgent = (id: string) => id.startsWith("a_");
  assert.equal(cardAgent({ assigneeType: "agent", assigneeId: "a_designer", createdBy: "a_writer" }, isAgent), "a_designer");
  assert.equal(cardAgent({ assigneeType: "user", assigneeId: "u_1", createdBy: "a_writer" }, isAgent), "a_writer");
  assert.equal(cardAgent({ assigneeType: "", assigneeId: "", createdBy: "u_1" }, isAgent), "");
});

async function person(h: Harness, owner: Client, name: string, email: string): Promise<{ c: Client; id: string }> {
  const r = await owner.post("/api/users", { email, name, password: "example-password-1", role: "member" });
  assert.equal(r.status, 200);
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email, password: "example-password-1" })).status, 200);
  return { c, id: r.json.user.id };
}

/** Chats, agents, people and tasks with generic names. */
async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const ownerId = (await owner.get("/api/me")).json.user.id;
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const b = await person(h, owner, "Person B", "person-b@example.com");
  const designer = await mockAgent(owner, "designer");
  const writer = await mockAgent(owner, "writer");
  const svc = h.app.svc;
  // a group Person A is in
  const shared = (await owner.post("/api/chats", { name: "acme launch", users: [a.id], agents: [designer.id] })).json.chat;
  // the owner's own chat: Person A isn't in it
  const hidden = (await owner.post("/api/chats", { name: "example-app private", agents: [writer.id] })).json.chat;
  // Person B's own chat: the owner, an admin, isn't in it
  const bOnly = (await b.c.post("/api/chats", { name: "person b notes" })).json.chat;
  // two agents talking: everyone may read it
  const agentsOnly = svc.agentsChat(designer.id, writer.id);

  const plan = (chatId: string, planId: string, title: string, agentId: string, steps: string[]) => {
    const ts = steps.map((s) => svc.createTask({ chatId, title: s, assigneeType: "agent", assigneeId: agentId, planId, createdBy: agentId }));
    svc.insertMessage({ chatId, authorType: "agent", authorId: agentId, kind: "plan", body: title, meta: { planId, steps: ts } });
    return ts;
  };
  const launch = plan(shared.id, "plan_launch", "Launch plan", designer.id, ["Draft the page", "Review the copy"]);
  const secret = plan(hidden.id, "plan_secret", "Hidden plan title", writer.id, ["Hidden step"]);
  const mine = svc.createTask({ chatId: shared.id, title: "Person A's own task", assigneeType: "user", assigneeId: a.id, createdBy: a.id });
  const byAgent = svc.createTask({ chatId: shared.id, title: "Ask Person A", assigneeType: "user", assigneeId: a.id, createdBy: designer.id });
  const between = svc.createTask({ chatId: agentsOnly, title: "Agents compare notes", assigneeType: "agent", assigneeId: writer.id, createdBy: designer.id });
  const bTask = svc.createTask({ chatId: bOnly.id, title: "Person B's private task", createdBy: b.id });
  // a task in a chat Person A may see, that names the hidden chat's plan: the title must not cross over
  const crossing = svc.createTask({ chatId: shared.id, title: "Names another chat's plan", planId: "plan_secret", createdBy: ownerId });
  return { owner, ownerId, a, b, designer, writer, shared, hidden, bOnly, agentsOnly, launch, secret, mine, byAgent, between, bTask, crossing };
}

test("a person sees only the tasks and plan titles of the chats they may see, with no admin override", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const r = await s.a.c.get("/api/board");
    assert.equal(r.status, 200);
    const ids = new Set(r.json.tasks.map((t: any) => t.id));
    for (const t of [...s.launch, s.mine, s.byAgent, s.between, s.crossing]) assert.ok(ids.has(t.id), `sees ${t.title}`);
    assert.ok(!ids.has(s.secret[0].id), "no task from a chat they aren't in");
    assert.ok(!ids.has(s.bTask.id), "no task from another person's chat");
    assert.deepEqual(r.json.plans, { plan_launch: "Launch plan" }, "plan titles only from chats they may see");
    const text = JSON.stringify(r.json);
    for (const leak of ["Hidden plan title", "Hidden step", "Person B's private task", s.hidden.id, s.bOnly.id]) assert.ok(!text.includes(leak), `nothing of ${leak}`);
    assert.deepEqual(new Set(r.json.options.chats), new Set([s.shared.id, s.agentsOnly]));

    // the same tasks as GET /api/tasks
    const listed = new Set((await s.a.c.get("/api/tasks")).json.tasks.map((t: any) => t.id));
    assert.deepEqual(ids, listed);

    // an admin's board is their own view too: not Person B's private chat
    const mine = new Set((await s.owner.get("/api/board")).json.tasks.map((t: any) => t.id));
    assert.ok(mine.has(s.secret[0].id), "the owner's own chat");
    assert.ok(!mine.has(s.bTask.id), "no admin override");
    assert.equal((await new Client(h.url).get("/api/board")).status, 401, "signed out: nothing");
  } finally {
    await h.close();
  }
});

test("moving a card: PATCH works in a chat the person may see, and is refused with 404 elsewhere", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const ok = await s.a.c.patch(`/api/tasks/${s.launch[0].id}`, { status: "working" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.task.status, "working");
    const agents = await s.a.c.patch(`/api/tasks/${s.between.id}`, { status: "done" });
    assert.equal(agents.status, 200, "an agents-only chat: anyone may see it, and move its tasks");
    const refused = await s.a.c.patch(`/api/tasks/${s.secret[0].id}`, { status: "done" });
    assert.equal(refused.status, 404);
    assert.equal(h.app.svc.task(s.secret[0].id).status, "todo", "unchanged");
    assert.equal((await s.a.c.patch(`/api/tasks/${s.launch[0].id}`, { status: "finished" })).status, 400, "only 2.0's statuses");
  } finally {
    await h.close();
  }
});

test("a task event from a chat a person can't see never reaches their socket", async () => {
  const h = await startApp();
  let ws: WebSocket | undefined;
  try {
    const s = await seed(h);
    const events: any[] = [];
    ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: s.a.c.cookie } });
    await new Promise((r, j) => {
      ws!.on("open", r);
      ws!.on("error", j);
    });
    ws.on("message", (d) => events.push(JSON.parse(String(d))));
    h.app.svc.updateTask(s.secret[0].id, { status: "working" });
    h.app.svc.updateTask(s.bTask.id, { status: "done" });
    h.app.svc.updateTask(s.launch[1].id, { status: "needs_you" });
    await waitFor(() => events.some((e) => e.type === "task" && e.task.id === s.launch[1].id), "the visible task's event");
    const tasks = events.filter((e) => e.type === "task").map((e) => e.task.id);
    assert.deepEqual(tasks, [s.launch[1].id], "only the task in a chat they may see");
    assert.ok(!JSON.stringify(events).includes("Hidden step"));
  } finally {
    ws?.terminate();
    await h.close();
  }
});

test("the filters: agent, chat, person and plan, alone and together", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const titles = async (qs: string) => new Set((await s.a.c.get(`/api/board${qs}`)).json.tasks.map((t: any) => t.title));
    const eq = async (qs: string, want: string[]) => assert.deepEqual(await titles(qs), new Set(want), qs);
    await eq(`?agent=${s.designer.id}`, ["Draft the page", "Review the copy", "Ask Person A", "Agents compare notes"]);
    await eq(`?agent=${s.writer.id}`, ["Agents compare notes"]);
    await eq(`?chat=${s.agentsOnly}`, ["Agents compare notes"]);
    await eq(`?person=${s.a.id}`, ["Person A's own task", "Ask Person A"]);
    await eq(`?person=${s.ownerId}`, ["Names another chat's plan"]);
    await eq("?plan=plan_launch", ["Draft the page", "Review the copy"]);
    await eq(`?agent=${s.designer.id}&chat=${s.shared.id}&plan=plan_launch`, ["Draft the page", "Review the copy"]);
    await eq(`?chat=${s.hidden.id}`, []);
    await eq("?plan=plan_secret", ["Names another chat's plan"]);
    // the menus offer only what's on this person's board, whatever the filter
    const r = (await s.a.c.get(`/api/board?chat=${s.agentsOnly}`)).json;
    assert.deepEqual(new Set(r.options.agents), new Set([s.designer.id, s.writer.id]));
    assert.deepEqual(new Set(r.options.people), new Set([s.a.id, s.ownerId]));
    assert.deepEqual(r.options.plans, ["plan_launch"], "a plan with no title they may see isn't offered");
  } finally {
    await h.close();
  }
});

test("Done shows the last 14 days by updated_at, and all of it on request", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const { svc, db } = h.app;
    svc.updateTask(s.launch[0].id, { status: "done" });
    svc.updateTask(s.launch[1].id, { status: "cancelled" });
    svc.updateTask(s.mine.id, { status: "done" });
    const at = Date.now();
    const age = (id: string, days: number) => db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at - days * 86400_000, id);
    age(s.launch[0].id, 20); // done, too old
    age(s.launch[1].id, 15); // cancelled, too old
    age(s.mine.id, 13); // done, in the window
    age(s.byAgent.id, 60); // still to do: old open work always shows
    const ids = (b: { tasks: any[] }) => new Set(b.tasks.map((t) => t.id));

    const recent = boardFor(h.app, s.a.id, {}, at);
    assert.equal(recent.doneSince, at - DONE_WINDOW_MS);
    assert.equal(recent.doneHidden, 2);
    assert.ok(ids(recent).has(s.mine.id));
    assert.ok(!ids(recent).has(s.launch[0].id) && !ids(recent).has(s.launch[1].id));
    assert.ok(ids(recent).has(s.byAgent.id), "an old open task stays");

    const all = boardFor(h.app, s.a.id, { done: "all" }, at);
    assert.equal(all.doneSince, 0);
    assert.equal(all.doneHidden, 0);
    for (const id of [s.launch[0].id, s.launch[1].id, s.mine.id]) assert.ok(ids(all).has(id));

    const http = (await s.a.c.get("/api/board?done=all")).json;
    assert.ok(ids(http).has(s.launch[0].id), "done=all over HTTP too");
    assert.ok(!ids((await s.a.c.get("/api/board")).json).has(s.launch[0].id), "the default over HTTP");
  } finally {
    await h.close();
  }
});

test("archived tasks leave the board", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    assert.equal((await s.a.c.post(`/api/tasks/${s.mine.id}/archive`)).status, 200);
    const ids = new Set((await s.a.c.get("/api/board")).json.tasks.map((t: any) => t.id));
    assert.ok(!ids.has(s.mine.id));
  } finally {
    await h.close();
  }
});
