// SPDX-License-Identifier: AGPL-3.0-only
// Agents a service drives (server/src/drivenagents.ts): every message that would wake the agent goes
// to the service as a request; only the service's own messages reach the agent; the service works
// in the chats its agents are in, and nowhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { NOTE_AFTER_MS } from "../server/src/drivenagents.ts";

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

test("service-drive and service-undrive: one service per agent, and revoking stops the driving", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    await mockAgent(owner, "designer");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-create", ["other-service"]);
    assert.throws(() => serviceCommand(db, "service-drive", ["no-such-service", "designer"]), /no service/);
    assert.throws(() => serviceCommand(db, "service-drive", ["example-service", "nobody"]), /no agent/);
    assert.throws(() => serviceCommand(db, "service-drive", ["example-service"]), /usage/);
    serviceCommand(db, "service-drive", ["example-service", "@designer"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]); // twice is fine
    assert.throws(() => serviceCommand(db, "service-drive", ["other-service", "designer"]), /driven by example-service/);
    assert.match(serviceCommand(db, "service-list", []).stdout ?? "", /example-service .*agents: @designer/);
    assert.match(serviceCommand(db, "service-undrive", ["designer"]).stderr ?? "", /answers for itself/);
    assert.match(serviceCommand(db, "service-undrive", ["designer"]).stderr ?? "", /No service drove/);
    serviceCommand(db, "service-drive", ["other-service", "designer"]);
    serviceCommand(db, "service-revoke", ["other-service"]);
    assert.match(serviceCommand(db, "service-list", []).stdout ?? "", /other-service .*agents: none/);
  } finally {
    await h.close();
  }
});

test("a driven agent: messages go to its service, the service's messages reach it, in its chats only", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    const writer = await mockAgent(owner, "writer");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]);
    const t = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
    const call = svcCall(h, t);

    const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id, writer.id] })).json.chat;
    const dm = (await owner.post("/api/chats", { dmAgent: designer.id })).json.chat;
    const elsewhere = (await owner.post("/api/chats", { name: "Elsewhere", agents: [writer.id] })).json.chat;

    // the service's socket, and the owner's own
    const listen = async (url: string, headers: Record<string, string>) => {
      const events: any[] = [];
      const ws = new WebSocket(url, { headers });
      ws.on("message", (d) => events.push(JSON.parse(String(d))));
      await new Promise((r, j) => {
        ws.on("open", r);
        ws.on("error", j);
      });
      sockets.push(ws);
      return events;
    };
    const svcEvents = await listen(h.url.replace("http", "ws") + "/ws/service", { authorization: `Bearer ${t}` });
    const ownerEvents = await listen(h.url.replace("http", "ws") + "/ws", { origin: h.url, cookie: owner.cookie });
    await waitFor(() => svcEvents.find((e) => e.type === "hello"), "the service's hello");
    assert.equal(svcEvents[0].service, "example-service");
    await assert.rejects(listen(h.url.replace("http", "ws") + "/ws/service", { authorization: `Bearer ${t}`, origin: h.url }), "a browser can't open the service's socket");

    // a person's @mention, an agent's hand-off and a DM: each a request, and the agent gets none
    await owner.post(`/api/chats/${group.id}/messages`, { body: "@designer a request from a person" });
    const handoff = (await owner.post(`/api/chats/${group.id}/messages`, { body: '@writer\n!tool handoff {"agent":"designer","message":"over to you"}' })).json.message;
    await agentReply(owner, group.id, writer.id, handoff.ts - 1);
    await owner.post(`/api/chats/${dm.id}/messages`, { body: "a direct message" });
    const reqs = await waitFor(() => {
      const got = svcEvents.filter((e) => e.type === "service_request").map((e) => e.request);
      return got.length >= 4 ? got : null;
    }, "four requests");
    assert.deepEqual(
      reqs.map((r: any) => [r.agent, r.chatKind === "agents" ? "agents chat" : r.chatId, r.from.type, r.text]),
      [
        ["designer", group.id, "user", "@designer a request from a person"],
        ["designer", "agents chat", "agent", "over to you"],
        // the writer's own reply names @designer: from another agent, so a request too
        ["designer", group.id, "agent", "handoff -> Handed to @designer (hop 1 of 5). Their reply will appear in the agents chat."],
        ["designer", dm.id, "user", "a direct message"],
      ],
    );
    assert.equal(reqs[1].from.handle, "writer");
    assert.equal(reqs[3].chatKind, "dm");
    assert.ok(reqs[0].messageId, "the request names the chat's message");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ?").get(designer.id) as any).n, 0, "the agent got nothing");
    assert.ok(!ownerEvents.some((e) => e.type === "service_request"), "no person's socket gets a request");
    assert.ok((await owner.get(`/api/chats/${group.id}/messages`)).json.messages.some((m: any) => m.body === "@designer a request from a person"), "the message shows in the chat as before");

    // the request queue, kept in the database
    const pending = await call("GET", "/api/service/requests");
    assert.equal(pending.json.requests.length, 4);
    assert.equal((await call("PATCH", `/api/service/requests/${reqs[0].id}`, { state: "taken" })).json.request.state, "taken");
    assert.equal((await call("PATCH", `/api/service/requests/${reqs[0].id}`, { state: "pending" })).status, 409);
    assert.equal((await call("PATCH", `/api/service/requests/${reqs[0].id}`, { state: "done" })).json.request.state, "done");
    assert.equal((await call("GET", "/api/service/requests")).json.requests.length, 3);
    assert.equal((await call("GET", "/api/service/requests/sreq_none")).status, 404);

    // scope: the chats the agent is in, and no others
    const chats = (await call("GET", "/api/service/chats")).json.chats;
    assert.deepEqual(chats.map((c: any) => c.id).sort(), [group.id, dm.id, reqs[1].chatId].sort(), "the group, the DM and the agents' own chat");
    const one = (await call("GET", `/api/service/chats/${group.id}`)).json.chat;
    assert.ok(one.members.some((m: any) => m.type === "agent" && m.handle === "writer"));
    assert.ok(!JSON.stringify(one).includes("@lumen.test"), "members by handle, never by email");
    assert.equal((await call("GET", `/api/service/chats/${elsewhere.id}`)).status, 404);
    assert.equal((await call("GET", `/api/service/chats/${elsewhere.id}/messages`)).status, 404);
    assert.equal((await call("POST", `/api/service/chats/${elsewhere.id}/messages`, { note: "hello" })).status, 404);
    assert.equal((await call("GET", "/api/service/agents")).json.agents[0].handle, "designer");

    // a note alone wakes nobody; text without an agent, or for an agent it doesn't drive, is refused
    const before = (db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as any).n;
    const noted = await call("POST", `/api/service/chats/${group.id}/messages`, { note: "working on it" });
    assert.equal(noted.status, 200);
    assert.equal(noted.json.message.kind, "service");
    assert.equal(noted.json.delivery, null);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as any).n, before);
    assert.equal((await call("POST", `/api/service/chats/${group.id}/messages`, { note: "x", text: "y" })).status, 400);
    assert.equal((await call("POST", `/api/service/chats/${group.id}/messages`, { note: "x", agent: "writer", text: "y" })).status, 403);
    assert.equal((await call("POST", `/api/service/chats/${group.id}/messages`, { agent: "designer", text: "y" })).status, 400, "a note is needed");

    // the service's own message reaches the agent, and the agent answers in the chat
    const asked = await call("POST", `/api/service/chats/${group.id}/messages`, { note: "asked @designer to answer", agent: "designer", text: "!say the answer, for the person" });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.delivery.fromType, "service");
    const reply = await agentReply(owner, group.id, designer.id, asked.json.message.ts - 1);
    assert.equal(reply.body, "the answer, for the person");
    const watch = (await owner.get(`/api/agents/${designer.id}/activity`)).json.activity;
    assert.ok(watch.some((e: any) => e.kind === "prompt" && e.text.startsWith("example-service:")), "the agent sees who asked: the service");

    // the Watch view: the service's own lines
    assert.equal((await call("POST", "/api/service/agents/designer/activity", { chatId: group.id, text: "part 2: checks passed" })).status, 200);
    assert.equal((await call("POST", "/api/service/agents/writer/activity", { text: "no" })).status, 403);
    const watched = (await owner.get(`/api/agents/${designer.id}/activity`)).json.activity;
    assert.ok(watched.some((e: any) => e.text === "example-service: part 2: checks passed"));

    // tasks in its chats
    const task = (await owner.post("/api/tasks", { chatId: group.id, title: "A task" })).json.task;
    const other = (await owner.post("/api/tasks", { chatId: elsewhere.id, title: "Not yours" })).json.task;
    assert.deepEqual((await call("GET", `/api/service/chats/${group.id}/tasks`)).json.tasks.map((x: any) => x.id), [task.id]);
    const patched = await call("PATCH", `/api/service/tasks/${task.id}`, { status: "needs_you", assignee: "designer" });
    assert.equal(patched.json.task.status, "needs_you");
    assert.equal(patched.json.task.assigneeId, designer.id);
    assert.equal((await call("PATCH", `/api/service/tasks/${other.id}`, { status: "done" })).status, 404);
    assert.equal((await call("PATCH", `/api/service/tasks/${task.id}`, { assignee: "writer" })).status, 403);
    assert.equal((await call("GET", "/api/service/files")).status, 400);
    assert.deepEqual((await call("GET", `/api/service/files?chat=${group.id}`)).json.files, []);

    // nothing from a chat outside its scope comes on its socket
    await owner.post(`/api/chats/${elsewhere.id}/messages`, { body: "@writer !say not for the service" });
    await agentReply(owner, elsewhere.id, writer.id, 0);
    assert.ok(!JSON.stringify(svcEvents).includes(elsewhere.id), "no event from another chat");
    assert.ok(svcEvents.some((e) => e.type === "message" && e.chatId === group.id), "its own chats' events do come");

    // take the agent out of a chat, and the service loses that chat at once
    await owner.post(`/api/chats/${group.id}/members`, { type: "agent", id: designer.id, remove: true });
    assert.equal((await call("GET", `/api/service/chats/${group.id}`)).status, 404);
    assert.equal((await call("PATCH", `/api/service/tasks/${task.id}`, { status: "done" })).status, 404);
  } finally {
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});

test("a request nobody picks up gets one note in its chat; an undriven agent answers for itself", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    serviceCommand(h.app.db, "service-create", ["example-service"]);
    serviceCommand(h.app.db, "service-drive", ["example-service", "designer"]);
    const dm = (await owner.post("/api/chats", { dmAgent: designer.id })).json.chat;
    const sent = (await owner.post(`/api/chats/${dm.id}/messages`, { body: "hello?" })).json.message;

    assert.equal(h.app.driven.noteWaiting(sent.ts + 1000), 0, "not yet");
    assert.equal(h.app.driven.noteWaiting(sent.ts + NOTE_AFTER_MS + 1000), 1);
    assert.equal(h.app.driven.noteWaiting(sent.ts + NOTE_AFTER_MS + 60_000), 0, "only once");
    const notes = (await owner.get(`/api/chats/${dm.id}/messages`)).json.messages.filter((m: any) => m.kind === "system");
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /Messages for @designer go to example-service, which hasn't picked this one up yet/);

    serviceCommand(h.app.db, "service-undrive", ["designer"]);
    const again = (await owner.post(`/api/chats/${dm.id}/messages`, { body: "!say back to normal" })).json.message;
    assert.equal((await agentReply(owner, dm.id, designer.id, again.ts - 1)).body, "back to normal");
  } finally {
    await h.close();
  }
});
