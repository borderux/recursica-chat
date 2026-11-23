// SPDX-License-Identifier: AGPL-3.0-only
// HTTP server: JSON API, the agents' MCP endpoint, webhooks, websocket events, the web app.
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import type { App } from "./app.ts";
import { buildApi, staticHandler } from "./api.ts";
import { REPO_ROOT } from "./agents/engines.ts";
import { allowedOrigins, originProblem } from "./origin.ts";
import { isDeactivated } from "./deactivate.ts";
import { eventFor } from "./eventfilter.ts";

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MCP_ROUTE = /^\/mcp\/([A-Za-z0-9_-]+)\/?(\?.*)?$/;

/** Serve the agents' MCP endpoint. Returns false when the url is not an MCP url. */
async function handleMcpRoute(app: App, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const mcp = (req.url ?? "/").match(MCP_ROUTE);
  if (!mcp) return false;
  let body: unknown = undefined;
  if (req.method === "POST") {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  }
  await app.gateway.handleMcp(req, res, mcp[1], body);
  return true;
}

/**
 * A second, narrow server for agent containers: only /mcp/* and /llm/* (each url
 * carries a per-agent token) and /healthz. Bound to the docker bridge address so
 * containers on Linux can reach it while the full API stays on loopback.
 */
export function createAgentServer(app: App): HttpServer {
  return createServer(async (req, res) => {
    try {
      if (await handleMcpRoute(app, req, res)) return;
      if (await app.runtime.modelProxy.handle(req, res)) return;
      if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
}

export function createHttpServer(app: App): HttpServer {
  const api = buildApi(app);
  const apiListener = getRequestListener(api.fetch);
  const serveStatic = staticHandler(join(REPO_ROOT, "web", "dist"));
  // CIRCLECHAT_PUBLIC_URL (see origin.ts); a bad value stops the server here
  const origins = allowedOrigins();
  const refusal = (req: IncomingMessage, socket = false) =>
    originProblem(
      { method: req.method ?? "GET", socket, origin: req.headers.origin, secFetchSite: req.headers["sec-fetch-site"] as string | undefined, host: req.headers.host, cookie: req.headers.cookie },
      origins,
    );

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      // agents' tool endpoint and model proxy
      if (await handleMcpRoute(app, req, res)) return;
      if (await app.runtime.modelProxy.handle(req, res)) return;
      // incoming webhooks
      const hook = url.match(/^\/hooks\/([A-Za-z0-9_-]+)\/?$/);
      if (hook) {
        if (req.method !== "POST") return void res.writeHead(405).end();
        const raw = await readBody(req);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        const r = app.triggers.handleWebhook(hook[1], raw, headers);
        res.writeHead(r.status, { "content-type": "text/plain" }).end(r.body);
        return;
      }
      // the gateway's routes live on their own listener only (gatewayroute.ts)
      if (/^\/gateway(\/|\?|$)/i.test(url)) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      if (url.startsWith("/api/")) {
        const no = refusal(req);
        if (no) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: no }));
      }
      if (url.startsWith("/api/") || url === "/sso" || url.startsWith("/sso?") || url.startsWith("/auth/google/")) return apiListener(req, res);
      if (url === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      const f = serveStatic(url);
      if (!f) return void res.writeHead(404, { "content-type": "text/plain" }).end("Web app not built. Run: npm run build");
      res
        .writeHead(200, { "content-type": f.type, "cache-control": url.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" })
        .end(f.body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  // websocket: push events to signed-in browsers, filtered to what each user may see
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (app.driven.upgrade(req, socket, head)) return; // /ws/service, a service's own socket (drivenagents.ts)
    if (!req.url?.startsWith("/ws")) return socket.destroy();
    // the socket shows everything the signed-in person can see, so it gets the same check
    if (refusal(req, true)) return socket.destroy();
    const cookie = req.headers.cookie ?? "";
    const tok = /(?:^|;\s*)cc_session=([^;]+)/.exec(cookie)?.[1] ?? new URL(req.url, "http://x").searchParams.get("token") ?? "";
    const s = app.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(tok) as any;
    if (!s || s.expires_at < Date.now() || isDeactivated(app.db, s.user_id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, s.user_id));
  });

  const attach = (ws: WebSocket, uid: string) => {
    const visible = (chatId: string) => {
      const c = app.svc.chat(chatId);
      return !!c && (c.kind === "agents" || app.svc.isMember(chatId, "user", uid));
    };
    const role = (app.db.prepare("SELECT role FROM users WHERE id = ?").get(uid) as any)?.role;
    const viewer = { userId: uid, isAdmin: role === "admin" || role === "owner", seesChat: visible };
    const off = app.bus.onEvent((e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // a deactivated person's live connections close at once (deactivate.ts)
      if (e.type === "person" && e.userId === uid && e.deactivated) return ws.close(4003, "deactivated");
      const seen = eventFor(e, viewer); // eventfilter.ts: the same rule as the REST routes
      if (!seen) return;
      ws.send(JSON.stringify(seen));
    });
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25_000);
    ws.on("close", () => {
      off();
      clearInterval(ping);
    });
    ws.send(JSON.stringify({ type: "hello" }));
  };
  return server;
}
