// SPDX-License-Identifier: AGPL-3.0-only
// The origin check: a browser request that changes something, or opens the event socket, must come
// from this app's own pages (CIRCLECHAT_PUBLIC_URL). Webhooks, the agents' tool endpoint and the
// model proxy are not browser paths and are not checked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { allowedOrigins, originProblem } from "../server/src/origin.ts";
import { startApp, setupOwner, mockAgent, agentReply, Client, type Harness } from "./helpers.ts";
import { hmac } from "../server/src/crypto.ts";

// ---------------------------------------------------------------- the rule

test("CIRCLECHAT_PUBLIC_URL: unset, one address, several, and a bad value fails closed", () => {
  assert.equal(allowedOrigins({}), null);
  assert.equal(allowedOrigins({ CIRCLECHAT_PUBLIC_URL: " " }), null);
  assert.deepEqual(allowedOrigins({ CIRCLECHAT_PUBLIC_URL: "https://chat.example.com/some/path" }), ["https://chat.example.com"]);
  assert.deepEqual(allowedOrigins({ CIRCLECHAT_PUBLIC_URL: "https://chat.example.com, https://desk.example.com:8443" }), ["https://chat.example.com", "https://desk.example.com:8443"]);
  assert.throws(() => allowedOrigins({ CIRCLECHAT_PUBLIC_URL: "chat.example.com" }), /isn't an address/);
  assert.throws(() => allowedOrigins({ CIRCLECHAT_PUBLIC_URL: "ftp://chat.example.com" }), /must start with/);
});

test("with the setting: only its origins may change anything", () => {
  const allowed = ["https://chat.example.com"];
  const post = (r: Partial<Parameters<typeof originProblem>[0]>) => originProblem({ method: "POST", host: "127.0.0.1:3100", ...r }, allowed);
  assert.equal(post({ origin: "https://chat.example.com" }), null, "its own page, behind a proxy");
  assert.match(post({ origin: "https://chat.example.com:8443" })!, /doesn't accept requests from/, "another port on the same host");
  assert.match(post({ origin: "https://other.example.com" })!, /doesn't accept/, "a sibling host");
  assert.match(post({ origin: "http://chat.example.com" })!, /doesn't accept/, "plain http");
  assert.match(post({ origin: "null" })!, /doesn't accept/, "a sandboxed or file page");
  assert.match(post({ origin: "http://127.0.0.1:3100" })!, /doesn't accept/, "loopback is not listed");
  for (const m of ["PUT", "PATCH", "DELETE", "post"]) assert.ok(originProblem({ method: m, origin: "https://evil.example" }, allowed), m);
  for (const m of ["GET", "HEAD", "OPTIONS"]) assert.equal(originProblem({ method: m, origin: "https://evil.example" }, allowed), null, `${m} changes nothing`);
  assert.ok(originProblem({ method: "GET", socket: true, origin: "https://evil.example" }, allowed), "the event socket is checked");
});

test("without the setting: only a loopback page on the server's own host and port, so it fails closed elsewhere", () => {
  const post = (origin: string, host: string) => originProblem({ method: "POST", origin, host }, null);
  assert.equal(post("http://127.0.0.1:3100", "127.0.0.1:3100"), null);
  assert.equal(post("http://localhost:3100", "localhost:3100"), null);
  assert.equal(post("http://[::1]:3100", "[::1]:3100"), null);
  assert.ok(post("http://127.0.0.1:5173", "127.0.0.1:3100"), "another loopback port");
  assert.ok(post("https://chat.example.com", "127.0.0.1:3100"), "behind a proxy, unset: refused");
  assert.ok(post("http://chat.example.com:3100", "chat.example.com:3100"), "a real address, even matching Host: refused");
  assert.ok(post("http://127.0.0.1:3100", ""), "no Host header");
});

test("without Origin: Sec-Fetch-Site, then no session cookie for clients that aren't browsers", () => {
  const p = (r: Partial<Parameters<typeof originProblem>[0]>) => originProblem({ method: "POST", ...r }, ["https://chat.example.com"]);
  assert.equal(p({ secFetchSite: "same-origin", cookie: "cc_session=abc" }), null);
  assert.match(p({ secFetchSite: "same-site", cookie: "cc_session=abc" })!, /same-site/);
  assert.match(p({ secFetchSite: "cross-site" })!, /cross-site/);
  assert.equal(p({}), null, "a script with no cookie, such as one signing in or using an API token");
  assert.equal(p({ cookie: "theme=dark" }), null, "another cookie isn't a session");
  assert.match(p({ cookie: "theme=dark; cc_session=abc" })!, /must come from this app's own pages/);
});

// ---------------------------------------------------------------- the real server, setting unset

let h: Harness;
let c: Client;
before(async () => {
  delete process.env.CIRCLECHAT_PUBLIC_URL;
  h = await startApp();
  c = await setupOwner(h);
});
after(async () => {
  await h.close();
});

const raw = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  fetch(h.url + path, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...init.headers }, body: init.body ?? "{}" });

test("the API refuses a signed-in change from another origin, or with no origin, and keeps nothing", async () => {
  const chats = async () => ((await c.get("/api/chats")).json.chats as any[]).length;
  const n = await chats();
  const body = JSON.stringify({ name: "Planning", agents: [] });
  const otherPort = h.url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
  const refused: Record<string, string>[] = [{ origin: otherPort }, { origin: "https://evil.example" }, {}, { "sec-fetch-site": "same-site" }];
  for (const headers of refused) {
    const r = await raw("/api/chats", { headers: { cookie: c.cookie, ...headers }, body });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal(await chats(), n, "no chat was created");
  // the app's own page, by Origin or by Sec-Fetch-Site
  assert.equal((await raw("/api/chats", { headers: { cookie: c.cookie, origin: h.url }, body })).status, 200);
  assert.equal((await raw("/api/chats", { headers: { cookie: c.cookie, "sec-fetch-site": "same-origin" }, body })).status, 200);
  // a signed-in read is never refused: CORS already keeps other pages from reading the answer
  assert.equal((await fetch(h.url + "/api/me", { headers: { cookie: c.cookie, origin: "https://evil.example" } })).status, 200);
});

test("signing in from another page is refused; a script signing in, or using a token, is not", async () => {
  assert.equal((await c.post("/api/users", { email: "person-a@example.com", name: "Person A", password: "example-password-2", role: "member" })).status, 200);
  const login = JSON.stringify({ email: "person-a@example.com", password: "example-password-2" });
  assert.equal((await raw("/api/login", { headers: { origin: "https://evil.example" }, body: login })).status, 403);
  const script = await raw("/api/login", { body: login });
  assert.equal(script.status, 200);
  const tok = /cc_session=([^;]+)/.exec(script.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(tok);
  const r = await raw("/api/chats", { headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ name: "From a script", agents: [] }) });
  assert.equal(r.status, 200, "an API token isn't a browser session");
});

test("webhooks, the agents' tool endpoint and the model proxy aren't browser paths, and aren't checked", async () => {
  const agent = await mockAgent(c, "helper");
  const chat = (await c.post("/api/chats", { dmAgent: agent.id })).json.chat;
  const t = (await c.post("/api/triggers", { kind: "webhook", name: "deploys", chatId: chat.id, agentId: agent.id, prompt: "A deploy: {{text}}", secret: "example-hook-secret" })).json.trigger;
  assert.ok(t?.id, "trigger created");
  const sent = Date.now();
  const payload = JSON.stringify({ text: "done" });
  const hook = await fetch(`${h.url}/hooks/${t.id}`, { method: "POST", headers: { "x-hub-signature-256": "sha256=" + hmac("example-hook-secret", payload), origin: "https://hooks.example" }, body: payload });
  assert.equal(hook.status, 202, "a signed webhook from anywhere is delivered");
  // the agent really got it (and its turn ends before the app closes)
  assert.match((await agentReply(c, chat.id, agent.id, sent - 1)).body, /deploy/i);
  for (const path of ["/mcp/not-a-real-token", "/llm/not-a-real-token/v1/chat/completions"]) {
    const r = await raw(path, { headers: { origin: "https://evil.example" } });
    assert.notEqual(r.status, 403, `${path} answers with its own token check`);
  }
});

test("the event socket opens only for the app's own pages", async () => {
  const open = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers });
      ws.on("message", (m) => {
        resolve(JSON.parse(String(m)).type);
        ws.close();
      });
      ws.on("error", () => resolve("refused"));
      ws.on("close", () => resolve("refused"));
    });
  assert.equal(await open({ cookie: c.cookie, origin: h.url }), "hello");
  assert.equal(await open({ cookie: c.cookie, origin: "https://evil.example" }), "refused");
  assert.equal(await open({ cookie: c.cookie }), "refused", "a session with no origin");
});

// ---------------------------------------------------------------- the real server, behind a proxy

test("with CIRCLECHAT_PUBLIC_URL, the proxy's address works and loopback pages don't", async () => {
  process.env.CIRCLECHAT_PUBLIC_URL = "https://chat.example.com";
  const p = await startApp();
  try {
    const owner = await setupOwner(p).catch(() => null); // the helper sends a loopback Origin
    assert.equal(owner, null, "a loopback page can't set the workspace up once the address is set");
    const setup = await fetch(p.url + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://chat.example.com" },
      body: JSON.stringify({ email: "owner@example.com", name: "Owner", password: "example-password-1", workspace: "Example" }),
    });
    assert.equal(setup.status, 200, "the public address can");
  } finally {
    await p.close();
    delete process.env.CIRCLECHAT_PUBLIC_URL;
  }
});
