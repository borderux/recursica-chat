// SPDX-License-Identifier: AGPL-3.0-only
// Tool policy hardening, with CIRCLECHAT_TOOL_DEFAULT=block:
//   1. a connected app's tool with no rule is blocked;
//   2. a never-list, checked before any rule or answer, that nothing can change: merging and
//      deleting on GitHub, by the GitHub app's tools, by an HTTP connection to api.github.com
//      (REST or GraphQL), or by GitHub's MCP tool names;
//   3. a Block always outranks a chat-scoped Allow from an earlier "Always" answer;
//   4. changing a tool policy, and answering "Always", are for admins only.
// It also covers the three ways around a block on merging: a builder changing the rule, a generic
// HTTP connection to GitHub's API, and an MCP server's own merge tool.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { toolDefault, neverByName, neverHttp } from "../server/src/toolpolicy.ts";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, fakeServer, Client, type Harness } from "./helpers.ts";
import { noOutsideNetwork, type NetworkGuard } from "./no-network.ts";

// ---------------------------------------------------------------- the rules

test("CIRCLECHAT_TOOL_DEFAULT: block, or unset; anything else fails closed", () => {
  assert.equal(toolDefault({}), null);
  assert.equal(toolDefault({ CIRCLECHAT_TOOL_DEFAULT: " Block " }), "block");
  for (const v of ["allow", "ask", "blok"]) assert.throws(() => toolDefault({ CIRCLECHAT_TOOL_DEFAULT: v }), /isn't supported/, v);
});

test("the never-list by name: the GitHub app's tools, and GitHub's MCP tool names on any MCP server", () => {
  assert.ok(neverByName("github_merge_pull_request", "connection"));
  assert.ok(neverByName("github_delete_branch", "connection"));
  assert.ok(neverByName("GitHub_Merge_Pull_Request"));
  assert.ok(neverByName("example_github__merge_pull_request", "mcp"));
  assert.ok(neverByName("example_github__delete_branch", "mcp"));
  assert.equal(neverByName("github_create_pull_request", "connection"), null);
  assert.equal(neverByName("example_github__create_pull_request", "mcp"), null);
  assert.equal(neverByName("example_docs__merge_pull_request_notes", "mcp"), null, "only the exact name");
  assert.equal(neverByName("merge_pull_request", "connection"), null, "the MCP names apply to MCP tools");
});

test("the never-list for HTTP calls to api.github.com: merges and deletes, by REST or GraphQL, however the path is written", () => {
  const gh = (p: string) => new URL("https://api.github.com" + p);
  const never = [
    ["PUT", "/repos/acme/example-app/pulls/7/merge"],
    ["PUT", "/repos/acme/example-app/pulls/7/merge/"],
    ["PUT", "/REPOS/Acme/Example-App/PULLS/7/MERGE"],
    ["PUT", "/repos/acme/example-app/pulls/7/%6Derge"],
    ["PUT", "/repos/acme/example-app/pulls/7/merge?x=1"],
    ["PUT", "/repos/acme/example-app/issues/../pulls/7/merge"],
    ["POST", "/repos/acme/example-app/merges"],
    ["DELETE", "/repos/acme/example-app/git/refs/heads/main"],
    ["DELETE", "/repos/acme/example-app/git/refs/tags/v1"],
    ["DELETE", "/repos/acme/example-app"],
    ["DELETE", "/repos/acme/example-app/"],
    ["PUT", "/repos/acme/example-app/pulls/7/%E0%A4%A"], // can't be decoded: refused
  ];
  for (const [m, p] of never) assert.ok(neverHttp(m, gh(p)), `${m} ${p}`);
  const fine = [
    ["GET", "/repos/acme/example-app/pulls/7/merge"], // asks whether it was merged
    ["PUT", "/repos/acme/example-app/pulls/7"],
    ["PATCH", "/repos/acme/example-app/pulls/7"],
    ["POST", "/repos/acme/example-app/pulls"],
    ["DELETE", "/repos/acme/example-app/issues/comments/1"],
    ["GET", "/repos/acme/example-app"],
  ];
  for (const [m, p] of fine) assert.equal(neverHttp(m, gh(p)), null, `${m} ${p}`);
  assert.equal(neverHttp("PUT", new URL("https://git.example.com/repos/acme/example-app/pulls/7/merge")), null, "only api.github.com");
  const q = (query: string) => neverHttp("POST", gh("/graphql"), { query });
  for (const m of ["mergePullRequest", "enablePullRequestAutoMerge", "mergeBranch", "deleteRef", "deleteRepository"]) {
    assert.ok(q(`mutation { x: ${m}(input: {}) { clientMutationId } }`), m);
  }
  assert.ok(neverHttp("POST", gh("/graphql"), '{"query":"mutation{deleteRef(input:{refId:\\"x\\"}){clientMutationId}}"}'), "as a string body");
  assert.equal(q("mutation { createIssue(input: {}) { issue { number } } }"), null);
  assert.equal(q("query { repository(owner: \"acme\", name: \"example-app\") { name } }"), null);
});

// ---------------------------------------------------------------- the real server, default block

let h: Harness;
let owner: Client;
let builder: Client;
let agent: any;
let chat: any;
let gh: Awaited<ReturnType<typeof fakeServer>>;
let conn: any;
let guard: NetworkGuard;
const REPO = "acme/example-app";

before(async () => {
  // Nothing in this file may reach the internet, even if the never-list breaks: any connection or
  // lookup that isn't for loopback is refused before it happens, and recorded.
  guard = noOutsideNetwork();
  process.env.CIRCLECHAT_TOOL_DEFAULT = "block";
  h = await startApp({ approvalTtlMs: 20_000 });
  owner = await setupOwner(h);
  assert.equal((await owner.post("/api/users", { email: "person-b@example.com", name: "Person B", password: "example-password-3", role: "builder" })).status, 200);
  builder = new Client(h.url);
  assert.equal((await builder.post("/api/login", { email: "person-b@example.com", password: "example-password-3" })).status, 200);
  agent = await mockAgent(owner, "designer");
  chat = (await owner.post("/api/chats", { dmAgent: agent.id })).json.chat;
  gh = await fakeServer((r) => {
    if (r.method === "GET" && r.url.startsWith(`/repos/${REPO}/issues?`)) return { body: [{ number: 1, title: "Example issue" }] };
    if (r.method === "POST" && r.url === `/repos/${REPO}/issues`) return { body: { number: 2, html_url: "https://example.com/2" } };
    if (r.url === "/user") return { body: { login: "example-bot" } };
    return { status: 404, body: { message: "nope" } };
  });
  conn = (await owner.post("/api/connections", { app: "github", name: "GitHub", identity: "agent", secret: "ghp_" + "x".repeat(36), repos: [REPO], apiBase: gh.url })).json.connection;
  await owner.put(`/api/connections/${conn.id}/grants`, { grants: [{ type: "agent", id: agent.id }] });
});
after(async () => {
  await gh.close();
  await h.close();
  delete process.env.CIRCLECHAT_TOOL_DEFAULT;
  guard.release();
  assert.deepEqual(guard.attempts, [], "nothing in this file tried to leave the machine");
});

const tool = async (as: Client, chatId: string, name: string, args: unknown) => {
  const m = (await as.post(`/api/chats/${chatId}/messages`, { body: `!tool ${name} ${JSON.stringify(args)}` })).json.message;
  return m;
};
const run = async (name: string, args: unknown, as = owner, chatId = chat.id) => (await agentReply(as, chatId, agent.id, (await tool(as, chatId, name, args)).ts)).body as string;
const log = async () => (await owner.get(`/api/toollog?agent=${agent.id}`)).json.calls as any[];

test("1. a tool with no rule is blocked, the app shows it, and an admin can allow it", async () => {
  assert.match(await run("github_list_issues", { repo: REPO }), /Blocked: the workspace rules don't allow/);
  const shown = (await owner.get("/api/connections")).json.connections.find((x: any) => x.id === conn.id);
  assert.equal(shown.defaults.github_list_issues, "block", "the web app is told the real default");
  assert.equal(shown.defaults.github_create_issue, "block");
  assert.deepEqual([...shown.never].sort(), ["github_delete_branch", "github_merge_pull_request"]);
  assert.equal((await owner.put(`/api/connections/${conn.id}/policies`, { policies: { github_list_issues: "allow" } })).status, 200);
  assert.match(await run("github_list_issues", { repo: REPO }), /#1 Example issue/);
});

test("2 and 4. never-listed tools can't be allowed by anyone, and only admins change rules (the first way around)", async () => {
  for (const t of ["github_merge_pull_request", "github_delete_branch"]) {
    const r = await owner.put(`/api/connections/${conn.id}/policies`, { policies: { [t]: "allow" } });
    assert.equal(r.status, 400, `${t}: not even an admin`);
    assert.match(r.json.error, /never-list/);
  }
  assert.equal((await owner.put(`/api/connections/${conn.id}/policies`, { policies: { github_merge_pull_request: "block" } })).status, 200, "Block is always fine");
  // a builder can't change any rule, on an app or on an MCP server
  assert.equal((await builder.put(`/api/connections/${conn.id}/policies`, { policies: { github_create_issue: "allow" } })).status, 403);
  assert.equal((await builder.put(`/api/mcp/any-server/policies`, { policies: { anything: "allow" } })).status, 403);
  // and the call is refused before any rule, with nothing sent to GitHub
  h.app.gateway.setPolicy("connection", conn.id, "github_merge_pull_request", "allow"); // as if a rule got there anyway
  assert.match(await run("github_merge_pull_request", { repo: REPO, number: 1 }), /never-list\. No agent may do that here/);
  assert.match(await run("github_delete_branch", { repo: REPO, branch: "main" }), /never-list/);
  assert.ok(!gh.calls.some((c: any) => c.method === "PUT" || c.method === "DELETE"), "GitHub never heard about it");
  assert.ok((await log()).some((x) => x.tool === "github_merge_pull_request" && x.status === "blocked" && /^never allowed/.test(x.approval)));
});

test("2. an HTTP connection to api.github.com can't merge or delete, even allowed (the second way around)", async () => {
  const api = (await owner.post("/api/connections", { app: "http", name: "GitHub API", identity: "agent", baseUrl: "https://api.github.com", secret: "example-token-value" })).json.connection;
  await owner.put(`/api/connections/${api.id}/grants`, { grants: [{ type: "agent", id: agent.id }] });
  assert.equal((await owner.put(`/api/connections/${api.id}/policies`, { policies: { github_api_put: "allow", github_api_post: "allow", github_api_delete: "allow" } })).status, 200);
  const calls: [string, any][] = [
    ["github_api_put", { path: `/repos/${REPO}/pulls/7/merge` }],
    ["github_api_put", { path: `/repos/${REPO}/pulls/7/%6Derge` }],
    ["github_api_post", { path: `/repos/${REPO}/merges`, body: { base: "main", head: "feature" } }],
    ["github_api_delete", { path: `/repos/${REPO}/git/refs/heads/main` }],
    ["github_api_delete", { path: `/repos/${REPO}` }],
    ["github_api_post", { path: "/graphql", body: { query: 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }' } }],
  ];
  for (const [name, args] of calls) {
    assert.match(await run(name, args), /Blocked: .*on GitHub|GraphQL mutation/, `${name} ${args.path}`);
    assert.deepEqual(guard.attempts, [], `${name} ${args.path}: nothing tried to reach GitHub`);
  }
  const blocked = (await log()).filter((x) => x.tool.startsWith("github_api_") && x.status === "blocked" && /^never allowed/.test(x.approval));
  assert.equal(blocked.length, calls.length, "each refused before it was sent");
  assert.deepEqual(guard.attempts, [], "no connection or lookup left the machine");
});

test("the guard itself: a request that would leave the machine is refused before any lookup, and recorded", async () => {
  const before = guard.attempts.length;
  await assert.rejects(fetch("https://api.github.com/zen"), "refused");
  assert.deepEqual(guard.attempts.slice(before), ["api.github.com:443"]);
  guard.attempts.length = before; // this one was on purpose
});

test("2. an MCP server's own merge tool is never allowed, whatever its rule (the third way around)", () => {
  const t = { name: "example_github__merge_pull_request", description: "", inputSchema: {}, category: "write" as const, resource: { type: "mcp" as const, id: "example-server", name: "example_github", identity: "agent" }, run: async () => "" };
  h.app.gateway.setPolicy("mcp", "example-server", t.name, "allow");
  h.app.gateway.setPolicy("mcp", "example-server", `${t.name}@chat:${chat.id}`, "allow");
  assert.equal(h.app.gateway.decide(t, chat.id), "block");
  const other = { ...t, name: "example_github__create_pull_request" };
  h.app.gateway.setPolicy("mcp", "example-server", other.name, "allow");
  assert.equal(h.app.gateway.decide(other, chat.id), "allow", "the server's other tools follow their rules");
});

test("3 and 4. only an admin answers Always, and a Block then outranks the chat's Always", async () => {
  assert.equal((await owner.put(`/api/connections/${conn.id}/policies`, { policies: { github_create_issue: "ask" } })).status, 200);
  // a builder asks in their own chat with the agent, so they may answer, but only once
  const bchat = (await builder.post("/api/chats", { dmAgent: agent.id })).json.chat;
  const m1 = await tool(builder, bchat.id, "github_create_issue", { repo: REPO, title: "First" });
  const ap1 = await waitFor(async () => (await owner.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.chatId === bchat.id), "the builder's approval");
  const always = await builder.post(`/api/approvals/${ap1.id}/decide`, { decision: "allow_always" });
  assert.equal(always.status, 403);
  assert.match(always.json.error, /Only admins can answer Always/);
  assert.equal((await builder.post(`/api/approvals/${ap1.id}/decide`, { decision: "allow_once" })).status, 200);
  assert.match((await agentReply(builder, bchat.id, agent.id, m1.ts)).body, /Opened #2/);
  // an admin answers Always in the owner's chat: the next call there runs without asking
  const m2 = await tool(owner, chat.id, "github_create_issue", { repo: REPO, title: "Second" });
  const ap2 = await waitFor(async () => (await owner.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.chatId === chat.id), "the owner's approval");
  assert.equal((await owner.post(`/api/approvals/${ap2.id}/decide`, { decision: "allow_always" })).status, 200);
  await agentReply(owner, chat.id, agent.id, m2.ts);
  assert.match(await run("github_create_issue", { repo: REPO, title: "Third" }), /Opened #2/);
  // now the rule becomes Block: the chat's Always no longer counts
  assert.equal((await owner.put(`/api/connections/${conn.id}/policies`, { policies: { github_create_issue: "block" } })).status, 200);
  assert.match(await run("github_create_issue", { repo: REPO, title: "Fourth" }), /Blocked: the workspace rules don't allow/);
});

test("3. with the default Block and no rule, a chat's Always doesn't count either", () => {
  const t = { name: "github_get_issue", description: "", inputSchema: {}, category: "read" as const, resource: { type: "connection" as const, id: conn.id, name: "GitHub", identity: "agent" }, run: async () => "" };
  h.app.gateway.setPolicy("connection", conn.id, `${t.name}@chat:${chat.id}`, "allow");
  assert.equal(h.app.gateway.decide(t, chat.id), "block");
});
