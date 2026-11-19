// A person's live events hold only what that person may see through the REST routes. Deliveries,
// approvals and chat memories carry their chat inside the payload, and each is checked against it.
// An agent's status says busy or idle to everyone; its detail goes only to people in its chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, mockAgent, agentReply, Client, waitFor } from "./helpers.ts";
import { eventFor, eventVisible, statusSeenBy, type Viewer } from "../server/src/eventfilter.ts";
import type { BusEvent } from "../server/src/bus.ts";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: "u_person", isAdmin: false, seesChat: (id) => id === "c_mine", ...over });

test("each event type is checked against its own chat", () => {
  const cases: [BusEvent, boolean, string][] = [
    [{ type: "message", chatId: "c_mine", message: {} }, true, "a message in my chat"],
    [{ type: "message", chatId: "c_other", message: {} }, false, "a message in another chat"],
    [{ type: "task", chatId: "c_other", task: {} }, false, "a task in another chat"],
    [{ type: "chat", chat: { id: "c_other" } }, false, "another chat"],
    [{ type: "delivery", delivery: { chatId: "c_mine", text: "hello" } }, true, "a delivery in my chat"],
    [{ type: "delivery", delivery: { chatId: "c_other", text: "private" } }, false, "a delivery in another chat"],
    [{ type: "delivery", delivery: { text: "no chat" } }, false, "a delivery with no chat"],
    [{ type: "approval", approval: { chatId: "c_mine", detail: {} } }, true, "an approval in my chat"],
    [{ type: "approval", approval: { chatId: "c_other", detail: {} } }, false, "an approval in another chat"],
    [{ type: "approval", approval: { chatId: "c_other", detail: { requester: { type: "user", id: "u_person" } } } }, true, "an approval I asked for"],
    [{ type: "approval", approval: { chatId: "", detail: {} } }, false, "an approval with no chat, for a member"],
    [{ type: "memory", memory: { scope: "chat", scopeId: "c_other" } }, false, "another chat's memory"],
    [{ type: "memory", memory: { scope: "chat", scopeId: "c_mine" } }, true, "my chat's memory"],
    [{ type: "memory", memory: { scope: "team", scopeId: "" } }, true, "a team memory"],
    [{ type: "agent_status", agentId: "a_1", status: { state: "idle", detail: "", since: 0, heartbeat: 0 } }, true, "an agent's status"],
  ];
  for (const [e, want, what] of cases) assert.equal(eventVisible(e, viewer()), want, what);
  assert.equal(eventVisible({ type: "approval", approval: { chatId: "", detail: {} } }, viewer({ isAdmin: true })), true, "an approval with no chat, for an admin");
});

test("an agent's status keeps its detail and chat only for people in that chat", () => {
  const status = { state: "working" as const, detail: "the start of a private message", since: 1, heartbeat: 2, chatId: "c_other" };
  const hidden = statusSeenBy(status, (id) => id === "c_mine");
  assert.deepEqual(hidden, { state: "working", detail: "", since: 1, heartbeat: 2 });
  assert.deepEqual(statusSeenBy({ ...status, chatId: "c_mine" }, (id) => id === "c_mine"), { ...status, chatId: "c_mine" });
  assert.deepEqual(statusSeenBy({ ...status, chatId: undefined }, () => false), { ...status, chatId: undefined }, "no chat: nothing to hide");
  const e = eventFor({ type: "agent_status", agentId: "a_1", status }, viewer()) as any;
  assert.equal(e.status.detail, "");
  assert.equal(e.status.chatId, undefined);
  assert.equal(eventFor({ type: "delivery", delivery: { chatId: "c_other" } }, viewer()), null);
});

test("a person outside a chat gets none of its deliveries over the websocket", async () => {
  const h = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const owner = await setupOwner(h);
    assert.equal((await owner.post("/api/users", { email: "person-a@example.com", name: "person-a", password: "example-password-1", role: "member" })).status, 200);
    const person = new Client(h.url);
    assert.equal((await person.post("/api/login", { email: "person-a@example.com", password: "example-password-1" })).status, 200);

    const agent = await mockAgent(owner, "designer");
    const chat = (await owner.post("/api/chats", { dmAgent: agent.id })).json.chat;
    assert.equal((await person.get(`/api/chats/${chat.id}/messages`)).status, 403, "the person can't open the owner's chat");

    const listen = async (c: Client) => {
      const events: any[] = [];
      const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: c.cookie } });
      await new Promise((r, j) => {
        ws.on("open", r);
        ws.on("error", j);
      });
      ws.on("message", (d) => events.push(JSON.parse(String(d))));
      sockets.push(ws);
      return { ws, events };
    };
    const mine = await listen(owner);
    const theirs = await listen(person);

    const body = "a private note for the designer";
    const sent = (await owner.post(`/api/chats/${chat.id}/messages`, { body })).json.message;
    await agentReply(owner, chat.id, agent.id, sent.ts - 1);
    await waitFor(() => mine.events.some((e) => e.type === "delivery" && e.delivery.state === "answered"), "the owner's delivery events");

    assert.ok(mine.events.some((e) => e.type === "delivery" && e.delivery.text?.includes(body)), "the owner sees the delivery");
    assert.ok(!theirs.events.some((e) => e.type === "delivery"), "the person gets no delivery event");
    assert.ok(!JSON.stringify(theirs.events).includes(body), "the person never gets the message's text");
    assert.ok(theirs.events.some((e) => e.type === "agent_status" && e.status.state === "working"), "the person still sees that the agent is busy");
    assert.ok(!theirs.events.some((e) => e.type === "agent_status" && e.status.chatId), "and never which chat");
  } finally {
    // every socket closes first, also after a failed check, or closing the app would wait on it
    for (const ws of sockets) ws.terminate();
    await h.close();
  }
});
