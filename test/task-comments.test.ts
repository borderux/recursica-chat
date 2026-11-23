// SPDX-License-Identifier: AGPL-3.0-only
// Comments on a task (server/src/taskcomments.ts): people in the task's chat read and post them; the
// author or an admin deletes one, and its body leaves the table; every task carries commentCount; the
// task_comment event goes only to people who see the chat; a service reads them and posts as the
// agent the task belongs to; and a comment never wakes an agent. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { eventFor } from "../server/src/eventfilter.ts";
import { MAX_COMMENT } from "../server/src/taskcomments.ts";

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

/**
 * Two people and the owner (an admin) in a chat with two agents, one of them driven by a service; a
 * person outside it; a task for each agent, and a person's own task.
 */
async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const ownerId = (await owner.get("/api/me")).json.user.id;
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const b = await person(h, owner, "Person B", "person-b@example.com");
  const outsider = await person(h, owner, "Person C", "person-c@example.com");
  const designer = await mockAgent(owner, "designer");
  const writer = await mockAgent(owner, "writer");
  const db = h.app.db;
  serviceCommand(db, "service-create", ["example-service"]);
  serviceCommand(db, "service-drive", ["example-service", "designer"]);
  const service = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
  const chat = (await a.c.post("/api/chats", { name: "acme launch", users: [b.id, ownerId], agents: [designer.id, writer.id] })).json.chat;
  const svc = h.app.svc;
  const task = svc.createTask({ chatId: chat.id, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer.id, createdBy: a.id });
  const byDesigner = svc.createTask({ chatId: chat.id, title: "Pick the hero image", createdBy: designer.id });
  const writers = svc.createTask({ chatId: chat.id, title: "Review the copy", assigneeType: "agent", assigneeId: writer.id, createdBy: a.id });
  const mine = svc.createTask({ chatId: chat.id, title: "Book the venue", assigneeType: "user", assigneeId: a.id, createdBy: a.id });
  return { owner, ownerId, a, b, outsider, designer, writer, service, chat, task, byDesigner, writers, mine };
}

async function socket(h: Harness, cookie: string, sockets: WebSocket[]): Promise<any[]> {
  const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie } });
  sockets.push(ws);
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const events: any[] = [];
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  return events;
}

const rows = (h: Harness) => (h.app.db.prepare("SELECT id, task_id, author_type, author_id, body, deleted_at, deleted_by FROM task_comments ORDER BY created_at, rowid").all() as any[]).map((r) => ({ ...r }));

test("a member reads and posts: oldest first, with the author, and the task's commentCount", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    assert.equal(s.task.commentCount, 0, "a new task: no comments");
    assert.deepEqual((await s.b.c.get(`/api/tasks/${s.task.id}/comments`)).json, { comments: [] });

    const before = Date.now();
    const r = await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "  Use the blue palette.  " });
    assert.equal(r.status, 201);
    const c1 = r.json.comment;
    assert.ok(/^tcm_/.test(c1.id));
    assert.deepEqual({ ...c1, id: "", createdAt: 0 }, { id: "", taskId: s.task.id, author: { type: "user", id: s.a.id, name: "Person A" }, body: "Use the blue palette.", createdAt: 0, deleted: false });
    assert.ok(c1.createdAt >= before && c1.createdAt <= Date.now());
    const c2 = (await s.b.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Agreed.\n<b>not html</b>" })).json.comment;
    assert.equal(c2.body, "Agreed.\n<b>not html</b>", "plain text, kept as written");

    const list = await s.a.c.get(`/api/tasks/${s.task.id}/comments`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.comments.map((c: any) => [c.author.name, c.body]),
      [
        ["Person A", "Use the blue palette."],
        ["Person B", "Agreed.\n<b>not html</b>"],
      ],
      "oldest first",
    );

    // commentCount: in the task list, the board and the task itself
    assert.equal((await s.a.c.get("/api/tasks")).json.tasks.find((t: any) => t.id === s.task.id).commentCount, 2, "the task list");
    assert.equal((await s.b.c.get("/api/board")).json.tasks.find((t: any) => t.id === s.task.id).commentCount, 2, "the board");
    assert.equal(h.app.svc.task(s.mine.id).commentCount, 0, "another task's count is its own");

    // a finished task still takes comments
    for (const status of ["done", "cancelled"]) {
      h.app.svc.updateTask(s.mine.id, { status });
      assert.equal((await s.a.c.post(`/api/tasks/${s.mine.id}/comments`, { body: `Noted while ${status}.` })).status, 201, status);
    }
    assert.equal(h.app.svc.task(s.mine.id).commentCount, 2);

    // an agents-only chat: anyone who sees it, as GET /api/tasks
    const agentsChat = h.app.svc.createChat("agents", "Designer and Writer", "", [
      { type: "agent", id: s.designer.id },
      { type: "agent", id: s.writer.id },
    ]);
    const t = h.app.svc.createTask({ chatId: agentsChat, title: "Sort the notes", createdBy: s.designer.id });
    assert.equal((await s.outsider.c.post(`/api/tasks/${t.id}/comments`, { body: "Seen." })).status, 201, "an agents-only chat");
    assert.equal((await s.outsider.c.get(`/api/tasks/${t.id}/comments`)).json.comments.length, 1);
  } finally {
    await h.close();
  }
});

test("a person outside the chat gets 404 and no events; signed out is 401", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const events = await socket(h, s.outsider.c.cookie, sockets);
    assert.equal((await s.outsider.c.get(`/api/tasks/${s.task.id}/comments`)).status, 404);
    assert.equal((await s.outsider.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Hello" })).status, 404);
    assert.equal((await s.outsider.c.post(`/api/tasks/${s.task.id}/comments`, { body: "" })).status, 404, "404 before the body is read");
    assert.equal((await s.outsider.c.get(`/api/tasks/t_no_such_task/comments`)).status, 404);
    assert.equal((await new Client(h.url).get(`/api/tasks/${s.task.id}/comments`)).status, 401, "signed out");
    assert.deepEqual(rows(h), [], "nothing stored");

    const cid = (await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "For the chat only." })).json.comment.id;
    assert.equal((await s.outsider.c.del(`/api/tasks/${s.task.id}/comments/${cid}`)).status, 404, "can't delete what it can't see");
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${cid}`)).status, 204);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      events.filter((e) => e.type !== "hello" && e.type !== "agent_status"),
      [],
      "no task_comment or task event reaches someone outside the chat",
    );
    assert.ok(!JSON.stringify(events).includes("For the chat only."));
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("an archived task, or a task in an archived chat, is 404", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Before the archive." })).status, 201);
    const cid = rows(h)[0].id;
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/archive`)).status, 200);
    assert.equal((await s.a.c.get(`/api/tasks/${s.task.id}/comments`)).status, 404, "read");
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "After." })).status, 404, "post");
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${cid}`)).status, 404, "delete");
    assert.equal((await s.owner.get(`/api/tasks/${s.task.id}/comments`)).status, 404, "an admin too");
    assert.equal((await s.service("GET", `/api/service/tasks/${s.task.id}/comments`)).status, 404, "the service too");
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/restore`)).status, 200);
    assert.equal((await s.a.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments.length, 1, "restored: the comments are still there");

    assert.equal((await s.a.c.post(`/api/chats/${s.chat.id}/archive`)).status, 200);
    assert.equal((await s.a.c.get(`/api/tasks/${s.mine.id}/comments`)).status, 404, "a task in an archived chat");
    assert.equal((await s.a.c.post(`/api/tasks/${s.mine.id}/comments`, { body: "Hello" })).status, 404);
  } finally {
    await h.close();
  }
});

test("the body: trimmed, 1 to 4000 characters, as text", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const post = (body: unknown) => s.a.c.post(`/api/tasks/${s.task.id}/comments`, body);
    assert.equal(MAX_COMMENT, 4000);
    for (const bad of [{}, { body: "" }, { body: "   \n\t " }, { body: 42 }, { body: null }, { body: "x".repeat(4001) }]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
      assert.equal(typeof r.json.error, "string");
    }
    const notJson = await fetch(`${h.url}/api/tasks/${s.task.id}/comments`, { method: "POST", headers: { "content-type": "application/json", origin: h.url, cookie: s.a.c.cookie }, body: "{not json" });
    assert.equal(notJson.status, 400);
    assert.deepEqual(rows(h), [], "nothing stored");
    assert.equal((await post({ body: "x" })).status, 201, "one character");
    assert.equal((await post({ body: "y".repeat(4000) })).status, 201, "4000 characters");
    assert.equal((await post({ body: `  ${"z".repeat(4000)}  ` })).json.comment.body.length, 4000, "4000 after trimming");
  } finally {
    await h.close();
  }
});

test("only the author or an admin deletes, and a deleted comment's body is gone from the table", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const mineA = (await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "A secret plan." })).json.comment;
    const mineB = (await s.b.c.post(`/api/tasks/${s.task.id}/comments`, { body: "A second thought." })).json.comment;
    assert.equal(h.app.svc.task(s.task.id).commentCount, 2);

    const other = await s.b.c.del(`/api/tasks/${s.task.id}/comments/${mineA.id}`);
    assert.equal(other.status, 403, "another member");
    assert.match(other.json.error, /author or an admin/);
    assert.equal((await s.a.c.del(`/api/tasks/${s.mine.id}/comments/${mineA.id}`)).status, 404, "not on that task");
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/tcm_none`)).status, 404, "no such comment");

    const del = await s.a.c.del(`/api/tasks/${s.task.id}/comments/${mineA.id}`);
    assert.equal(del.status, 204, "the author");
    assert.equal(del.json, "");
    const row = rows(h).find((r) => r.id === mineA.id);
    assert.equal(row.body, "", "the body is cleared in the table");
    assert.equal(row.deleted_by, s.a.id);
    assert.ok(row.deleted_at > 0);
    assert.ok(!JSON.stringify(h.app.db.prepare("SELECT * FROM task_comments").all()).includes("A secret plan."), "nowhere in the table");
    const listed = (await s.b.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments;
    assert.deepEqual(
      listed.map((c: any) => [c.id, c.deleted, c.body, c.author.name]),
      [
        [mineA.id, true, "", "Person A"],
        [mineB.id, false, "A second thought.", "Person B"],
      ],
      "it stays in the list, with no body",
    );
    assert.equal(h.app.svc.task(s.task.id).commentCount, 1, "commentCount leaves deleted ones out");
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${mineA.id}`)).status, 204, "again: no change");

    // an admin (the owner, in the chat) deletes anyone's, and an agent's
    assert.equal((await s.owner.del(`/api/tasks/${s.task.id}/comments/${mineB.id}`)).status, 204, "an admin");
    assert.equal(rows(h).find((r) => r.id === mineB.id).deleted_by, s.ownerId);
    const agents = (await s.service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "Started on it." })).json.comment;
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${agents.id}`)).status, 403, "a member can't delete an agent's");
    assert.equal((await s.owner.del(`/api/tasks/${s.task.id}/comments/${agents.id}`)).status, 204, "an admin can");
    assert.equal(h.app.svc.task(s.task.id).commentCount, 0);
  } finally {
    await h.close();
  }
});

test("events: task_comment, then task with commentCount, to the people in the chat", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const events = await socket(h, s.b.c.cookie, sockets);
    const c = (await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Live, please." })).json.comment;
    await waitFor(() => events.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.commentCount === 1), "the task event with commentCount");
    const ce = events.find((e) => e.type === "task_comment");
    assert.deepEqual(ce, { type: "task_comment", chatId: s.chat.id, taskId: s.task.id, comment: c });
    assert.ok(events.indexOf(ce) < events.findIndex((e) => e.type === "task" && e.task.commentCount === 1), "the comment first, then the task");

    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${c.id}`)).status, 204);
    await waitFor(() => events.some((e) => e.type === "task_comment" && e.comment.id === c.id && e.comment.deleted), "the deleted comment's event");
    const gone = events.find((e) => e.type === "task_comment" && e.comment.deleted);
    assert.equal(gone.comment.body, "", "with no body");
    await waitFor(() => events.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.commentCount === 0), "commentCount back to 0");
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("the event filter: a task_comment goes by its chat, like a task", () => {
  const e = { type: "task_comment" as const, chatId: "c_1", taskId: "t_1", comment: { body: "Hello" } };
  const viewer = (chats: string[], isAdmin = false) => ({ userId: "u_1", isAdmin, seesChat: (cid: string) => chats.includes(cid) });
  assert.deepEqual(eventFor(e, viewer(["c_1"])), e, "a person who sees the chat");
  assert.equal(eventFor(e, viewer(["c_2"])), null, "one who doesn't");
  assert.equal(eventFor(e, viewer([], true)), null, "an admin outside the chat, as the socket's seesChat says");
  const task = { type: "task" as const, chatId: "c_1", task: {} };
  for (const chats of [["c_1"], ["c_2"]]) assert.equal(eventFor(e, viewer(chats)) === null, eventFor(task, viewer(chats)) === null, "the same answer as a task event");
});

test("service routes: read, and post as the driven agent the task belongs to; only a driven agent's task", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    // the service's own socket carries task_comment for its chats
    const tok = serviceCommand(h.app.db, "service-token", ["example-service"]).stdout ?? "";
    const service = svcCall(h, tok);
    const ws = new WebSocket(h.url.replace("http", "ws") + "/ws/service", { headers: { authorization: `Bearer ${tok}` } });
    sockets.push(ws);
    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));

    await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Use the blue palette." });
    const read = await service("GET", `/api/service/tasks/${s.task.id}/comments`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.comments.map((c: any) => [c.author.type, c.author.name, c.body]), [["user", "Person A", "Use the blue palette."]]);

    const assigned = await service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "On it." });
    assert.equal(assigned.status, 201);
    assert.deepEqual(assigned.json.comment.author, { type: "agent", id: s.designer.id, name: "Designer" }, "assigned to the driven agent");
    const created = await service("POST", `/api/service/tasks/${s.byDesigner.id}/comments`, { body: "I made this one." });
    assert.equal(created.status, 201);
    assert.equal(created.json.comment.author.id, s.designer.id, "created by the driven agent");
    assert.equal(rows(h).filter((r) => r.author_type === "agent").length, 2);

    const writers = await service("POST", `/api/service/tasks/${s.writers.id}/comments`, { body: "Not mine." });
    assert.equal(writers.status, 403, "another agent's task");
    assert.equal((await service("POST", `/api/service/tasks/${s.mine.id}/comments`, { body: "Not mine." })).status, 403, "a person's task");
    assert.equal((await service("GET", `/api/service/tasks/${s.writers.id}/comments`)).status, 200, "it reads any task in its chats");
    assert.equal((await service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: " " })).status, 400, "the same limits");
    assert.equal((await service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "x".repeat(4001) })).status, 400);

    // outside its chats: 404
    const elsewhere = (await s.outsider.c.post("/api/chats", { name: "person c notes" })).json.chat;
    const hidden = h.app.svc.createTask({ chatId: elsewhere.id, title: "A private task", assigneeType: "agent", assigneeId: s.designer.id, createdBy: s.outsider.id });
    assert.equal((await service("GET", `/api/service/tasks/${hidden.id}/comments`)).status, 404);
    assert.equal((await service("POST", `/api/service/tasks/${hidden.id}/comments`, { body: "Hello" })).status, 404);
    assert.equal((await svcCall(h, "wrong-token")("GET", `/api/service/tasks/${s.task.id}/comments`)).status, 401, "a bad token");

    // the people's API shows the agent's comment
    assert.ok((await s.b.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments.some((c: any) => c.author.type === "agent" && c.body === "On it."));
    await waitFor(() => events.some((e) => e.type === "task_comment" && e.comment.body === "On it."), "the service's socket gets the event");
    assert.ok(!events.some((e) => e.type === "task_comment" && e.chatId === elsewhere.id));
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("a comment never wakes an agent and never posts a chat message", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const count = (table: string) => (h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    const messages = count("messages");
    const deliveries = count("deliveries");
    const requests = count("service_requests");
    assert.equal((await s.a.c.post(`/api/tasks/${s.writers.id}/comments`, { body: "@writer can you look at this?" })).status, 201);
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "@designer please start" })).status, 201);
    assert.equal((await s.service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "@writer over to you" })).status, 201);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(count("messages"), messages, "no chat message");
    assert.equal(count("deliveries"), deliveries, "no delivery: no agent wakes");
    assert.equal(count("service_requests"), requests, "no request to the service");
    assert.equal(h.app.runtime.statusOf(s.writer.id).state, "sleeping", "the writer never started");
  } finally {
    await h.close();
  }
});
