// SPDX-License-Identifier: AGPL-3.0-only
// Managed agents (server/src/managed.ts): marked by root, set from JSON on stdin by root, and locked
// against the API for every role, the owner included. A model change made outside the server
// restarts the agent before its next turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startApp, setupOwner, mockAgent, agentReply } from "./helpers.ts";
import { agentGet, agentModels, agentSet, manage, managedRefusal, parseSettings, MAX_INSTRUCTIONS } from "../server/src/managed.ts";
import { memberSession } from "../server/src/clisession.ts";

const WANT = { instructions: "You write made-up interviews.\n", model: "gw-writer:large", autonomy: "ask", sandbox: "local", budgetCents: 500 };

test("the settings from stdin: JSON with the managed fields only, each checked", () => {
  assert.deepEqual(parseSettings(JSON.stringify(WANT), ["gw-writer"]), WANT);
  for (const [text, why] of [
    ["not json", /JSON object/],
    ["[1]", /JSON object/],
    [JSON.stringify({ name: "x" }), /name is not a managed setting/],
    [JSON.stringify({ instructions: 5 }), /instructions must be text/],
    [JSON.stringify({ instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }), /over 20000/],
    [JSON.stringify({ model: "gw-gone:large" }), /names the provider "gw-gone", which the server does not have/],
    [JSON.stringify({ autonomy: "yolo" }), /autonomy must be/],
    [JSON.stringify({ sandbox: "vm" }), /sandbox must be/],
    [JSON.stringify({ budgetCents: 1.5 }), /budgetCents must be/],
    [JSON.stringify({ budgetCents: -1 }), /budgetCents must be/],
  ] as const)
    assert.throws(() => parseSettings(text, ["gw-writer"]), why, text);
  assert.deepEqual(parseSettings(JSON.stringify({ model: "large" }), []), { model: "large" }, "a model with no provider needs none");
});

test("manage, agent-set and agent-get: only a managed agent, only the fields that differ, and the instructions as a hash", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    await mockAgent(c, "writer");
    const db = h.app.db;
    assert.throws(() => agentSet(db, "writer", { autonomy: "ask" }), /not managed\. Mark it first/);
    assert.throws(() => manage(db, "nobody", true), /no agent @nobody/);
    assert.equal(manage(db, "@Writer", true), "managed");
    assert.equal(manage(db, "writer", true), "already managed");

    const settings = parseSettings(JSON.stringify({ ...WANT, model: "large" }), []);
    assert.deepEqual(agentSet(db, "writer", settings, { check: true }).sort(), ["autonomy", "budgetCents", "instructions", "model"]);
    assert.equal(agentGet(db, "writer").autonomy, "act", "--check changes nothing");
    assert.deepEqual(agentSet(db, "writer", settings).sort(), ["autonomy", "budgetCents", "instructions", "model"]);
    assert.deepEqual(agentSet(db, "writer", settings), [], "a second run changes nothing");
    const got = agentGet(db, "writer");
    assert.deepEqual(got, {
      handle: "writer",
      managed: true,
      model: "large",
      autonomy: "ask",
      sandbox: "local",
      budgetCents: 500,
      instructionsSha256: createHash("sha256").update(WANT.instructions).digest("hex"),
      instructionsLength: WANT.instructions.length,
      starters: [],
    });
    assert.match(agentModels(db), /^writer\tlarge$/m);
    assert.equal(manage(db, "writer", false), "unmanaged");
    assert.equal(manage(db, "writer", false), "was not managed");
  } finally {
    await h.close();
  }
});

test("the API refuses a managed agent's managed settings for every role, the owner included, and allows the rest", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const a = await mockAgent(owner, "writer");
    assert.equal((await owner.post("/api/users", { email: "person-a@example.com", name: "Person A", role: "builder" })).status, 200);
    const builder = memberSession(h.app.db, "person-a@example.com", 5).token;
    const asBuilder = (body: unknown) =>
      fetch(`${h.url}/api/agents/${a.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${builder}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await owner.patch(`/api/agents/${a.id}`, { autonomy: "ask" })).status, 200, "unmanaged: editable");
    manage(h.app.db, "writer", true);
    assert.equal((await owner.get(`/api/agents/${a.id}`)).json.agent.managed, true);
    for (const body of [
      { instructions: "pasted" },
      { model: "x" },
      { autonomy: "auto" },
      { sandbox: "docker" },
      { budgetCents: 0 },
      { name: "Writer", budgetCents: 1 },
    ]) {
      const r = await owner.patch(`/api/agents/${a.id}`, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.match(r.json.error, /managed: its .* come from the repository/);
      assert.equal((await asBuilder(body)).status, 403, `builder: ${JSON.stringify(body)}`);
    }
    const after = (await owner.get(`/api/agents/${a.id}`)).json.agent;
    assert.equal(after.autonomy, "ask");
    assert.equal(after.name, "Writer", "a refused request changes nothing, not even its other fields");
    assert.equal((await owner.patch(`/api/agents/${a.id}`, { name: "Writer Two", roleTitle: "Interviews" })).status, 200, "name and job stay editable");
    assert.equal(managedRefusal(h.app.db, a.id, { name: "x" }), null);
  } finally {
    await h.close();
  }
});

test(
  "the CLI commands: root only, with nothing on stdout and no change for anyone else",
  { skip: process.getuid?.() === 0 ? "running as root" : false },
  async () => {
    const h = await startApp();
    try {
      const c = await setupOwner(h);
      await mockAgent(c, "writer");
      const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
      const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
      for (const args of [["manage", "writer"], ["unmanage", "writer"], ["agent-get", "writer"], ["agent-set", "writer"], ["agent-models"]]) {
        const r = spawnSync("node", [cli, ...args], { env, input: JSON.stringify({ autonomy: "auto" }), encoding: "utf8" });
        assert.equal(r.status, 2, args[0]);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /only root may run this: use sudo/);
      }
      assert.equal(agentGet(h.app.db, "writer").managed, false);
    } finally {
      await h.close();
    }
  },
);

test("a model changed outside the server restarts the agent before its next turn", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    const a = await mockAgent(c, "writer");
    const chat = (await c.post("/api/chats", { dmAgent: a.id })).json.chat;
    const ask = async (body: string) => {
      const sent = (await c.post(`/api/chats/${chat.id}/messages`, { body })).json.message;
      return agentReply(c, chat.id, a.id, sent.ts);
    };
    await ask("hello");
    const starts = () => (h.app.runtime as any).workers.get(a.id).startedAs as string;
    const before = starts();
    await ask("again");
    assert.equal(starts(), before, "nothing changed: the same process");
    manage(h.app.db, "writer", true);
    agentSet(h.app.db, "writer", { model: "other-model" });
    await ask("after the change");
    assert.notEqual(starts(), before, "the worker started again with the new model");
    assert.match(starts(), /\|other-model\|/);
  } finally {
    await h.close();
  }
});
