// Fork: HTTP behaviour of the Slack member ID routes (routes/slack-link.ts),
// with the session check and the data module replaced by fakes, so no
// database or Redis is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const calls = vi.hoisted(() => [] as Array<{ fn: string; userId: string; arg?: string }>);

// Sessions: header x-user = person_a | person_b | spectator. A bot token or a
// service token never makes a session, as in the real requireAuth.
const USERS: Record<string, { id: string; spectator?: boolean }> = {
  person_a: { id: "u_a" }, person_b: { id: "u_b" }, spectator: { id: "u_spec", spectator: true },
};
vi.mock("../auth/session.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const u = USERS[String(req.headers["x-user"] ?? "")];
    if (!u) return reply.code(401).send({ error: "unauthenticated" });
    if (u.spectator && req.method !== "GET") return reply.code(403).send({ error: "spectator_read_only" });
    (req as unknown as { auth: unknown }).auth = { user: { id: u.id }, memberId: `m_${u.id}`, workspaceId: "ws_1" };
    req.spectator = u.spectator;
  },
}));
vi.mock("../lib/access-control.js", () => ({ writeAudit: async () => {} }));
vi.mock("../lib/slack-link.js", () => ({
  getLink: async (userId: string) => ({ userId }),
  requestCode: async (userId: string, slackUserId: string) => {
    calls.push({ fn: "requestCode", userId, arg: slackUserId });
    return slackUserId === "U0TAKEN01" ? { ok: false, error: "slack_id_in_use" } : { ok: true };
  },
  verifyCode: async (userId: string, code: string) => {
    calls.push({ fn: "verifyCode", userId, arg: code });
    return code === "123456" ? { ok: true, slackUserId: "U0PERSON1" } : { ok: false, error: "wrong_code" };
  },
  removeLink: async (userId: string) => { calls.push({ fn: "removeLink", userId }); },
  closePrompt: async (userId: string) => { calls.push({ fn: "closePrompt", userId }); },
}));

const { default: slackLinkRoutes } = await import("../routes/slack-link.js");
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  calls.length = 0;
  app = Fastify();
  await app.register(slackLinkRoutes, { prefix: "/api" });
});
afterEach(async () => { await app.close(); });

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/api/users/me/slack"],
  ["POST", "/api/users/me/slack", { slackUserId: "U0PERSON1" }],
  ["POST", "/api/users/me/slack/verify", { code: "123456" }],
  ["DELETE", "/api/users/me/slack"],
  ["POST", "/api/users/me/slack/skip"],
];

describe("Slack member ID routes", () => {
  it("refuse an agent's bot token, a service token and no session, and change nothing", async () => {
    for (const auth of ["Bearer agent-token", "Bearer cc_sa_service", undefined]) {
      for (const [method, url, payload] of ROUTES) {
        const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers: auth ? { authorization: auth } : {} });
        expect(r.statusCode, `${method} ${url} ${auth}`).toBe(401);
      }
    }
    expect(calls).toEqual([]);
  });
  it("refuse the spectator mode, which stands in for another person", async () => {
    for (const [method, url, payload] of ROUTES) {
      const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { "x-user": "spectator" } });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(calls).toEqual([]);
  });
  it("work on the signed-in person's own row, whatever the body says", async () => {
    const r = await app.inject({ method: "POST", url: "/api/users/me/slack", payload: { slackUserId: "u0person1" }, headers: { "x-user": "person_b" } });
    expect(r.statusCode).toBe(202);
    expect(calls).toEqual([{ fn: "requestCode", userId: "u_b", arg: "U0PERSON1" }]);
    const other = await app.inject({ method: "POST", url: "/api/users/me/slack", payload: { slackUserId: "U0PERSON1", userId: "u_a" }, headers: { "x-user": "person_b" } });
    expect(other.statusCode, "a body with another person's user ID").toBe(400);
  });
  it("refuse a bad ID, an ID another person verified, and a wrong code", async () => {
    const h = { "x-user": "person_a" };
    expect((await app.inject({ method: "POST", url: "/api/users/me/slack", payload: { slackUserId: "$(id)" }, headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/users/me/slack", payload: { slackUserId: "U0TAKEN01" }, headers: h })).statusCode).toBe(409);
    const wrong = await app.inject({ method: "POST", url: "/api/users/me/slack/verify", payload: { code: "000000" }, headers: h });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: "wrong_code" });
    expect((await app.inject({ method: "POST", url: "/api/users/me/slack/verify", payload: { code: "abc" }, headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/users/me/slack/verify", payload: { code: "123456" }, headers: h })).statusCode).toBe(200);
  });
  it("remove the ID and close the modal for the person", async () => {
    const h = { "x-user": "person_a" };
    expect((await app.inject({ method: "DELETE", url: "/api/users/me/slack", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/users/me/slack/skip", headers: h })).statusCode).toBe(200);
    expect(calls).toEqual([{ fn: "removeLink", userId: "u_a" }, { fn: "closePrompt", userId: "u_a" }]);
  });
});
