// SPDX-License-Identifier: AGPL-3.0-only
// A real stdio MCP server used by tests. Set EXTRA_TOOL_FILE to a path: if that
// file exists, an extra "export_csv" tool appears (to test new-tool review). Set
// PREVIEW_TOOLS=1 for tools with previews for their approval cards.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";

const server = new McpServer({ name: "test-tools", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text} (secret seen: ${process.env.TEST_SECRET ? "yes" : "no"})` }],
}));
server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
if (process.env.EXTRA_TOOL_FILE && existsSync(process.env.EXTRA_TOOL_FILE)) {
  server.registerTool("export_csv", { description: "Write a CSV", inputSchema: { name: z.string() } }, async ({ name }) => ({ content: [{ type: "text", text: `wrote ${name}.csv` }] }));
}
// PREVIEW_TOOLS=1: tools whose _meta names a preview tool for their approval cards (server/src/toolpreview.ts)
if (process.env.PREVIEW_TOOLS === "1") {
  const meta = (preview: string) => ({ _meta: { "recursicachat/preview": preview } });
  server.registerTool("write_note", { description: "Write a note", inputSchema: { title: z.string(), lines: z.array(z.string()) }, ...meta("write_note_preview") }, async ({ title }) => ({
    content: [{ type: "text", text: `wrote ${title}` }],
  }));
  server.registerTool("write_note_preview", { description: "What write_note would do; changes nothing", inputSchema: { title: z.string(), lines: z.array(z.string()) } }, async ({ title, lines }) => ({
    content: [{ type: "text", text: [`**Note:** ${title}`, ...lines.map((l) => `- ${l}`)].join("\n") }],
  }));
  // a preview that fails: the card shows the call as before
  server.registerTool("send_note", { description: "Send a note", inputSchema: { to: z.string() }, ...meta("send_note_preview") }, async ({ to }) => ({ content: [{ type: "text", text: `sent to ${to}` }] }));
  server.registerTool("send_note_preview", { description: "What send_note would do", inputSchema: { to: z.string() } }, async () => ({ content: [{ type: "text", text: "no preview today" }], isError: true }));
  // a _meta that names no tool the server lists: no preview, and nothing hidden
  server.registerTool("plain_note", { description: "A plain note", inputSchema: { text: z.string() }, ...meta("missing_preview") }, async ({ text }) => ({ content: [{ type: "text", text }] }));
}
await server.connect(new StdioServerTransport());
