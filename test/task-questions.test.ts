// SPDX-License-Identifier: AGPL-3.0-only
// Questions on a task (server/src/taskcomments.ts): a service asks one, as the agent it drives, with 2 to
// 6 choices; a person who sees the task answers it once, as a comment of their own; the service reads
// the answer with its comments route. The refusals, the events, the agents' task_comments tool, deletes,
// and the columns added in place to an older table. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, Client, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { openDb } from "../server/src/db.ts";
import { commentsOf, openQuestionsOf, addComment, deleteComment } from "../server/src/taskcomments.ts";

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

const CHOICES = [
  { value: "write-again", label: "Write it again" },
  { value: "leave-out", label: "Leave it out" },
  { value: "stop-set", label: "Stop the set" },
];

/** Two people and the owner in a chat with an agent a service drives; a person outside it; the agent's task. */
async function seed(h: Harness) {
  const owner = await setupOwner(h);
  const ownerId = (await owner.get("/api/me")).json.user.id;
  const a = await person(h, owner, "Person A", "person-a@example.com");
  const b = await person(h, owner, "Person B", "person-b@example.com");
  const outsider = await person(h, owner, "Person C", "person-c@example.com");
  const designer = await mockAgent(owner, "designer");
  const db = h.app.db;
  serviceCommand(db, "service-create", ["example-service"]);
  serviceCommand(db, "service-drive", ["example-service", "designer"]);
  const token = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
  const service = svcCall(h, token);
  const chat = (await a.c.post("/api/chats", { name: "acme launch", users: [b.id, ownerId], agents: [designer.id] })).json.chat;
  const task = h.app.svc.createTask({ chatId: chat.id, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer.id, createdBy: a.id });
  h.app.svc.updateTask(task.id, { status: "needs_you" });
  const ask = async (body = "The second section failed twice. What next?", choices: unknown = CHOICES, tid = task.id) => service("POST", `/api/service/tasks/${tid}/comments`, { body, choices });
  return { owner, ownerId, a, b, outsider, designer, service, token, chat, task, ask };
}

async function socket(url: string, headers: Record<string, string>, sockets: WebSocket[]): Promise<any[]> {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const events: any[] = [];
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  return events;
}

const rowCount = (h: Harness) => (h.app.db.prepare("SELECT COUNT(*) AS n FROM task_comments").get() as any).n;

test("a service asks, a person answers once, and the service reads the answer", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const count = (table: string) => (h.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    const messages = count("messages");
    const deliveries = count("deliveries");
    const requests = count("service_requests");

    const asked = await s.ask("  The second section failed twice. What next?  ", [...CHOICES.slice(0, 2), { value: "stop-set", label: "  Stop the set  " }]);
    assert.equal(asked.status, 201);
    const q = asked.json.comment;
    assert.deepEqual(
      { ...q, id: "", createdAt: 0 },
      {
        id: "",
        taskId: s.task.id,
        author: { type: "agent", id: s.designer.id, name: "Designer" },
        body: "The second section failed twice. What next?",
        createdAt: 0,
        deleted: false,
        choices: CHOICES,
        answerTo: null,
        choice: null,
        answer: null,
      },
      "a question: the driven agent's, labels trimmed",
    );
    const row = h.app.db.prepare("SELECT choices, answer_to, choice FROM task_comments WHERE id = ?").get(q.id) as any;
    assert.deepEqual({ ...row, choices: JSON.parse(row.choices) }, { choices: CHOICES, answer_to: null, choice: null }, "the columns");
    assert.equal(h.app.svc.task(s.task.id).openQuestions, 1, "the task has an open question");
    assert.equal((await s.b.c.get("/api/board")).json.tasks.find((t: any) => t.id === s.task.id).openQuestions, 1, "on the board too");
    assert.deepEqual((await s.b.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments, [q], "people read it the same");

    const before = Date.now();
    const r = await s.b.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "leave-out" });
    assert.equal(r.status, 201);
    const ans = r.json.comment;
    assert.ok(/^tcm_/.test(ans.id));
    assert.deepEqual(
      { ...ans, id: "", createdAt: 0 },
      { id: "", taskId: s.task.id, author: { type: "user", id: s.b.id, name: "Person B" }, body: "Leave it out", createdAt: 0, deleted: false, choices: null, answerTo: q.id, choice: "leave-out", answer: null },
      "an answer: a comment from the person, its body the label",
    );
    assert.ok(ans.createdAt >= before);

    const read = await s.service("GET", `/api/service/tasks/${s.task.id}/comments`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.comments, [{ ...q, answer: { by: { type: "user", id: s.b.id, name: "Person B" }, choice: "leave-out", at: ans.createdAt } }, ans], "the service reads the question with its answer, then the answer");
    assert.deepEqual((await s.a.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments, read.json.comments, "people read the same");

    const t = h.app.svc.task(s.task.id);
    assert.equal(t.openQuestions, 0, "no open question now");
    assert.equal(t.commentCount, 2);
    assert.equal(t.status, "needs_you", "the answer doesn't change the task's status");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(count("messages"), messages, "no chat message");
    assert.equal(count("deliveries"), deliveries, "no delivery: no agent wakes");
    assert.equal(count("service_requests"), requests, "no request to the service: it polls");

    // a person's own POST takes no choices: an ordinary comment
    const plain = await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Can I pick?", choices: CHOICES });
    assert.equal(plain.status, 201);
    assert.equal(plain.json.comment.choices, null);
    // a service's comment with no choices, or choices: null, is ordinary as before
    assert.equal((await s.service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "Noted." })).json.comment.choices, null);
    assert.equal((await s.service("POST", `/api/service/tasks/${s.task.id}/comments`, { body: "Noted.", choices: null })).json.comment.choices, null);
  } finally {
    await h.close();
  }
});

test("choices: 2 to 6, values a-z 0-9 and -, unique, labels 1 to 80 characters; a plain 400 otherwise", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const two = CHOICES.slice(0, 2);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `pick-${i + 1}`, label: `Pick ${i + 1}` }));
    for (const [choices, want] of [
      ["write-again", /choices must be a list/],
      [{ value: "a", label: "A" }, /choices must be a list/],
      [[], /2 to 6 choices, not 0/],
      [[CHOICES[0]], /2 to 6 choices, not 1/],
      [many(7), /2 to 6 choices, not 7/],
      [[CHOICES[0], "leave-out"], /choice 2 must be an object/],
      [[CHOICES[0], null], /choice 2 must be an object/],
      [[{ value: "Write-Again", label: "Write it again" }, CHOICES[1]], /choice 1's value must be 1 to 40 of a-z, 0-9 and "-"/],
      [[{ value: "-again", label: "Again" }, CHOICES[1]], /choice 1's value/],
      [[{ value: "", label: "Again" }, CHOICES[1]], /choice 1's value/],
      [[{ value: "with space", label: "Again" }, CHOICES[1]], /choice 1's value/],
      [[{ value: "a".repeat(41), label: "Again" }, CHOICES[1]], /choice 1's value/],
      [[{ value: 1, label: "One" }, CHOICES[1]], /choice 1's value/],
      [[CHOICES[0], { label: "No value" }], /choice 2's value/],
      [[CHOICES[0], { value: "write-again", label: "Again" }], /choice 2's value, write-again, is used twice/],
      [[CHOICES[0], { value: "leave-out", label: "   " }], /choice 2's label is empty/],
      [[CHOICES[0], { value: "leave-out" }], /choice 2's label is empty/],
      [[CHOICES[0], { value: "leave-out", label: "x".repeat(81) }], /choice 2's label is 81 characters, over 80/],
    ] as const) {
      const r = await s.ask(undefined, choices);
      assert.equal(r.status, 400, JSON.stringify(choices).slice(0, 60));
      assert.match(r.json.error, want);
    }
    assert.equal((await s.ask("   ", two)).status, 400, "the question's text has the comment's limits");
    assert.equal((await s.ask("x".repeat(4001), two)).status, 400);
    assert.equal(rowCount(h), 0, "nothing stored");

    assert.equal((await s.ask("Two?", two)).status, 201, "2 choices");
    assert.equal((await s.ask("Six?", many(6))).status, 201, "6 choices");
    const edge = await s.ask("Edges?", [
      { value: "a".repeat(40), label: "y".repeat(80) },
      { value: "0", label: ` ${"z".repeat(80)} ` },
    ]);
    assert.equal(edge.status, 201, "a 40-character value, an 80-character label after trimming, a one-digit value");
    assert.deepEqual(
      edge.json.comment.choices.map((c: any) => [c.value.length, c.label.length]),
      [
        [40, 80],
        [1, 80],
      ],
    );
    const extra = await s.ask("Extra keys?", [
      { value: "yes", label: "Yes", colour: "green" },
      { value: "no", label: "No" },
    ]);
    assert.deepEqual(extra.json.comment.choices, [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ], "only value and label are kept");
    assert.equal(h.app.svc.task(s.task.id).openQuestions, 4);
  } finally {
    await h.close();
  }
});

test("answer refusals: 404 unseen, 400 not a question, deleted or a wrong choice, 409 answered already", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const q = (await s.ask()).json.comment;
    const other = h.app.svc.createTask({ chatId: s.chat.id, title: "Book the venue", createdBy: s.a.id });
    const plain = (await s.a.c.post(`/api/tasks/${s.task.id}/comments`, { body: "Just a note." })).json.comment;
    const answerOf = (c: Client, tid: string, cid: string, body: unknown = { choice: "leave-out" }) => c.post(`/api/tasks/${tid}/comments/${cid}/answer`, body);
    const stored = rowCount(h);

    // 404: a task or comment the person can't see, or a comment not on that task
    for (const [c, tid, cid, what] of [
      [s.outsider.c, s.task.id, q.id, "a person outside the chat"],
      [s.a.c, "t_no_such_task", q.id, "no such task"],
      [s.a.c, s.task.id, "tcm_no_such_comment", "no such comment"],
      [s.a.c, other.id, q.id, "a comment on another task"],
    ] as const) {
      const r = await answerOf(c, tid, cid);
      assert.equal(r.status, 404, what);
      assert.equal(typeof r.json.error, "string");
    }
    assert.equal((await answerOf(s.outsider.c, s.task.id, q.id, { choice: 42 })).status, 404, "404 before the choice is read");
    assert.equal((await answerOf(new Client(h.url), s.task.id, q.id)).status, 401, "signed out");

    // 400: not a question, or not one of its values
    const notQ = await answerOf(s.a.c, s.task.id, plain.id);
    assert.equal(notQ.status, 400);
    assert.match(notQ.json.error, /isn't a question/);
    for (const body of [{}, { choice: "" }, { choice: "Leave it out" }, { choice: "LEAVE-OUT" }, { choice: 2 }, { choice: null }, { choice: ["leave-out"] }]) {
      const r = await answerOf(s.a.c, s.task.id, q.id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, "choice must be one of: write-again, leave-out, stop-set");
    }
    const notJson = await fetch(`${h.url}/api/tasks/${s.task.id}/comments/${q.id}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: h.url, cookie: s.a.c.cookie }, body: "{not json" });
    assert.equal(notJson.status, 400);
    assert.equal(rowCount(h), stored, "nothing stored");

    // the first answer stands; a second, from anyone and with any choice, is 409
    assert.equal((await answerOf(s.a.c, s.task.id, q.id, { choice: "write-again" })).status, 201);
    for (const [c, choice] of [
      [s.b.c, "leave-out"],
      [s.a.c, "write-again"],
      [s.owner, "stop-set"],
    ] as const) {
      const r = await answerOf(c, s.task.id, q.id, { choice });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "This question was answered already by Person A");
    }
    // an answer isn't a question either
    const ans = commentsOf(h.app.db, s.task.id).find((c) => c.answerTo === q.id)!;
    assert.equal((await answerOf(s.b.c, s.task.id, ans.id)).status, 400, "an answer");
    assert.equal(rowCount(h), stored + 1, "one answer stored");

    // a deleted question: 400
    const q2 = (await s.ask("Another?")).json.comment;
    assert.equal((await s.owner.del(`/api/tasks/${s.task.id}/comments/${q2.id}`)).status, 204);
    const gone = await answerOf(s.a.c, s.task.id, q2.id);
    assert.equal(gone.status, 400);
    assert.match(gone.json.error, /deleted/);

    // an archived task: 404
    const q3 = (await s.ask("A third?")).json.comment;
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/archive`)).status, 200);
    assert.equal((await answerOf(s.a.c, s.task.id, q3.id)).status, 404, "archived");
    assert.equal((await s.ask("While archived?")).status, 404, "the service can't ask on an archived task");
  } finally {
    await h.close();
  }
});

test("a person outside the chat gets nothing: no comments, no answer, no events", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const events = await socket(h.url.replace("http", "ws") + "/ws", { origin: h.url, cookie: s.outsider.c.cookie }, sockets);
    const q = (await s.ask("A private question?")).json.comment;
    assert.equal((await s.outsider.c.get(`/api/tasks/${s.task.id}/comments`)).status, 404);
    assert.equal((await s.outsider.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "leave-out" })).status, 404);
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "leave-out" })).status, 201);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      events.filter((e) => e.type !== "hello" && e.type !== "agent_status"),
      [],
      "no task_comment or task event",
    );
    assert.ok(!JSON.stringify(events).includes("A private question?"));
    assert.ok(!(await s.outsider.c.get("/api/board")).json.tasks.some((t: any) => t.id === s.task.id), "not on their board");
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("events: the question; then the answer, the question with its answer, and the task", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const s = await seed(h);
    const people = await socket(h.url.replace("http", "ws") + "/ws", { origin: h.url, cookie: s.b.c.cookie }, sockets);
    const svcEvents = await socket(h.url.replace("http", "ws") + "/ws/service", { authorization: `Bearer ${s.token}` }, sockets);
    const q = (await s.ask()).json.comment;
    await waitFor(() => people.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.openQuestions === 1), "the task event with openQuestions 1");
    assert.deepEqual(
      people.find((e) => e.type === "task_comment"),
      { type: "task_comment", chatId: s.chat.id, taskId: s.task.id, comment: q },
      "the question, with its choices",
    );

    const ans = (await s.a.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "write-again" })).json.comment;
    await waitFor(() => people.some((e) => e.type === "task" && e.task.id === s.task.id && e.task.openQuestions === 0), "the task event with openQuestions 0");
    const after = people.slice(people.findIndex((e) => e.type === "task" && e.task.openQuestions === 1) + 1).filter((e) => e.type === "task_comment" || e.type === "task");
    const answered = { ...q, answer: { by: { type: "user", id: s.a.id, name: "Person A" }, choice: "write-again", at: ans.createdAt } };
    assert.deepEqual(
      after.map((e) => (e.type === "task" ? ["task", e.task.openQuestions, e.task.commentCount, e.task.status] : ["task_comment", e.comment])),
      [
        ["task_comment", ans],
        ["task_comment", answered],
        ["task", 0, 2, "needs_you"],
      ],
      "the answer, the question with its answer, then the task: its status unchanged",
    );
    await waitFor(() => svcEvents.some((e) => e.type === "task_comment" && e.comment.answerTo === q.id), "the service's socket gets the answer");
    assert.ok(svcEvents.some((e) => e.type === "task_comment" && e.comment.id === q.id && e.comment.answer?.choice === "write-again"), "and the answered question");
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("deletes: an answer is deleted like any comment and its question stays answered; a deleted question loses its choices", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const q = (await s.ask()).json.comment;
    const ans = (await s.b.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "stop-set" })).json.comment;
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${ans.id}`)).status, 403, "another member can't delete it");
    assert.equal((await s.b.c.del(`/api/tasks/${s.task.id}/comments/${ans.id}`)).status, 204, "its author can");
    const [qj, aj] = (await s.service("GET", `/api/service/tasks/${s.task.id}/comments`)).json.comments;
    assert.deepEqual(qj.answer, { by: { type: "user", id: s.b.id, name: "Person B" }, choice: "stop-set", at: ans.createdAt }, "still answered");
    assert.deepEqual([aj.deleted, aj.body, aj.answerTo, aj.choice], [true, "", q.id, "stop-set"], "the deleted answer keeps what it answered");
    assert.equal(h.app.svc.task(s.task.id).openQuestions, 0, "not reopened");
    assert.equal((await s.a.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "leave-out" })).status, 409, "and can't be answered again");

    const q2 = (await s.ask("Which colour?")).json.comment;
    assert.equal(h.app.svc.task(s.task.id).openQuestions, 1);
    assert.equal((await s.a.c.del(`/api/tasks/${s.task.id}/comments/${q2.id}`)).status, 403, "a member can't delete the agent's question");
    assert.equal((await s.owner.del(`/api/tasks/${s.task.id}/comments/${q2.id}`)).status, 204, "an admin can");
    const listed = (await s.a.c.get(`/api/tasks/${s.task.id}/comments`)).json.comments.find((c: any) => c.id === q2.id);
    assert.deepEqual([listed.deleted, listed.body, listed.choices, listed.answer], [true, "", null, null]);
    const row = h.app.db.prepare("SELECT body, choices FROM task_comments WHERE id = ?").get(q2.id) as any;
    assert.deepEqual({ ...row }, { body: "", choices: null }, "its text and choices leave the table");
    assert.equal(h.app.svc.task(s.task.id).openQuestions, 0, "a deleted question isn't open");
  } finally {
    await h.close();
  }
});

test("the agents' task_comments tool prints a question's choices and its answer", async () => {
  const h = await startApp();
  try {
    const s = await seed(h);
    const ctx = { agent: h.app.svc.agent(s.designer.id)!, chatId: s.chat.id, requester: { type: "user" as const, id: s.a.id } };
    const q = addComment(h.app, s.task.id, { type: "agent", id: s.designer.id }, "The second section failed twice. What next?", 1_700_000_000_000, CHOICES.slice(0, 2));
    const open = await h.app.gateway.call("task_comments", { task_id: s.task.id }, ctx);
    assert.equal(
      open.text,
      [
        `Comments on "Draft the landing page" (${s.task.id}), oldest first:`,
        "[2023-11-14T22:13:20.000Z] Designer: The second section failed twice. What next? [question: choices write-again (Write it again), leave-out (Leave it out)] (not answered yet)",
      ].join("\n"),
    );
    const r = await s.a.c.post(`/api/tasks/${s.task.id}/comments/${q.id}/answer`, { choice: "leave-out" });
    assert.equal(r.status, 201);
    deleteComment(h.app, s.task.id, r.json.comment.id, { id: s.a.id, admin: false });
    const lines = (await h.app.gateway.call("task_comments", { task_id: s.task.id }, ctx)).text.split("\n");
    assert.equal(lines[1], "[2023-11-14T22:13:20.000Z] Designer: The second section failed twice. What next? [question: choices write-again (Write it again), leave-out (Leave it out)] answered by @person-a: Leave it out", "the label, even with the answer deleted");
    assert.match(lines[2], /^\[.*\] @person-a: \(comment deleted\)$/);

    const q2 = addComment(h.app, s.task.id, { type: "agent", id: s.designer.id }, "Keep going?", 1_700_000_000_000 + 1, [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ]);
    await s.b.c.post(`/api/tasks/${s.task.id}/comments/${q2.id}/answer`, { choice: "yes" });
    const all = (await h.app.gateway.call("task_comments", { task_id: s.task.id }, ctx)).text;
    assert.match(all, /Designer: Keep going\? \[question: choices yes \(Yes\), no \(No\)\] answered by @person-b: Yes$/m);
    assert.match(all, /@person-b: Yes \[answer: yes\]$/m, "an answer shows the value chosen");
    // task_comment stays as it was: no choices
    const tool = (await h.app.gateway.toolsFor(ctx)).find((t) => t.name === "task_comment")!;
    assert.deepEqual(Object.keys((tool.inputSchema as any).properties), ["task_id", "body"]);
  } finally {
    await h.close();
  }
});

test("an older task_comments table gains the columns in place, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-test-"));
  try {
    const path = join(dir, "circlechat.db");
    const old = openDb(path);
    old.exec("PRAGMA foreign_keys = OFF");
    old.prepare("INSERT INTO tasks(id, chat_id, title, created_at, updated_at) VALUES('t_1', 'c_1', 'Draft the landing page', 1, 1)").run();
    // the table as the first release of comments made it
    old.exec(`CREATE TABLE task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('user','agent')),
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX task_comments_task ON task_comments(task_id, created_at);
    INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES('tcm_1', 't_1', 'user', 'u_1', 'Use the blue palette.', 10);`);
    old.close();

    const cols = (db: any) => (db.prepare("SELECT name FROM pragma_table_info('task_comments')").all() as any[]).map((c) => c.name);
    const db = openDb(path);
    assert.deepEqual(cols(db), ["id", "task_id", "author_type", "author_id", "body", "created_at", "deleted_at", "deleted_by"], "before");
    const [c] = commentsOf(db, "t_1");
    assert.deepEqual([c.body, c.choices, c.answerTo, c.choice, c.answer], ["Use the blue palette.", null, null, null, null], "an old comment reads as an ordinary one");
    assert.deepEqual(cols(db), ["id", "task_id", "author_type", "author_id", "body", "created_at", "deleted_at", "deleted_by", "choices", "answer_to", "choice"], "after");
    assert.equal(openQuestionsOf(db, "t_1"), 0);
    db.exec(`INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, choices) VALUES('tcm_2', 't_1', 'agent', 'a_1', 'Which?', 20, '[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]')`);
    assert.equal(openQuestionsOf(db, "t_1"), 1);
    db.exec("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, answer_to, choice) VALUES('tcm_3', 't_1', 'user', 'u_1', 'Yes', 30, 'tcm_2', 'yes')");
    assert.throws(() => db.exec("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, answer_to, choice) VALUES('tcm_4', 't_1', 'user', 'u_2', 'No', 40, 'tcm_2', 'no')"), /UNIQUE/, "one answer per question");
    assert.equal(openQuestionsOf(db, "t_1"), 0);
    db.close();

    const again = openDb(path);
    assert.equal(commentsOf(again, "t_1").length, 3, "opening it again changes nothing");
    assert.equal(cols(again).length, 11);
    assert.deepEqual(commentsOf(again, "t_1")[1].answer, { by: { type: "user", id: "u_1", name: "" }, choice: "yes", at: 30 });
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
