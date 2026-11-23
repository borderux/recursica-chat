// SPDX-License-Identifier: AGPL-3.0-only
// Agents' tools for task comments (server/src/taskcomments.ts taskCommentTools): task_comments reads a
// task's comments and task_comment posts one as the agent, only for a task in a chat the agent is in,
// with the people's limits. The comment's event goes out, it shows in the people's API, and it wakes no
// one. Both are core tools, on by default like attach_files. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { addComment, deleteComment } from "../server/src/taskcomments.ts";

async function person(h: Harness, owner: Client, name: string, email: string): Promise<{ c: Client; id: string }> {
  const r = await owner.post("/api/users", { email, name, password: "example-password-1", role: "member" });
  assert.equal(r.status, 200);
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email, password: "example-password-1" })).status, 200);
  return { c, id: r.json.user.id };
}

/** A person and two agents in a chat, a third agent outside it, and a second chat the designer is in. */
async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const designer = await mockAgent(owner, "designer");
  const writer = await mockAgent(owner, "writer");
  const outsider = await mockAgent(owner, "researcher");
  const chat = (await a.c.post("/api/chats", { name: "acme launch", agents: [designer.id, writer.id] })).json.chat;
  const other = (await a.c.post("/api/chats", { name: "example-app", agents: [designer.id] })).json.chat;
  const task = h.app.svc.createTask({ chatId: chat.id, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer.id, createdBy: a.id });
  const ctx = (agent: any, chatId = chat.id) => ({ agent: h.app.svc.agent(agent.id)!, chatId, requester: { type: "user" as const, id: a.id } });
  return { owner, a, designer, writer, outsider, chat, other, task, ctx };
}

test("both are core tools, on by default, for every agent", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    for (const ag of [s.designer, s.outsider]) {
      const tools = await h.app.gateway.toolsFor(s.ctx(ag));
      for (const name of ["task_comments", "task_comment"]) {
        const t = tools.find((x) => x.name === name);
        assert.ok(t, `${name} for @${ag.handle}`);
        assert.equal(t.category, "core");
      }
    }
  } finally {
    await h.close();
  }
});

test("task_comments: a task's comments, oldest first, in any chat the agent is in", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const empty = await h.app.gateway.call("task_comments", { task_id: s.task.id }, s.ctx(s.writer));
    assert.deepEqual(empty, { text: `Comments on "Draft the landing page" (${s.task.id}), oldest first:\n(no comments)`, isError: false });

    addComment(h.app, s.task.id, { type: "user", id: s.a.id }, "Use the blue palette.", 1_700_000_000_000);
    addComment(h.app, s.task.id, { type: "agent", id: s.writer.id }, "The copy is ready.", 1_700_000_060_000);
    const gone = addComment(h.app, s.task.id, { type: "user", id: s.a.id }, "Never mind this.", 1_700_000_120_000);
    deleteComment(h.app, s.task.id, gone.id, { id: s.a.id, admin: false });
    const r = await h.app.gateway.call("task_comments", { task_id: s.task.id }, s.ctx(s.designer));
    assert.equal(r.isError, false);
    assert.equal(
      r.text,
      [
        `Comments on "Draft the landing page" (${s.task.id}), oldest first:`,
        "[2023-11-14T22:13:20.000Z] @person-a: Use the blue palette.",
        "[2023-11-14T22:14:20.000Z] Writer: The copy is ready.",
        "[2023-11-14T22:15:20.000Z] @person-a: (comment deleted)",
      ].join("\n"),
    );
    assert.ok(!r.text.includes("Never mind"), "nothing of a deleted body");
    // the designer is in both chats: it reads the task from a turn in the other one
    assert.equal((await h.app.gateway.call("task_comments", { task_id: s.task.id }, s.ctx(s.designer, s.other.id))).isError, false);
  } finally {
    await h.close();
  }
});

test("task_comment: posts as the agent; the events go out, the people's API shows it, and no one wakes", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: s.a.c.cookie } });
    sockets.push(ws);
    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));
    const count = (table: string) => (h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    const messages = count("messages");
    const deliveries = count("deliveries");

    const r = await h.app.gateway.call("task_comment", { task_id: s.task.id, body: "  @writer the first draft is up.  " }, s.ctx(s.designer));
    assert.equal(r.isError, false);
    const row = h.app.db.prepare("SELECT id, author_type, author_id, body FROM task_comments").get() as any;
    assert.equal(r.text, `Comment ${row.id} added to "Draft the landing page".`);
    assert.deepEqual({ ...row, id: "" }, { id: "", author_type: "agent", author_id: s.designer.id, body: "@writer the first draft is up." });

    await waitFor(() => events.some((e) => e.type === "task_comment" && e.comment.id === row.id), "the task_comment event");
    await waitFor(() => events.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.commentCount === 1), "the task event with commentCount");
    const api = (await s.a.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments;
    assert.deepEqual(
      api.map((c: any) => [c.author, c.body]),
      [[{ type: "agent", id: s.designer.id, name: "Designer" }, "@writer the first draft is up."]],
      "in the people's API",
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(count("messages"), messages, "no chat message");
    assert.equal(count("deliveries"), deliveries, "no delivery: the writer doesn't wake");
    const log = h.app.db.prepare("SELECT tool, status FROM tool_calls WHERE tool = 'task_comment'").all() as any[];
    assert.deepEqual(log.map((l) => ({ ...l })), [{ tool: "task_comment", status: "ok" }], "in the tool log, allowed with no rule");
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("outside the task's chat, or an archived or missing task: a plain error, and nothing stored", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const elsewhere = s.ctx(s.outsider, s.other.id);
    for (const [name, args] of [
      ["task_comments", { task_id: s.task.id }],
      ["task_comment", { task_id: s.task.id, body: "Hello" }],
    ] as const) {
      const r = await h.app.gateway.call(name, args, elsewhere);
      assert.deepEqual(r, { text: `Error: there is no task ${s.task.id} in a chat you are in`, isError: true }, `${name}: an agent outside the chat`);
    }
    for (const args of [{ task_id: "t_no_such_task" }, {}]) {
      const r = await h.app.gateway.call("task_comments", args, s.ctx(s.designer));
      assert.equal(r.isError, true);
      assert.match(r.text, /^Error: there is no task .* in a chat you are in$/);
    }
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/archive`)).status, 200);
    for (const name of ["task_comments", "task_comment"]) {
      const r = await h.app.gateway.call(name, { task_id: s.task.id, body: "Hello" }, s.ctx(s.designer));
      assert.equal(r.isError, true, `${name}: archived`);
    }
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM task_comments").get() as any).n, 0);
  } finally {
    await h.close();
  }
});

test("task_comment: the people's limits, 1 to 4000 characters after trimming", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const call = (body: unknown) => h.app.gateway.call("task_comment", { task_id: s.task.id, body }, s.ctx(s.designer));
    for (const [body, want] of [
      ["", /the comment is empty/],
      [" \n\t ", /the comment is empty/],
      [undefined, /body is missing/],
      [42, /body is missing/],
      ["x".repeat(4001), /the comment is 4001 characters, over 4000/],
    ] as const) {
      const r = await call(body);
      assert.equal(r.isError, true, String(body).slice(0, 20));
      assert.match(r.text, want);
    }
    assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM task_comments").get() as any).n, 0, "nothing stored");
    assert.equal((await call("x".repeat(4000))).isError, false, "4000 characters");
    assert.equal((await call(`  ${"y".repeat(4000)}  `)).isError, false, "4000 after trimming");
    assert.equal(h.app.svc.task(s.task.id).commentCount, 2);
  } finally {
    await h.close();
  }
});
