// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts set-provider / provider-key-hash (server/src/cliprovider.ts): a provider and its key, set by
// root on the server, with the key on stdin. And a model that names a missing provider: the turn is
// refused, never handed to another provider of the same kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startApp, setupOwner, waitFor } from "./helpers.ts";
import { CLI_LABEL, providerArgs, setProvider, providerKeyHash } from "../server/src/cliprovider.ts";
import { pickProvider } from "../server/src/agents/runtime.ts";

const KEY = "key_example_0123456789abcdef";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("cli set-provider: the arguments", () => {
  assert.deepEqual(providerArgs(["gw-designer", "--base-url", "http://127.0.0.1:4005/v1", "--models", "large, small"]), {
    id: "gw-designer",
    baseUrl: "http://127.0.0.1:4005/v1",
    models: ["large", "small"],
  });
  assert.deepEqual(providerArgs(["acme", "--models", "large", "--base-url", "https://models.example.com/v1"]).models, ["large"]);
  for (const bad of [
    [],
    ["Bad Id", "--base-url", "http://x/v1", "--models", "m"],
    ["acme", "--base-url", "ftp://x", "--models", "m"],
    ["acme", "--base-url", "http://x/v1"],
    ["acme", "--base-url", "http://x/v1", "--models", " , "],
    ["acme", "--base-url", "http://x/v1", "--models", "m", "--key", "k"],
    ["acme", "--base-url", "http://x/v1", "--base-url", "http://y/v1", "--models", "m"],
  ])
    assert.throws(() => providerArgs(bad), Error, JSON.stringify(bad));
});

test("cli set-provider: adds and updates its own provider, keeps the key on empty stdin, and never touches the app's", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const app = h.app;
    const p = { id: "gw-designer", baseUrl: "http://127.0.0.1:4005/v1", models: ["large"] };

    assert.equal(providerKeyHash(app, p.id), "", "no provider yet");
    assert.throws(() => setProvider(app, p, ""), /is new: stdin must hold its key/);
    assert.equal(setProvider(app, p, `${KEY}\n`), "added");
    assert.equal(providerKeyHash(app, p.id), sha(KEY), "the trailing line break is not part of the key");
    const listed = (await owner.get("/api/providers")).json.providers.find((x: any) => x.id === p.id);
    assert.equal(listed.kind, "openai-compatible");
    assert.equal(listed.label, CLI_LABEL(p.id), "the app shows who set the provider");
    assert.equal(listed.hasKey, true);
    assert.equal(JSON.stringify(listed).includes(KEY), false, "the API never shows the key");

    assert.equal(setProvider(app, { ...p, models: ["large", "small"] }, ""), "updated");
    assert.equal(providerKeyHash(app, p.id), sha(KEY), "empty stdin keeps the stored key");
    assert.equal(setProvider(app, p, "key_example_new_0123456789"), "updated");
    assert.equal(providerKeyHash(app, p.id), sha("key_example_new_0123456789"));
    assert.throws(() => setProvider(app, p, "two words"), /one line/);
    assert.throws(() => setProvider(app, p, "line\nline"), /one line/);

    const made = await owner.put("/api/providers/acme", { kind: "openai-compatible", baseUrl: "https://models.example.com/v1", apiKey: KEY, models: ["m"] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.throws(() => setProvider(app, { ...p, id: "acme" }, "key_example_other_0123456"), /added in the app/);
    assert.equal(providerKeyHash(app, "acme"), sha(KEY), "the app's provider keeps its key");
  } finally {
    await h.close();
  }
});

test(
  "cli set-provider and provider-key-hash: refused for anyone but root, with nothing on stdout and no change",
  { skip: process.getuid?.() === 0 ? "running as root" : false },
  async () => {
    const h = await startApp();
    try {
      await setupOwner(h);
      const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
      const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
      for (const args of [
        ["set-provider", "gw-designer", "--base-url", "http://127.0.0.1:4005/v1", "--models", "large"],
        ["provider-key-hash", "gw-designer"],
      ]) {
        const r = spawnSync("node", [cli, ...args], { env, input: KEY, encoding: "utf8" });
        assert.equal(r.status, 2, args[0]);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /only root may run this: use sudo/);
      }
      assert.equal(providerKeyHash(h.app, "gw-designer"), "");
    } finally {
      await h.close();
    }
  },
);

test("a model that names a missing provider is refused, never given another provider of the same kind", () => {
  const all = [
    { id: "acme", kind: "openai-compatible", baseUrl: "https://models.example.com/v1", apiKey: "a", models: ["m"] },
    { id: "gw-designer", kind: "openai-compatible", baseUrl: "http://127.0.0.1:4005/v1", apiKey: "b", models: ["large"] },
  ] as any[];
  assert.equal(pickProvider(all, ["openai-compatible"], "gw-designer:large")?.id, "gw-designer");
  assert.deepEqual(pickProvider(all, ["openai-compatible"], "gw-designer:small")?.models, ["small", "large"]);
  assert.equal(pickProvider(all, ["openai-compatible"], "large")?.id, "acme", "a model with no provider still takes the first of its kind");
  assert.throws(() => pickProvider(all, ["openai-compatible"], "gw-gone:large"), /names the provider "gw-gone", which doesn't exist/);
});

test("an agent whose model names a missing provider never starts, and the chat says why", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    const made = await c.post("/api/agents", { name: "Designer", handle: "designer", engine: "mock", sandbox: "local", model: "gw-gone:large" });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const agent = made.json.agent;
    const chat = (await c.post("/api/chats", { dmAgent: agent.id })).json.chat;
    const sent = (await c.post(`/api/chats/${chat.id}/messages`, { body: "hello" })).json.message;
    const err = await waitFor(async () => {
      const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages as any[];
      return msgs.find((m) => m.ts > sent.ts && m.kind === "error" && m.meta?.agentId === agent.id);
    }, "the error card");
    assert.match(err.body, /could not start: .*names the provider "gw-gone", which doesn't exist/);
    const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages as any[];
    assert.ok(!msgs.some((m) => m.authorType === "agent" && m.authorId === agent.id), "the agent never answered");
  } finally {
    await h.close();
  }
});
