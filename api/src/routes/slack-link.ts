// Fork: a person links the person's own Slack member ID, for Slack DMs about
// mentions (see lib/slack-link-rules.ts).
//
// Each route takes a person's session (requireAuth) and works on that person's
// own row only. No route takes a user ID, so nobody sets another person's ID.
// Agents have no route here: an agent's bot token and a service token never
// pass requireAuth. The spectator mode is refused, because a spectator session
// stands in for another person.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth/session.js";
import { writeAudit } from "../lib/access-control.js";
import { closePrompt, getLink, removeLink, requestCode, verifyCode } from "../lib/slack-link.js";
import { CodeBody, SlackIdBody } from "../lib/slack-link-rules.js";

async function personOnly(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.spectator) reply.code(403).send({ error: "spectator_read_only" });
}

async function audit(req: FastifyRequest, action: string, meta: Record<string, unknown> = {}): Promise<void> {
  const { workspaceId, memberId, user } = req.auth!;
  if (!workspaceId) return;
  await writeAudit({ workspaceId, actorId: memberId ?? user.id, action, targetType: "user", targetId: user.id, meta, ip: req.ip });
}

export default async function slackLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/me/slack", { preHandler: personOnly }, async (req) => getLink(req.auth!.user.id));

  // Keeps the ID as pending and asks for a code. The code goes to the ID as a
  // Slack DM, from the notifier outside CircleChat.
  app.post("/users/me/slack", { preHandler: personOnly }, async (req, reply) => {
    const parsed = SlackIdBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "slack_id_invalid" });
    const result = await requestCode(req.auth!.user.id, parsed.data.slackUserId);
    if (!result.ok) return reply.code(result.error === "too_many_requests" ? 429 : 409).send({ error: result.error });
    await audit(req, "slack.code_requested", { slackUserId: parsed.data.slackUserId });
    return reply.code(202).send(await getLink(req.auth!.user.id));
  });

  app.post("/users/me/slack/verify", { preHandler: personOnly }, async (req, reply) => {
    const parsed = CodeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "code_invalid" });
    const result = await verifyCode(req.auth!.user.id, parsed.data.code);
    if (!result.ok) return reply.code(result.error === "slack_id_in_use" ? 409 : 400).send({ error: result.error });
    await audit(req, "slack.verified", { slackUserId: result.slackUserId });
    return getLink(req.auth!.user.id);
  });

  app.delete("/users/me/slack", { preHandler: personOnly }, async (req) => {
    await removeLink(req.auth!.user.id);
    await audit(req, "slack.removed");
    return getLink(req.auth!.user.id);
  });

  // Skip, or any close of the modal.
  app.post("/users/me/slack/skip", { preHandler: personOnly }, async (req) => {
    await closePrompt(req.auth!.user.id);
    return getLink(req.auth!.user.id);
  });
}
