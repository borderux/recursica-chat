// SPDX-License-Identifier: AGPL-3.0-only
// A service's instruction marked fresh (drivenagents.ts) runs in a session of its own, with no history:
// never stored or resumed, gone after the turn, and the chat's own session is left as it was. The mock
// engine counts the turns of each session, and says which turn it reads in the agent's Watch view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startApp, setupOwner, mockAgent, waitFor, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { instructionTables } from "../server/src/drivenagents.ts";

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
  const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
  const group = (await owner.post("/api/chats", { name: "Group", agents: [designer.id] })).json.chat;
  /** Sends an instruction and waits for its turn to end. */
  const instruct = async (text: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", `/api/service/chats/${group.id}/messages`, { note: "Asked the designer.", agent: "designer", text, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await waitFor(() => ["answered", "failed"].includes((db.prepare("SELECT state FROM deliveries WHERE id = ?").get(r.json.delivery.id) as any)?.state), "the turn's end");
    return r.json.delivery;
  };
  /** The turn number the mock engine read each message at, in order: 1 for a new session. */
  const turns = async () =>
    ((await owner.get(`/api/agents/${designer.id}/activity`)).json.activity as any[]).map((e) => /reading message \(turn (\d+)\)/.exec(e.text)?.[1]).filter(Boolean).map(Number);
  const stored = () => db.prepare("SELECT engine_session_id AS id FROM agent_sessions WHERE agent_id = ? AND scope = ?").all(designer.id, group.id) as any[];
  return { h, owner, designer, group, call, instruct, turns, stored };
}

test("an instruction marked fresh runs in a session of its own, with no history; the chat's session is left as it was", async () => {
  const s = await setup();
  try {
    const one = await s.instruct("!say first", { fresh: true, private: true });
    assert.equal(one.fresh, true);
    await s.instruct("!say second", { fresh: true, private: true });
    assert.deepEqual(await s.turns(), [1, 1], "each one a new session");
    assert.deepEqual(s.stored(), [], "neither is stored for the chat");

    // the chat's own session: kept, and resumed from turn to turn, whatever fresh turns come between
    await s.instruct("!say third");
    const chatSession = s.stored();
    assert.equal(chatSession.length, 1);
    await s.instruct("!say fourth", { fresh: true, private: true });
    await s.instruct("!say fifth");
    assert.deepEqual(await s.turns(), [1, 1, 1, 1, 2], "the chat's session reads its second turn");
    assert.deepEqual(s.stored(), chatSession, "the chat's session is the same one");
    assert.ok(((await s.owner.get(`/api/agents/${s.designer.id}/activity`)).json.activity as any[]).filter((e) => e.text === "a session of its own for this turn, with no history").length === 3);
  } finally {
    await s.h.close();
  }
});

test("fresh is true or false, and needs an agent; fresh alone keeps the reply in the chat", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", `/api/service/chats/${s.group.id}/messages`, { note: "A note.", fresh: true })).status, 400);
    assert.equal((await s.call("POST", `/api/service/chats/${s.group.id}/messages`, { note: "A note.", agent: "designer", text: "!say x", fresh: "yes" })).status, 400);
    const d = await s.instruct("!say In the chat", { fresh: true });
    const msgs = (await s.owner.get(`/api/chats/${s.group.id}/messages`)).json.messages as any[];
    assert.ok(msgs.some((m) => m.authorType === "agent" && m.body === "In the chat"), "not private: the reply is posted");
    assert.equal((await s.call("GET", `/api/service/deliveries/${d.id}/reply`)).status, 404, "and has no private reply");
  } finally {
    await s.h.close();
  }
});

test("a server that kept service_instructions from before fresh gets the column once, and keeps its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE service_instructions (delivery_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
  db.exec("INSERT INTO service_instructions VALUES ('d_1', 'svc_1', 1, 1)");
  instructionTables(db);
  instructionTables(db);
  assert.deepEqual({ ...(db.prepare("SELECT private, fresh FROM service_instructions").get() as any) }, { private: 1, fresh: 0 });
  assert.equal((db.prepare("SELECT count(*) AS n FROM pragma_table_info('service_instructions') WHERE name = 'fresh'").get() as any).n, 1);
});
