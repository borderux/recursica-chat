// SPDX-License-Identifier: AGPL-3.0-only
// Who can change a task's status (server/src/taskrules.ts, web/src/taskrules.ts). A task assigned to
// an agent is the agent's to move: a person, admins too, may only cancel it while it runs, and reopen
// it once it's finished, which asks the agent in the chat to redo it. An agent a service drives is
// reopened only when the service has said it can redo work. Agents' tools and services' routes set
// any status, and a person's or unassigned task takes every status. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, Client, agentReply, waitFor, type Harness } from "./helpers.ts";
import { cantRedo, personMoveRefusal } from "../server/src/taskrules.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { statusChoices } from "../web/src/taskrules.ts";

const STATUSES = ["todo", "working", "checking", "needs_you", "done", "cancelled"] as const;
const OPEN = ["todo", "working", "checking", "needs_you"] as const;

test("the rule: a person cancels an agent's running task, or nothing; a person's task takes every status", () => {
  const run = (status: string) => ({ status, assigneeType: "agent", assigneeId: "a_1" });
  for (const from of OPEN) {
    for (const to of STATUSES) {
      const no = personMoveRefusal(run(from), to, "Designer");
      if (to === "cancelled" || to === from) assert.equal(no, null, `${from} to ${to}`);
      else assert.equal(no, "This task is run by Designer: you can cancel it or answer it, not move it.", `${from} to ${to}`);
    }
    assert.deepEqual(
      statusChoices(run(from) as any).map(([s]) => s),
      [from, "cancelled"],
      `the menu for ${from}: its own status, and Cancel`,
    );
  }
  for (const from of ["done", "cancelled"]) {
    assert.match(personMoveRefusal(run(from), "todo", "Designer") ?? "", /finished: reopen it/);
    assert.deepEqual(statusChoices(run(from) as any).map(([s]) => s), [from], "no other choice: Reopen instead");
  }
  for (const t of [
    { status: "todo", assigneeType: "user", assigneeId: "u_1" },
    { status: "done", assigneeType: "", assigneeId: "" },
  ]) {
    for (const to of STATUSES) assert.equal(personMoveRefusal(t, to, "x"), null);
    assert.equal(statusChoices(t as any).length, 6, "the full menu");
  }
  assert.equal(cantRedo("Designer"), "Designer can't redo a finished task. Ask in the chat for a new run.");
});

async function seed() {
  const h = await startApp();
  const owner = new Client(h.url);
  assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
  const ownerId = (await owner.get("/api/me")).json.user.id as string;
  const bId = (await owner.post("/api/users", { email: "person-b@example.com", name: "Person B", password: "example-password-1", role: "member" })).json.user.id as string;
  const b = new Client(h.url);
  assert.equal((await b.post("/api/login", { email: "person-b@example.com", password: "example-password-1" })).status, 200);
  const agent = async (name: string, handle: string) => (await owner.post("/api/agents", { name, handle, engine: "mock", sandbox: "local", roleTitle: "Agent" })).json.agent.id as string;
  const designer = await agent("Designer", "designer");
  const writer = await agent("Writer", "writer");
  const chat = (await owner.post("/api/chats", { name: "acme launch", users: [bId], agents: [designer, writer] })).json.chat.id as string;
  return { h, owner, ownerId, b, bId, designer, writer, chat };
}

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

test("a person, admin or not, is refused every move but cancel on an agent's running task; cancel works", async () => {
  const { h, owner, b, designer, chat } = await seed();
  try {
    const svc = h.app.svc;
    for (const who of [b, owner]) {
      for (const from of OPEN) {
        const t = svc.createTask({ chatId: chat, title: `Draft the page (${from})`, assigneeType: "agent", assigneeId: designer, createdBy: designer });
        if (from !== "todo") svc.updateTask(t.id, { status: from });
        for (const to of STATUSES) {
          if (to === from || to === "cancelled") continue;
          const r = await who.patch(`/api/tasks/${t.id}`, { status: to });
          assert.equal(r.status, 403, `${from} to ${to}`);
          assert.equal(r.json.error, "This task is run by Designer: you can cancel it or answer it, not move it.");
          assert.equal(svc.task(t.id).status, from, "unchanged");
        }
        const same = await who.patch(`/api/tasks/${t.id}`, { status: from, title: `Draft the page, again (${from})` });
        assert.equal(same.status, 200, "the same status, with a new title: no move");
        const cancel = await who.patch(`/api/tasks/${t.id}`, { status: "cancelled" });
        assert.equal(cancel.status, 200, `cancel from ${from}`);
        assert.equal(svc.task(t.id).status, "cancelled");
        // finished now: no status at all from a person
        const back = await who.patch(`/api/tasks/${t.id}`, { status: "todo" });
        assert.equal(back.status, 403);
        assert.match(back.json.error, /finished: reopen it to have Designer redo it/);
      }
    }
  } finally {
    await h.close();
  }
});

test("an agent's tool and a service's route still set any status", async () => {
  const { h, owner, designer, writer, chat } = await seed();
  try {
    const svc = h.app.svc;
    const t = svc.createTask({ chatId: chat, title: "Review the copy", assigneeType: "agent", assigneeId: designer, createdBy: designer });
    const ctx = { agent: svc.agent(designer)!, chatId: chat, requester: { type: "user" as const, id: "" } };
    for (const to of ["working", "checking", "needs_you", "done", "todo", "cancelled", "working"]) {
      const r = await h.app.gateway.call("task_update", { id: t.id, status: to }, ctx);
      assert.equal(r.isError, false, r.text);
      assert.equal(svc.task(t.id).status, to, `the agent's tool: ${to}`);
    }
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "writer"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const w = svc.createTask({ chatId: chat, title: "Write the summary", assigneeType: "agent", assigneeId: writer, createdBy: writer });
    for (const to of ["working", "needs_you", "checking", "done", "todo", "cancelled"]) {
      const r = await call("PATCH", `/api/service/tasks/${w.id}`, { status: to });
      assert.equal(r.status, 200, `the service: ${to}`);
      assert.equal(svc.task(w.id).status, to);
    }
    assert.equal((await owner.patch(`/api/tasks/${w.id}`, { status: "todo" })).status, 403, "the person, still not");
  } finally {
    await h.close();
  }
});

test("a person's task and an unassigned one keep every move", async () => {
  const { h, b, bId, chat } = await seed();
  try {
    const svc = h.app.svc;
    const mine = svc.createTask({ chatId: chat, title: "Book the venue", assigneeType: "user", assigneeId: bId, createdBy: bId });
    const anyone = svc.createTask({ chatId: chat, title: "Check the analytics", createdBy: bId });
    for (const t of [mine, anyone])
      for (const to of ["working", "checking", "needs_you", "done", "todo", "cancelled", "done", "working"]) {
        const r = await b.patch(`/api/tasks/${t.id}`, { status: to });
        assert.equal(r.status, 200, `${t.title}: ${to}`);
        assert.equal(svc.task(t.id).status, to);
      }
    assert.equal((await b.post(`/api/tasks/${mine.id}/reopen`)).status, 409, "reopen is for a task an agent ran");
  } finally {
    await h.close();
  }
});

test("reopen: an ordinary agent's done task goes back to To do, and a message wakes the agent", async () => {
  const { h, owner, b, designer, chat } = await seed();
  try {
    const svc = h.app.svc;
    const t = svc.createTask({ chatId: chat, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer, createdBy: designer });
    assert.equal((await b.post(`/api/tasks/${t.id}/reopen`)).status, 409, "not finished yet");
    svc.updateTask(t.id, { status: "done" });
    const outsider = new Client(h.url);
    assert.equal((await owner.post("/api/users", { email: "person-c@example.com", name: "Person C", password: "example-password-1", role: "member" })).status, 200);
    assert.equal((await outsider.post("/api/login", { email: "person-c@example.com", password: "example-password-1" })).status, 200);
    assert.equal((await outsider.post(`/api/tasks/${t.id}/reopen`)).status, 404, "someone who can't see the chat");
    assert.equal(svc.task(t.id).status, "done");

    const before = Date.now() - 1;
    const r = await b.post(`/api/tasks/${t.id}/reopen`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.task.status, "todo");
    assert.equal(svc.task(t.id).status, "todo");
    assert.equal(r.json.message.body, '@designer Reopened by Person B: please redo "Draft the landing page".');
    assert.equal(r.json.message.authorType, "user");
    // delivered to the agent, the usual way, and the agent answers
    const d = h.app.db.prepare("SELECT * FROM deliveries WHERE agent_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1").get(designer, chat) as any;
    assert.ok(d, "a delivery for the agent");
    assert.match(d.text, /please redo "Draft the landing page"/);
    const reply = await agentReply(b, chat, designer, before);
    assert.ok(reply, "the agent woke and replied");
    assert.equal((await b.post(`/api/tasks/${t.id}/reopen`)).status, 409, "open again: nothing to reopen");
  } finally {
    await h.close();
  }
});

test("reopen: a driven agent's service must say it can redo work; until then 409 with a plain sentence", async () => {
  const { h, owner, b, writer, chat } = await seed();
  try {
    const svc = h.app.svc;
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "writer"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    assert.equal((await call("GET", "/api/service/me")).json.service.redo, false, "off by default");
    const t = svc.createTask({ chatId: chat, title: "Write the summary", assigneeType: "agent", assigneeId: writer, createdBy: writer });
    svc.updateTask(t.id, { status: "done" });

    const no = await b.post(`/api/tasks/${t.id}/reopen`);
    assert.equal(no.status, 409);
    assert.equal(no.json.error, "Writer can't redo a finished task. Ask in the chat for a new run.");
    assert.equal(svc.task(t.id).status, "done", "unchanged");

    // only the service itself, or an admin, turns it on
    assert.equal((await b.put("/api/service-accounts/example-service/redo", { redo: true })).status, 403, "a member");
    assert.equal((await owner.put("/api/service-accounts/no-such-service/redo", { redo: true })).status, 404);
    assert.equal((await call("PUT", "/api/service/redo", { redo: "yes" })).status, 400);
    assert.equal((await call("PUT", "/api/service/redo", { redo: true })).status, 200);
    assert.equal((await call("GET", "/api/service/me")).json.service.redo, true);

    const yes = await b.post(`/api/tasks/${t.id}/reopen`);
    assert.equal(yes.status, 200, JSON.stringify(yes.json));
    assert.equal(svc.task(t.id).status, "todo");
    // the message goes to the service, as every message that would wake its agent does
    await waitFor(async () => (await call("GET", "/api/service/requests")).json.requests.some((r: any) => r.agent === "writer" && r.text === '@writer Reopened by Person B: please redo "Write the summary".'), "a request for the service", 5000);

    // an admin turns it off again, and the next reopen is refused
    assert.equal((await owner.put("/api/service-accounts/example-service/redo", { redo: false })).status, 200);
    svc.updateTask(t.id, { status: "cancelled" });
    assert.equal((await owner.post(`/api/tasks/${t.id}/reopen`)).status, 409, "admins too");
  } finally {
    await h.close();
  }
});
