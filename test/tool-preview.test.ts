// SPDX-License-Identifier: AGPL-3.0-only
// Tool previews for approval cards (server/src/toolpreview.ts): an MCP tool whose _meta names a preview
// tool gets that tool's Markdown, for the call's exact arguments, on its approval card. The preview tool
// is never offered to agents and gets no rule. With no preview, or one that fails, the card is as before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startApp, setupOwner, mockAgent, agentReply, waitFor, Client, type Harness } from "./helpers.ts";
import { REPO_ROOT } from "../server/src/agents/engines.ts";
import { PREVIEW_META, previewText, withPreviews } from "../server/src/toolpreview.ts";

test("a server's tools as kept: each preview tool taken out and named on its tool; a _meta naming itself or nothing is no preview", () => {
  const meta = (p: string) => ({ _meta: { [PREVIEW_META]: p } });
  const kept = withPreviews([
    { name: "write", description: "Write", inputSchema: { type: "object" }, ...meta("write_preview") },
    { name: "write_preview", description: "What write would do", inputSchema: { type: "object" } },
    { name: "loop", ...meta("loop") },
    { name: "lost", ...meta("not_listed") },
    { name: "other", _meta: { "example/other": "write" } },
  ]);
  assert.deepEqual(
    kept.map((t) => [t.name, t.preview]),
    [
      ["write", "write_preview"],
      ["loop", undefined],
      ["lost", undefined],
      ["other", undefined],
    ],
  );
  assert.deepEqual(kept[0], { name: "write", description: "Write", inputSchema: { type: "object" }, annotations: {}, preview: "write_preview" });
});

test("a preview's text: trimmed, cut when long; none when it fails, says nothing or takes too long", async () => {
  assert.equal(await previewText(async () => "  **Note:** hi \n"), "**Note:** hi");
  assert.equal(await previewText(async () => "x".repeat(30), { ms: 1000, chars: 10 }), `${"x".repeat(10)}\n\n…`);
  assert.equal(await previewText(async () => Promise.reject(new Error("no"))), undefined);
  assert.equal(await previewText(async () => "   "), undefined);
  assert.equal(await previewText(() => new Promise<string>(() => {}), { ms: 50, chars: 100 }), undefined);
});

let h: Harness;
let c: Client;
before(async () => {
  h = await startApp({ approvalTtlMs: 20_000 });
  c = await setupOwner(h);
});
after(async () => {
  await h.close();
});

test("an MCP tool with a preview: its approval card carries the preview of the exact call; the preview tool is never a tool of its own", async () => {
  const pip = await mockAgent(c, "pip");
  const chat = (await c.post("/api/chats", { dmAgent: pip.id })).json.chat;
  const r = await c.post("/api/mcp", { name: "notes", transport: "stdio", command: process.execPath, args: [join(REPO_ROOT, "tools", "test-mcp-server.ts")], secrets: { PREVIEW_TOOLS: "1" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const srv = r.json.server;
  // the preview tools aren't kept as tools, and get no rule
  assert.deepEqual(srv.tools.map((t: any) => t.name).sort(), ["add", "echo", "plain_note", "send_note", "write_note"]);
  assert.equal(srv.tools.find((t: any) => t.name === "write_note").preview, "write_note_preview");
  assert.equal(srv.tools.find((t: any) => t.name === "plain_note").preview, undefined);
  assert.ok(!Object.keys(srv.policies).some((k) => k.endsWith("_preview")), JSON.stringify(srv.policies));
  await c.put(`/api/mcp/${srv.id}/grants`, { grants: [{ type: "chat", id: chat.id }] });
  await c.put(`/api/mcp/${srv.id}/policies`, { policies: { notes__write_note: "ask", notes__send_note: "ask", notes__plain_note: "ask" } });
  const say = async (body: string) => (await c.post(`/api/chats/${chat.id}/messages`, { body })).json.message;
  const pending = (tool: string) => waitFor(async () => (await c.get("/api/approvals?state=pending")).json.approvals.find((a: any) => a.detail?.tool === tool), `approval for ${tool}`);

  // the preview of the exact call, on the card's approval; the call runs once approved
  let m = await say('!tool notes__write_note {"title":"Weekly plan","lines":["Shop on Saturday","Cook on Sunday"]}');
  let ap = await pending("notes__write_note");
  assert.equal(ap.detail.preview, "**Note:** Weekly plan\n- Shop on Saturday\n- Cook on Sunday");
  assert.deepEqual(ap.detail.args, { title: "Weekly plan", lines: ["Shop on Saturday", "Cook on Sunday"] });
  await c.post(`/api/approvals/${ap.id}/decide`, { decision: "allow_once" });
  assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /wrote Weekly plan/);

  // a preview that fails, or a _meta that names no tool: the card as before, with no preview
  for (const [tool, args] of [["notes__send_note", '{"to":"team"}'], ["notes__plain_note", '{"text":"hi"}']] as const) {
    m = await say(`!tool ${tool} ${args}`);
    ap = await pending(tool);
    assert.equal(ap.detail.preview, undefined, tool);
    await c.post(`/api/approvals/${ap.id}/decide`, { decision: "deny" });
    await agentReply(c, chat.id, pip.id, m.ts);
  }

  // an agent can't call a preview tool: it isn't one of its tools
  m = await say('!tool notes__write_note_preview {"title":"x","lines":[]}');
  assert.match((await agentReply(c, chat.id, pip.id, m.ts)).body, /not available/);
});

// ---------------------------------------------------------------- the card (web/src/ui/toolpreview.tsx)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { jsonIn, jsonTree, summary } from "../web/src/jsontree.ts";

test("the exact call as a tree: objects and arrays as levels, values as JSON, a string holding JSON as the JSON it holds", () => {
  const args = { title: "Weekly plan", n: 2, ok: true, none: null, files: [{ path: "a.json", content: '{\n  "study": "x",\n  "passes": []\n}\n' }, { path: "b.md", content: "# Not JSON" }], quoted: '"just a string"', number: "12" };
  const t = jsonTree(args);
  assert.equal(t.kind, "object");
  const get = (n: any, k: string) => n.entries.find((e: any) => e[0] === k)[1];
  assert.deepEqual(get(t, "title"), { kind: "value", json: '"Weekly plan"' });
  assert.deepEqual([get(t, "n"), get(t, "ok"), get(t, "none")].map((x: any) => x.json), ["2", "true", "null"]);
  const files = get(t, "files");
  assert.equal(summary(files), "[2 items]");
  const content = get(files.items[0], "content");
  assert.equal(content.kind, "json-text", "a JSON file's content, shown as JSON");
  assert.equal(summary(content), "{2 keys} JSON text");
  assert.equal(content.text, args.files[0].content, "the string as sent is kept");
  assert.deepEqual(get(files.items[1], "content"), { kind: "value", json: '"# Not JSON"' });
  // only an object or an array counts as JSON text: a quoted string or a number stays the string it is
  assert.equal(get(t, "quoted").kind, "value");
  assert.equal(get(t, "number").kind, "value");
  assert.equal(jsonIn("[1, 2"), undefined);
});

const WEB = new URL("../web/", import.meta.url).pathname;
/** The card's components, rendered to HTML on the server, as the browser would build them. */
async function renderCall(props: { tool: string; args: unknown; preview: string }): Promise<string> {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: WEB, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { CallPreview } = await vite.ssrLoadModule("/src/ui/toolpreview.tsx");
    const req = createRequire(join(WEB, "package.json"));
    const { createElement } = req("react");
    const { renderToStaticMarkup } = req("react-dom/server");
    return renderToStaticMarkup(createElement(CallPreview, props));
  } finally {
    await vite.close();
  }
}

test("the card with a preview: the preview's Markdown on top, then the exact call, always there, as a tree with JSON content formatted", async () => {
  const args = { title: "Weekly plan", files: [{ path: "notes/plan.json", content: '{"days":{"sat":{"meals":["soup"]}}}' }] };
  const html = await renderCall({ tool: "notes__write_note", args, preview: "**Note:** Weekly plan <b>raw html</b>\n- Shop on Saturday" });
  const at = (s: string) => html.indexOf(s);
  assert.ok(at("<strong>Note:</strong>") >= 0 && at("<li>Shop on Saturday</li>") > 0, "the preview as Markdown");
  assert.ok(!html.includes("<b>raw html</b>"), "no raw HTML from the preview");
  assert.ok(at("The exact call") > at("Shop on Saturday"), "the exact call below the preview");
  assert.ok(at("notes__write_note") > at("The exact call"));
  assert.ok(!/<details[^>]*>\s*<summary[^>]*>Show the exact call/.test(html), "the exact call isn't hidden behind a toggle");
  // the root level opens, levels nest, and the content string is shown as the JSON it holds
  assert.match(html, /<details class="jt" open="">\s*<summary[^>]*><b>notes__write_note <\/b><span class="muted">\{2 keys\}<\/span>/);
  assert.ok(html.includes("JSON text, shown formatted"));
  assert.ok(html.includes('&quot;days&quot;: </span>') && html.includes("&quot;soup&quot;"), "the content's keys and values as rows");
  assert.ok(!html.includes("\\&quot;"), "no escaped quotes");
  // levels from OPEN_DEPTH down start closed
  assert.match(html, /<details class="jt"><summary[^>]*><span class="jt-k">&quot;sat&quot;: <\/span>/);
});

test("the approval card uses the preview only when the approval has one; without one it shows the call as before", () => {
  const src = readFileSync(new URL("../web/src/screens/Chats.tsx", import.meta.url), "utf8");
  const card = src.slice(src.indexOf("function ApprovalCard"), src.indexOf("// ---------------------------------------------------------------- composer"));
  assert.match(card, /\{d\.tool && previewOf\(d\) \? \(\s*<CallPreview tool=\{d\.tool\} args=\{d\.args\} preview=\{previewOf\(d\)!\} \/>\s*\) : d\.tool \|\| d\.title \? \(/);
  assert.ok(card.includes("{d.tool ? `${d.tool}(${argsSummary(d.args)})` : d.title}"), "the card as before, without a preview");
});
