// SPDX-License-Identifier: AGPL-3.0-only
// A service's private instruction (drivenagents.ts): the agent's reply goes to the service alone, on
// its socket and from its reply route, and to the agent's Watch view, never to the chat. The mock
// engine plays the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";

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

async function setup() {
  const h = await startApp();
  const owner = await setupOwner(h);
  const designer = await mockAgent(owner, "designer");
  const db = h.app.db;
  serviceCommand(db, "service-create", ["example-service"]);
  serviceCommand(db, "service-drive", ["example-service", "designer"]);
  const token = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
  const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id] })).json.chat;
  const events: any[] = [];
  const ws = new WebSocket(h.url.replace("http", "ws") + "/ws/service", { headers: { authorization: `Bearer ${token}` } });
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  await waitFor(() => events.find((e) => e.type === "hello"), "the service's hello");
  const instruct = (text: string, extra: Record<string, unknown> = {}) => svcCall(h, token)("POST", `/api/service/chats/${group.id}/messages`, { note: "Asked the designer.", agent: "designer", text, ...extra });
  const close = async () => {
    ws.terminate();
    await h.close();
  };
  return { h, owner, designer, group, events, instruct, call: svcCall(h, token), close };
}

const chatMessages = async (owner: any, chatId: string) => (await owner.get(`/api/chats/${chatId}/messages`)).json.messages as any[];
const watch = async (owner: any, agentId: string) => (await owner.get(`/api/agents/${agentId}/activity`)).json.activity as any[];

test("a private instruction's reply goes to the service and the Watch view, never to the chat", async () => {
  const s = await setup();
  try {
    const sent = await s.instruct("!say A private answer", { private: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.delivery.private, true);
    const reply = await waitFor(() => s.events.find((e) => e.type === "service_reply")?.reply, "the reply on the service's socket");
    assert.deepEqual({ ...reply, ts: 0 }, { deliveryId: sent.json.delivery.id, agent: "designer", chatId: s.group.id, body: "A private answer", ts: 0 });
    assert.deepEqual((await s.call("GET", `/api/service/deliveries/${sent.json.delivery.id}/reply`)).json.reply, reply, "and from the reply route");
    await waitFor(async () => (await watch(s.owner, s.designer.id)).some((e) => e.text === "the reply went to the service alone, not to the chat"), "the Watch line");
    const msgs = await chatMessages(s.owner, s.group.id);
    assert.deepEqual(
      msgs.map((m) => [m.authorType, m.kind, m.body]),
      [["system", "service", "Asked the designer."]],
      "people see only the service's note",
    );
  } finally {
    await s.close();
  }
});

test("an instruction that isn't private still posts its reply to the chat", async () => {
  const s = await setup();
  try {
    const at = Date.now() - 1;
    const sent = await s.instruct("!say An answer for everyone");
    assert.equal(sent.json.delivery.private, false);
    const m = await agentReply(s.owner, s.group.id, s.designer.id, at);
    assert.equal(m.body, "An answer for everyone");
    assert.equal(s.events.filter((e) => e.type === "service_reply").length, 0);
    assert.equal((await s.call("GET", `/api/service/deliveries/${sent.json.delivery.id}/reply`)).status, 404, "it has no private reply");
  } finally {
    await s.close();
  }
});

test("a private turn posts no chat_post line, and its failure is a Watch line, not an error card", async () => {
  const s = await setup();
  try {
    await s.instruct('!tool chat_post {"text":"half way there"}', { private: true });
    const reply = await waitFor(() => s.events.find((e) => e.type === "service_reply")?.reply, "the reply");
    assert.equal(reply.body, "chat_post -> not posted: this turn answers a service, and its reply goes to the service alone");

    const crashed = await s.instruct("!crash", { private: true });
    await waitFor(() => (s.h.app.db.prepare("SELECT state FROM deliveries WHERE id = ?").get(crashed.json.delivery.id) as any)?.state === "failed", "the failed turn");
    await waitFor(async () => (await watch(s.owner, s.designer.id)).some((e) => e.kind === "error" && /^stopped before finishing/.test(e.text)), "the Watch line");
    const msgs = await chatMessages(s.owner, s.group.id);
    assert.ok(!msgs.some((m) => m.authorType === "agent"), "no line from the agent");
    assert.ok(!msgs.some((m) => m.kind === "error"), "no error card");
    assert.equal(msgs.filter((m) => m.kind === "service").length, 2, "only the service's two notes");
    assert.equal((await s.call("GET", `/api/service/deliveries/${crashed.json.delivery.id}/reply`)).json.reply, null, "no reply");
  } finally {
    await s.close();
  }
});

test("a private instruction needs an agent and true or false; another service can't read its reply", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", `/api/service/chats/${s.group.id}/messages`, { note: "A note.", private: true })).status, 400);
    assert.equal((await s.instruct("!say x", { private: "yes" })).status, 400);
    const sent = await s.instruct("!say Kept for the service", { private: true });
    await waitFor(() => s.events.find((e) => e.type === "service_reply"), "the reply");
    const db = s.h.app.db;
    serviceCommand(db, "service-create", ["other-service"]);
    const other = svcCall(s.h, serviceCommand(db, "service-token", ["other-service"]).stdout ?? "");
    assert.equal((await other("GET", `/api/service/deliveries/${sent.json.delivery.id}/reply`)).status, 404);
  } finally {
    await s.close();
  }
});

test("a private instruction may come with no note: then nothing of it shows in the chat", async () => {
  const s = await setup();
  try {
    const sent = await s.call("POST", `/api/service/chats/${s.group.id}/messages`, { agent: "designer", text: "!say Quietly", private: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.message, null);
    const reply = await waitFor(() => s.events.find((e) => e.type === "service_reply")?.reply, "the reply");
    assert.equal(reply.body, "Quietly");
    assert.deepEqual(await chatMessages(s.owner, s.group.id), [], "the chat is empty");
    assert.equal((await s.call("POST", `/api/service/chats/${s.group.id}/messages`, { agent: "designer", text: "!say Loudly" })).status, 400, "an instruction that isn't private still needs its note");
  } finally {
    await s.close();
  }
});
