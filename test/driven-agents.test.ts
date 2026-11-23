// SPDX-License-Identifier: AGPL-3.0-only
// Agents a service drives (server/src/drivenagents.ts): every message that would wake the agent goes
// to the service as a request; only the service's own messages reach the agent; the service works
// in the chats its agents are in, and nowhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { NOTE_AFTER_MS } from "../server/src/drivenagents.ts";
import { checkZip, LIMITS, makeZip, transcriptMarkdown } from "../server/src/files.ts";
import { setSetting } from "../server/src/db.ts";

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

test("a service attaches a text file to a task for its agent: on the task alone, as the agent's own, with attach_files's limits", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    const editor = await mockAgent(owner, "editor");
    const writer = await mockAgent(owner, "writer");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]);
    serviceCommand(db, "service-drive", ["example-service", "editor"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id, writer.id] })).json.chat;
    const elsewhere = (await owner.post("/api/chats", { name: "Elsewhere", agents: [writer.id] })).json.chat;
    const task = (await owner.post("/api/tasks", { chatId: group.id, title: "Interview 1 of 1 — A made-up gadget" })).json.task;
    const hidden = (await owner.post("/api/tasks", { chatId: elsewhere.id, title: "Not the service's" })).json.task;
    const before = (await owner.get(`/api/chats/${group.id}/messages`)).json.messages.length;

    const text = "SYNTHETIC: made up for a test.\nA made-up gadget, interview 1 of 1\n\nResearcher  00:00:05\nTell me about the last time you used it.\n";
    const r = await call("POST", "/api/service/agents/designer/files", { task: task.id, name: "gadget-interview-1-of-1.txt", text, markdown: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(
      r.json.files.map((f: any) => [f.name, f.taskId, f.messageId, f.agentId, f.chatId]),
      [
        ["gadget-interview-1-of-1.txt", task.id, null, designer.id, group.id],
        ["gadget-interview-1-of-1.md", task.id, null, designer.id, group.id],
      ],
      "on the task alone, as the agent's own",
    );
    assert.equal((await owner.get(`/api/chats/${group.id}/messages`)).json.messages.length, before, "no message in the chat");
    const got = async (fid: string) => (await call("GET", `/api/service/files/${fid}`)).json;
    assert.equal(await got(r.json.files[0].id), text, "the text, exactly");
    assert.equal(await got(r.json.files[1].id), transcriptMarkdown(text), "and the server's .md copy");
    assert.deepEqual((await call("GET", `/api/service/files?task=${task.id}`)).json.files.map((f: any) => f.name), ["gadget-interview-1-of-1.txt", "gadget-interview-1-of-1.md"]);

    // a WebVTT file, such as a transcript in a meeting tool's export format, is text too
    const vttText = "WEBVTT\n\n1\n00:00:05.000 --> 00:00:09.000\nResearcher: Tell me about the last time you used it.\n";
    const vtt = await call("POST", "/api/service/agents/designer/files", { task: task.id, name: "gadget-interview-1-of-1.vtt", text: vttText });
    assert.equal(vtt.status, 200, JSON.stringify(vtt.json));
    assert.equal(await got(vtt.json.files[0].id), vttText, "the .vtt's text, exactly");
    assert.equal((await call("POST", "/api/service/agents/designer/files", { task: task.id, name: "gadget.vtt", text: "x", markdown: true })).json.error, "gadget.vtt: markdown makes a copy of a .txt file only");
    assert.deepEqual((await call("GET", `/api/service/files?task=${task.id}`)).json.files.map((f: any) => f.name), ["gadget-interview-1-of-1.txt", "gadget-interview-1-of-1.md", "gadget-interview-1-of-1.vtt"]);

    // the agent bundles them as its own
    const zipped = await h.app.gateway.call(
      "attach_files",
      { include: [...r.json.files, ...vtt.json.files].map((f: any) => f.id), zip: "gadget-transcripts.zip", task: task.id },
      { agent: h.app.svc.agent(designer.id)!, chatId: group.id, requester: { type: "user", id: "" } },
    );
    assert.equal(zipped.isError, false, zipped.text);

    // only the service's agents, its chats, and an agent that is in the task's chat
    const post = (handle: string, b: any) => call("POST", `/api/service/agents/${handle}/files`, b);
    const ok = { task: task.id, name: "notes.txt", text: "x" };
    assert.equal((await post("writer", ok)).status, 403, "an agent the service doesn't drive");
    assert.equal((await post("designer", { ...ok, task: hidden.id })).status, 404, "a task in a chat the service doesn't see");
    assert.equal((await post("designer", { ...ok, task: "t_none" })).status, 404);
    const notIn = await post("editor", ok);
    assert.equal(notIn.status, 409);
    assert.match(notIn.json.error, /@editor isn't in that task's chat/);

    // attach_files's names, types and limits
    for (const [b, why] of [
      [{ ...ok, text: undefined }, /text is missing/],
      [{ ...ok, name: "notes.exe" }, /needs a name ending in/],
      [{ ...ok, name: "bundle.zip" }, /text goes in a \.txt, \.md, \.csv, \.json or \.vtt file/],
      [{ ...ok, name: "notes.md", markdown: true }, /markdown makes a copy of a \.txt file only/],
      [{ ...ok, text: "x".repeat(LIMITS.fileBytes + 1) }, /notes\.txt is over 10 MB/],
    ] as const) {
      const res = await post("designer", b);
      assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
      assert.match(res.json.error, why);
    }
    assert.equal((await post("designer", { ...ok, name: "../../etc/notes.txt" })).json.files[0].name, "notes.txt", "a safe base name");
    setSetting(db, "files_max_bytes", "10");
    assert.match((await post("designer", ok)).json.error, /file space is full/);
  } finally {
    await h.close();
  }
});

test("a service deletes a file on a task alone that its agent attached, or it did for the agent; never anyone else's, never one on a message", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    const writer = await mockAgent(owner, "writer");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id, writer.id] })).json.chat;
    const elsewhere = (await owner.post("/api/chats", { name: "Elsewhere", agents: [writer.id] })).json.chat;
    const task = (await owner.post("/api/tasks", { chatId: group.id, title: "Interview 1 of 1 — A made-up gadget" })).json.task;
    const hiddenTask = (await owner.post("/api/tasks", { chatId: elsewhere.id, title: "Not the service's" })).json.task;
    const attach = async (agent: any, chatId: string, args: any) => {
      const r = await h.app.gateway.call("attach_files", args, { agent: h.app.svc.agent(agent.id)!, chatId, requester: { type: "user", id: "" } });
      assert.equal(r.isError, false, r.text);
      return [...r.text.matchAll(/\((f_[\w-]+)\)/g)].map((m) => m[1]);
    };
    const [draft] = await attach(designer, group.id, { files: [{ name: "gadget-interview-1-stretch-1.txt", text: "a draft" }], task: task.id, task_only: true });
    const [theirs] = await attach(writer, group.id, { files: [{ name: "writer-notes.txt", text: "not the designer's" }], task: task.id, task_only: true });
    const [posted] = await attach(designer, group.id, { files: [{ name: "shown-in-chat.txt", text: "on a message" }], task: task.id });
    const [far] = await attach(writer, elsewhere.id, { files: [{ name: "far.txt", text: "x" }], task: hiddenTask.id, task_only: true });
    const mine = (await call("POST", "/api/service/agents/designer/files", { task: task.id, name: "service-made.txt", text: "the service's" })).json.files[0].id;
    const blob = join(h.dir, "files", draft);
    assert.ok(existsSync(blob));

    const r = await call("DELETE", `/api/service/files/${draft}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.deleted.name, "gadget-interview-1-stretch-1.txt");
    assert.ok(!existsSync(blob), "its stored copy too");
    assert.equal((await call("GET", `/api/service/files/${draft}`)).status, 404);
    assert.equal((await call("DELETE", `/api/service/files/${mine}`)).status, 200, "one the service attached for its agent");

    assert.equal((await call("DELETE", `/api/service/files/${theirs}`)).status, 403, "another agent's");
    const onMessage = await call("DELETE", `/api/service/files/${posted}`);
    assert.equal(onMessage.status, 409, "one on a message stays");
    assert.match(onMessage.json.error, /on a message/);
    assert.equal((await call("DELETE", `/api/service/files/${far}`)).status, 404, "in a chat the service doesn't see");
    assert.equal((await call("DELETE", "/api/service/files/f_none")).status, 404);
    assert.deepEqual(
      (await call("GET", `/api/service/files?task=${task.id}`)).json.files.map((f: any) => f.name).sort(),
      ["shown-in-chat.txt", "writer-notes.txt"],
    );
  } finally {
    await h.close();
  }
});

test("a service zips its agent's files of a plan onto a task, with no turn of the agent's; never another's or another plan's", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    const writer = await mockAgent(owner, "writer");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id, writer.id] })).json.chat;
    const ctx = (a: any) => ({ agent: h.app.svc.agent(a.id)!, chatId: group.id, requester: { type: "user" as const, id: "" } });
    const plan = async (titles: string[]) =>
      /Task ids: (.*)$/.exec((await h.app.gateway.call("propose_plan", { title: "A made-up set", steps: titles.map((title) => ({ title, assignee: "designer" })) }, ctx(designer))).text)![1].split(", ");
    const [interview, zipTask] = await plan(["Interview 1 of 1 — A made-up gadget", "Zip the transcripts"]);
    const [otherPlan] = await plan(["Another set"]);
    const text = "SYNTHETIC: made up for a test.\n\nResearcher  00:00:05\nTell me about the last time.\n";
    const made = (await call("POST", "/api/service/agents/designer/files", { task: interview, name: "gadget-interview-1-of-1.txt", text, markdown: true })).json.files;
    const ids = made.map((f: any) => f.id);

    const r = await call("POST", "/api/service/agents/designer/zip", { task: zipTask, name: "gadget-transcripts.zip", include: ids });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.file.name, r.json.file.taskId, r.json.file.messageId, r.json.file.agentId], ["gadget-transcripts.zip", zipTask, null, designer.id], "on the zip task alone, as the agent's");
    const stored = readFileSync(join(h.dir, "files", r.json.file.id));
    assert.deepEqual(checkZip(stored), ["gadget-interview-1-of-1.txt", "gadget-interview-1-of-1.md"]);
    assert.ok(stored.equals(makeZip([{ name: "gadget-interview-1-of-1.txt", data: Buffer.from(text) }, { name: "gadget-interview-1-of-1.md", data: Buffer.from(transcriptMarkdown(text)) }])), "the files' bytes, exactly");

    // refusals: another agent's file, a file of another plan, a bad name, nothing to zip, and outside the service's scope
    const theirs = /\((f_[\w-]+)\)/.exec((await h.app.gateway.call("attach_files", { files: [{ name: "w.txt", text: "x" }], task: interview, task_only: true }, ctx(writer))).text)![1];
    const elsewhere = (await call("POST", "/api/service/agents/designer/files", { task: otherPlan, name: "other.txt", text: "x" })).json.files[0].id;
    for (const [b, why] of [
      [{ task: zipTask, name: "z.zip", include: [theirs] }, /not a file of the agent's in this task or its plan/],
      [{ task: zipTask, name: "z.zip", include: [elsewhere] }, /not a file of the agent's in this task or its plan/],
      [{ task: zipTask, name: "z.txt", include: ids }, /a zip needs a name ending in \.zip/],
      [{ task: zipTask, name: "z.zip", include: [] }, /include: the ids of the files to zip/],
    ] as const) {
      const res = await call("POST", "/api/service/agents/designer/zip", b);
      assert.equal(res.status, 400, JSON.stringify(b));
      assert.match(res.json.error, why);
    }
    assert.equal((await call("POST", "/api/service/agents/designer/zip", { task: "t_none", name: "z.zip", include: ids })).status, 404);
    assert.equal((await call("POST", "/api/service/agents/writer/zip", { task: zipTask, name: "z.zip", include: ids })).status, 403, "an agent the service doesn't drive");
  } finally {
    await h.close();
  }
});
