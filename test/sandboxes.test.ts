// SPDX-License-Identifier: AGPL-3.0-only
// CIRCLECHAT_SANDBOXES=docker: no agent runs as a process on the server. The API refuses the
// local sandbox, and the runtime refuses to start an agent that would run on the server anyway,
// such as one whose engine has no Docker image (the test engines). Unset, both sandboxes work.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { startApp, setupOwner, waitFor, Client, type Harness } from "./helpers.ts";
import { allowedSandboxes, sandboxProblem, startProblem } from "../server/src/agents/sandboxes.ts";

const hermes = { name: "Hermes Agent", image: "circlechat/engine-hermes:latest" };
const testEngine = { name: "Test engine", image: "" };

test("the setting: both by default, docker alone, and a typo fails closed", () => {
  assert.deepEqual([...allowedSandboxes({})].sort(), ["docker", "local"]);
  assert.deepEqual([...allowedSandboxes({ CIRCLECHAT_SANDBOXES: "" })].sort(), ["docker", "local"]);
  assert.deepEqual([...allowedSandboxes({ CIRCLECHAT_SANDBOXES: "docker" })], ["docker"]);
  assert.deepEqual([...allowedSandboxes({ CIRCLECHAT_SANDBOXES: " Docker , local " })].sort(), ["docker", "local"]);
  assert.throws(() => allowedSandboxes({ CIRCLECHAT_SANDBOXES: "dockr" }), /"dockr" isn't a sandbox/);
  assert.throws(() => allowedSandboxes({ CIRCLECHAT_SANDBOXES: "," }), /lists no sandbox/);
});

test("what the API may save, and what the runtime may start", () => {
  const docker = { CIRCLECHAT_SANDBOXES: "docker" };
  assert.equal(sandboxProblem("docker", docker), null);
  assert.match(sandboxProblem("local", docker)!, /only the docker sandbox/);
  assert.equal(sandboxProblem("local", {}), null);
  assert.match(sandboxProblem("elsewhere", {})!, /must be docker or local/);

  assert.equal(startProblem("docker", hermes, docker), null);
  assert.match(startProblem("local", hermes, docker)!, /set to the local sandbox/);
  assert.match(startProblem("docker", testEngine, docker)!, /Test engine engine has no Docker image/);
  // anything but "docker" runs on the server, so it's refused too
  assert.match(startProblem("elsewhere", hermes, docker)!, /only Docker sandboxes/);
  assert.equal(startProblem("local", hermes, {}), null);
  assert.equal(startProblem("docker", testEngine, {}), null);
});

let h: Harness;
let c: Client;
before(async () => {
  process.env.CIRCLECHAT_SANDBOXES = "docker";
  h = await startApp();
  c = await setupOwner(h);
});
after(async () => {
  await h.close();
  delete process.env.CIRCLECHAT_SANDBOXES;
});

test("with docker only, the API refuses the local sandbox on add, edit and import", async () => {
  const local = await c.post("/api/agents", { name: "Designer", handle: "designer", engine: "hermes", sandbox: "local" });
  assert.equal(local.status, 400);
  assert.match(local.json.error, /only the docker sandbox/);

  const ok = await c.post("/api/agents", { name: "Designer", handle: "designer", engine: "hermes", sandbox: "docker" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const edit = await c.patch(`/api/agents/${ok.json.agent.id}`, { sandbox: "local" });
  assert.equal(edit.status, 400);
  assert.equal((await c.get(`/api/agents/${ok.json.agent.id}`)).json.agent.sandbox, "docker");

  const dir = join(h.dir, "import-me");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), "# Reviewer\nYou review pull requests.");
  for (const sandbox of ["local", "elsewhere"]) {
    const r = await c.post("/api/agents/import", { path: dir, engine: "hermes", sandbox });
    assert.equal(r.status, 400, `import with sandbox ${sandbox}`);
  }
  assert.equal((await c.post("/api/agents/import", { path: dir, engine: "hermes" })).status, 200);
});

test("with docker only, an agent whose engine has no image never starts, and the chat says why", async () => {
  const r = await c.post("/api/agents", { name: "Helper", handle: "helper", engine: "mock", sandbox: "docker" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const agent = r.json.agent;
  const chat = (await c.post("/api/chats", { dmAgent: agent.id })).json.chat;
  const sent = (await c.post(`/api/chats/${chat.id}/messages`, { body: "hello" })).json.message;
  const err = await waitFor(async () => {
    const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages as any[];
    return msgs.find((m) => m.ts > sent.ts && m.kind === "error" && m.meta?.agentId === agent.id);
  }, "the error card");
  assert.match(err.body, /could not start: this server allows only Docker sandboxes.*Test engine engine has no Docker image/);
  const msgs = (await c.get(`/api/chats/${chat.id}/messages`)).json.messages as any[];
  assert.ok(!msgs.some((m) => m.authorType === "agent" && m.authorId === agent.id), "the agent never answered");
  const act = (await c.get(`/api/agents/${agent.id}/activity`)).json.activity as any[];
  assert.ok(!act.some((e) => e.kind === "lifecycle" && /ready/.test(e.text)), "the engine never started");
});
