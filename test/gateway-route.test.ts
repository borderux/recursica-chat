// SPDX-License-Identifier: AGPL-3.0-only
// The gateway's route (server/src/gatewayroute.ts): a listener of its own, only with
// CIRCLECHAT_GATEWAY_PORT, bound to CIRCLECHAT_GATEWAY_HOST (127.0.0.1 by default), with its own key.
// Its four routes, the key that works there and nowhere else, the cloud switch's rules and its chat
// line, and the tasks of an agent's running turn. Generic settings only: speed, fast and slow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startApp, setupOwner, mockAgent, Client, type Harness } from "./helpers.ts";
import { startGatewayRoute } from "../server/src/gatewayroute.ts";
import { parseTaskSettings, useTaskSettings } from "../server/src/tasksettings.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";

const KEY = "example-gateway-key-0123456789abcdef";
const SETTINGS = parseTaskSettings({
  settings: [
    {
      key: "speed",
      label: "Speed",
      default: "slow",
      choices: [
        { value: "fast", label: "Fast" },
        { value: "slow", label: "Slow" },
      ],
    },
  ],
  stall_minutes: 20,
});

interface Rig {
  h: Harness;
  gw: Server;
  url: string;
  dir: string;
  owner: Client;
  ownerId: string;
  designer: any;
  writer: any;
  chat: any;
  other: any;
  task: any;
  close(): Promise<void>;
}

async function rig(env: Record<string, string> = {}): Promise<Rig> {
  const h = await startApp();
  useTaskSettings(h.app.db, SETTINGS);
  const dir = mkdtempSync(join(tmpdir(), "cc-gw-"));
  const keyFile = join(dir, "gateway.key");
  writeFileSync(keyFile, KEY + "\n", { mode: 0o600 });
  const gw = startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "0", CIRCLECHAT_GATEWAY_KEY_FILE: keyFile, ...env }, () => {})!;
  assert.ok(gw, "a listener with a port");
  if (!gw.listening) await once(gw, "listening");
  const a = gw.address() as AddressInfo;
  const owner = await setupOwner(h);
  const ownerId = (await owner.get("/api/me")).json.user.id;
  const designer = await mockAgent(owner, "designer");
  const writer = await mockAgent(owner, "writer");
  const chat = (await owner.post("/api/chats", { name: "acme launch", agents: [designer.id, writer.id] })).json.chat;
  const other = (await owner.post("/api/chats", { name: "example-app", agents: [designer.id] })).json.chat;
  const task = h.app.svc.createTask({ chatId: chat.id, title: "Draft the page", assigneeType: "agent", assigneeId: designer.id, createdBy: ownerId });
  return {
    h,
    gw,
    url: `http://${a.address}:${a.port}`,
    dir,
    owner,
    ownerId,
    designer,
    writer,
    chat,
    other,
    task,
    async close() {
      gw.closeAllConnections?.();
      await new Promise<void>((r) => gw.close(() => r()));
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}
const auth = (k = KEY) => ({ authorization: `Bearer ${k}` });

test("with the key, each of the four routes works", async () => {
  const r = await rig();
  try {
    const t = await call(r.url, "GET", `/gateway/tasks/${r.task.id}`, auth());
    assert.equal(t.status, 200);
    assert.deepEqual(t.json, { task: r.task.id, status: "todo", settings: { speed: "slow" }, open: true });
    assert.equal((await call(r.url, "GET", "/gateway/tasks/t_nope", auth())).status, 404);

    assert.deepEqual((await call(r.url, "GET", "/gateway/agents/designer/tasks", auth())).json, { tasks: [] }, "idle: none");
    assert.deepEqual((await call(r.url, "GET", `/gateway/agents/designer/tasks/${r.task.id}`, auth())).json, { on: true });

    const sw = await call(r.url, "POST", `/gateway/tasks/${r.task.id}/cloud-switch`, auth(), { n: 1, reason: "stalled" });
    assert.equal(sw.status, 201);

    // unknown routes and wrong methods, with the key
    assert.equal((await call(r.url, "GET", "/gateway/tasks", auth())).status, 404);
    assert.equal((await call(r.url, "GET", "/api/tasks", auth())).status, 404, "nothing of the main API here");
    assert.equal((await call(r.url, "GET", "/healthz", auth())).status, 404);
    assert.equal((await call(r.url, "DELETE", `/gateway/tasks/${r.task.id}`, auth())).status, 405);
    assert.equal((await call(r.url, "GET", `/gateway/tasks/${r.task.id}/cloud-switch`, auth())).status, 405);
  } finally {
    await r.close();
  }
});

test("a wrong key, no key, a session, an agent's token or a service account's key: 401 on every route", async () => {
  const r = await rig();
  try {
    const agentToken = r.h.app.gateway.issueToken(r.designer.id, r.chat.id, { type: "user", id: r.ownerId });
    serviceCommand(r.h.app.db, "service-create", ["example-service"]);
    const serviceKey = serviceCommand(r.h.app.db, "service-token", ["example-service"]).stdout ?? "";
    assert.ok(serviceKey.length > 20);
    const creds: [string, Record<string, string>][] = [
      ["no key", {}],
      ["a wrong key", auth("example-wrong-key")],
      ["the key with one character more", auth(KEY + "x")],
      ["the key without Bearer", { authorization: KEY }],
      ["a session cookie", { cookie: r.owner.cookie }],
      ["a session as a bearer", auth(r.owner.cookie.split("=")[1])],
      ["an agent's token", auth(agentToken)],
      ["a service account's key", auth(serviceKey)],
    ];
    const routes: [string, string, unknown?][] = [
      ["GET", `/gateway/tasks/${r.task.id}`],
      ["GET", "/gateway/agents/designer/tasks"],
      ["GET", `/gateway/agents/designer/tasks/${r.task.id}`],
      ["POST", `/gateway/tasks/${r.task.id}/cloud-switch`, { n: 1, reason: "stalled" }],
      ["GET", "/gateway/nothing-here"],
    ];
    for (const [why, headers] of creds)
      for (const [m, p, b] of routes) {
        const res = await call(r.url, m, p, headers, b);
        assert.equal(res.status, 401, `${why}: ${m} ${p}`);
        assert.deepEqual(res.json, { error: "unauthorized" }, "no detail");
      }
    assert.equal((r.h.app.db.prepare("SELECT COUNT(*) AS n FROM task_cloud_switches").get() as any).n, 0, "nothing recorded");
  } finally {
    await r.close();
  }
});

test("no key file: the listener refuses everything", async () => {
  const r = await rig({ CIRCLECHAT_GATEWAY_KEY_FILE: "/nonexistent/example/gateway.key" });
  try {
    assert.equal((await call(r.url, "GET", `/gateway/tasks/${r.task.id}`, auth())).status, 401);
    assert.equal((await call(r.url, "GET", `/gateway/tasks/${r.task.id}`, auth(""))).status, 401);
  } finally {
    await r.close();
  }
});

test("the main port never serves /gateway/..., even with the right key", async () => {
  const r = await rig();
  try {
    for (const p of [`/gateway/tasks/${r.task.id}`, "/gateway/agents/designer/tasks", `/gateway/agents/designer/tasks/${r.task.id}`, "/gateway", "/gateway/", "/GATEWAY/tasks/x", "/gateway?x=1"]) {
      const res = await call(r.h.url, "GET", p, { ...auth(), cookie: r.owner.cookie });
      assert.equal(res.status, 404, p);
    }
    const sw = await call(r.h.url, "POST", `/gateway/tasks/${r.task.id}/cloud-switch`, { ...auth(), origin: r.h.url, cookie: r.owner.cookie }, { n: 1, reason: "stalled" });
    assert.equal(sw.status, 404);
    assert.equal(r.h.app.svc.task(r.task.id).cloud, null, "nothing recorded");
  } finally {
    await r.close();
  }
});

test("without CIRCLECHAT_GATEWAY_PORT there is no listener; it binds to 127.0.0.1 by default, or to the host given", async () => {
  const h = await startApp();
  try {
    assert.equal(startGatewayRoute(h.app, {}), null, "unset");
    assert.equal(startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "" }), null, "empty");
    assert.equal(startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "not-a-port" }), null, "not a port");
    assert.equal(startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "70000" }), null, "out of range");

    const gw = startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "0" }, () => {})!;
    if (!gw.listening) await once(gw, "listening");
    const a = gw.address() as AddressInfo;
    assert.equal(a.address, "127.0.0.1", "loopback by default");
    // another address of this computer doesn't reach it
    // a wired or wireless card's address (en*, eth*), not a VPN's
    const lan = Object.entries(networkInterfaces())
      .filter(([name]) => /^(en|eth)\d/.test(name))
      .flatMap(([, l]) => l ?? [])
      .find((i) => i.family === "IPv4" && !i.internal);
    if (lan) await assert.rejects(fetch(`http://${lan.address}:${a.port}/gateway/tasks/x`, { signal: AbortSignal.timeout(3000) }), `not on ${lan.address}`);
    await new Promise<void>((r) => gw.close(() => r()));

    const v6 = startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "0", CIRCLECHAT_GATEWAY_HOST: "::1" }, () => {})!;
    const up = await Promise.race([once(v6, "listening").then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
    if (up) {
      assert.equal((v6.address() as AddressInfo).address, "::1", "the host given");
      await assert.rejects(fetch(`http://127.0.0.1:${(v6.address() as AddressInfo).port}/gateway/tasks/x`, { signal: AbortSignal.timeout(3000) }), "not on 127.0.0.1");
    }
    await new Promise<void>((r) => v6.close(() => r()));
  } finally {
    await h.close();
  }
});

test("the cloud switch: recorded for an open task, with a system line and the task's cloud mark", async () => {
  const r = await rig();
  try {
    const before = Date.now();
    const sw = await call(r.url, "POST", `/gateway/tasks/${r.task.id}/cloud-switch`, auth(), { n: 1, reason: "stalled" });
    assert.equal(sw.status, 201);
    const t = (await r.owner.get("/api/tasks")).json.tasks.find((x: any) => x.id === r.task.id);
    assert.equal(t.cloud.reason, "stalled");
    assert.ok(t.cloud.since >= before && t.cloud.since <= Date.now());
    assert.match(t.cloud.text, /^Draft the page moved to a cloud model at \d\d:\d\d \S+: the local models gave no answer for 20 minutes\.$/);
    const msgs = (await r.owner.get(`/api/chats/${r.chat.id}/messages`)).json.messages;
    const line = msgs.find((m: any) => m.kind === "system" && m.meta?.taskId === r.task.id);
    assert.ok(line, "a system line in the task's chat");
    assert.equal(line.authorType, "system");
    assert.equal(line.body, t.cloud.text, "the same text");

    // a second switch for the same task: the latest shows, with the setting's label
    assert.equal((await r.owner.put(`/api/tasks/${r.task.id}/settings`, { speed: "fast" })).status, 200);
    assert.equal((await call(r.url, "POST", `/gateway/tasks/${r.task.id}/cloud-switch`, auth(), { n: 2, reason: "cloud_from_start" })).status, 201);
    const t2 = r.h.app.svc.task(r.task.id);
    assert.equal(t2.cloud.reason, "cloud_from_start");
    assert.equal(t2.cloud.text, "Draft the page uses a cloud model from the start, as its Speed setting asks.");
    const g = await call(r.url, "GET", `/gateway/tasks/${r.task.id}`, auth());
    assert.deepEqual(g.json.settings, { speed: "fast" }, "the gateway reads the changed setting");
  } finally {
    await r.close();
  }
});

test("the cloud switch: duplicate n is 200 and changes nothing; bad input 400; missing 404; done, cancelled or archived 409", async () => {
  const r = await rig();
  try {
    const path = `/gateway/tasks/${r.task.id}/cloud-switch`;
    assert.equal((await call(r.url, "POST", path, auth(), { n: 1, reason: "stalled" })).status, 201);
    const lines = () => (r.h.app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'system' AND chat_id = ?").get(r.chat.id) as any).n;
    const rows = () => r.h.app.db.prepare("SELECT * FROM task_cloud_switches ORDER BY n").all();
    const was = { lines: lines(), rows: JSON.stringify(rows()) };
    const dup = await call(r.url, "POST", path, auth(), { n: 1, reason: "cloud_from_start" });
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.json, { duplicate: true });
    assert.equal(lines(), was.lines, "no second line");
    assert.equal(JSON.stringify(rows()), was.rows, "the row unchanged");

    const bad: [string, unknown][] = [
      ["another reason", { n: 2, reason: "faster" }],
      ["free text", { n: 2, reason: "stalled", text: "the local models were slow" }],
      ["a note as the reason", { n: 2, reason: "stalled because the model was slow" }],
      ["n of 0", { n: 0, reason: "stalled" }],
      ["negative n", { n: -1, reason: "stalled" }],
      ["fractional n", { n: 1.5, reason: "stalled" }],
      ["n as text", { n: "2", reason: "stalled" }],
      ["no n", { reason: "stalled" }],
      ["no reason", { n: 2 }],
      ["a list", [2, "stalled"]],
      ["nothing", undefined],
    ];
    for (const [why, body] of bad) assert.equal((await call(r.url, "POST", path, auth(), body)).status, 400, why);
    const raw = await fetch(r.url + path, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: "{ not json" });
    assert.equal(raw.status, 400, "not JSON");
    const big = await fetch(r.url + path, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ n: 2, reason: "stalled", pad: "x".repeat(10_000) }) });
    assert.equal(big.status, 400, "too large");
    assert.equal(rows().length, 1, "nothing else recorded");

    assert.equal((await call(r.url, "POST", "/gateway/tasks/t_nope/cloud-switch", auth(), { n: 1, reason: "stalled" })).status, 404);

    const { svc } = r.h.app;
    const mk = (title: string) => svc.createTask({ chatId: r.chat.id, title, createdBy: r.ownerId });
    const done = mk("Done task");
    svc.updateTask(done.id, { status: "done" });
    const cancelled = mk("Cancelled task");
    svc.updateTask(cancelled.id, { status: "cancelled" });
    const archived = mk("Archived task");
    assert.equal((await r.owner.post(`/api/tasks/${archived.id}/archive`)).status, 200);
    const inArchivedChat = svc.createTask({ chatId: r.other.id, title: "In an archived chat", createdBy: r.ownerId });
    assert.equal((await r.owner.post(`/api/chats/${r.other.id}/archive`)).status, 200);
    for (const t of [done, cancelled, archived, inArchivedChat]) {
      const res = await call(r.url, "POST", `/gateway/tasks/${t.id}/cloud-switch`, auth(), { n: 1, reason: "stalled" });
      assert.equal(res.status, 409, t.title);
      const g = await call(r.url, "GET", `/gateway/tasks/${t.id}`, auth());
      assert.equal(g.json.open, false, `${t.title}: not open`);
      assert.equal(svc.task(t.id).cloud, null);
    }
  } finally {
    await r.close();
  }
});

test("running tasks: the agent's open assigned tasks in its running turn's chat; none when idle; and on", async () => {
  const r = await rig();
  try {
    const { svc, runtime } = r.h.app;
    const mk = (chatId: string, title: string, to: string, status = "todo") => {
      const t = svc.createTask({ chatId, title, assigneeType: "agent", assigneeId: to, createdBy: r.ownerId });
      if (status !== "todo") svc.updateTask(t.id, { status });
      return t.id as string;
    };
    const working = mk(r.chat.id, "Working", r.designer.id, "working");
    const needs = mk(r.chat.id, "Needs you", r.designer.id, "needs_you");
    const checking = mk(r.chat.id, "Checking", r.designer.id, "checking");
    const done = mk(r.chat.id, "Done", r.designer.id, "done");
    const cancelled = mk(r.chat.id, "Cancelled", r.designer.id, "cancelled");
    const archived = mk(r.chat.id, "Archived", r.designer.id);
    await r.owner.post(`/api/tasks/${archived}/archive`);
    mk(r.chat.id, "The writer's", r.writer.id);
    const elsewhere = mk(r.other.id, "In another chat", r.designer.id);
    const running = async (handle: string) => (await call(r.url, "GET", `/gateway/agents/${handle}/tasks`, auth())).json.tasks;

    assert.deepEqual(await running("designer"), [], "idle: none");
    assert.deepEqual(await running("nobody"), [], "unknown: none");
    const worker = runtime.worker(r.designer.id);
    worker.status = { state: "working", detail: "", since: Date.now(), heartbeat: Date.now(), chatId: r.chat.id };
    assert.deepEqual(new Set(await running("designer")), new Set([r.task.id, working, needs, checking]), "open, assigned, in the turn's chat");
    assert.deepEqual(await running(r.designer.id), [], "by handle only, not by id");
    worker.status = { ...worker.status, state: "waiting_approval" };
    assert.equal((await running("designer")).length, 4, "a turn waiting on an approval still runs");
    worker.status = { ...worker.status, chatId: r.other.id, state: "working" };
    assert.deepEqual(await running("designer"), [elsewhere], "follows the turn to its chat");
    worker.status = { state: "idle", detail: "", since: Date.now(), heartbeat: Date.now() };
    assert.deepEqual(await running("designer"), [], "idle again");
    for (const id of [done, cancelled]) assert.ok(!(await running("designer")).includes(id));

    const on = async (handle: string, id: string) => (await call(r.url, "GET", `/gateway/agents/${handle}/tasks/${id}`, auth())).json.on;
    assert.equal(await on("designer", working), true, "assigned");
    assert.equal(await on("writer", working), false, "neither created nor assigned");
    const byWriter = svc.createTask({ chatId: r.chat.id, title: "Writer's own", createdBy: r.writer.id }).id;
    assert.equal(await on("writer", byWriter), true, "created by it");
    assert.equal(await on("designer", byWriter), false);
    assert.equal(await on("nobody", working), false, "unknown agent");
    assert.equal(await on("designer", "t_nope"), false, "unknown task");
  } finally {
    await r.close();
  }
});
