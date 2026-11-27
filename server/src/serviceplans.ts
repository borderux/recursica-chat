// SPDX-License-Identifier: AGPL-3.0-only
// A plan a service posts for an agent it drives (drivenagents.ts): POST /api/service/chats/:id/plans
// { agent, title, steps }. A service that already knows the steps of a piece of work posts them as the
// agent's plan, without asking the model, so the plan is always there and exact.
//
// - It does what the agent's own propose_plan tool does (gateway.ts), as that agent: a new plan id, one
//   task per step in order, assigned to the agent and created by it, then the agent's `plan` message
//   (the plan card) with { planId, steps }. So the board, the plan card, the live `task` and `message`
//   events, and the status rules work the same as for a plan the agent proposed.
// - The chat is one the service's agents are in (404 otherwise), and the agent one the service drives
//   (403) and is in that chat (409).
// - title: 1 to 200 characters after trimming. steps: 1 to 20 step titles (propose_plan's limit), each
//   1 to 200 characters after trimming. Anything else is 400 with the reason: nothing is cut.
// - 201 with { plan: { id, messageId }, tasks }, the tasks as GET /api/service/chats/:id/tasks gives them.
// - It wakes no one and starts no turn: nothing here delivers anything.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import { id } from "./crypto.ts";
import type { ServiceAccount } from "./serviceaccounts.ts";

export const MAX_PLAN_STEPS = 20;
export const MAX_PLAN_TEXT = 200;

/** What drivenagents.ts lends these routes: its scope checks, which refuse with 404 and 403, and its error handling. */
export interface ServiceScope {
  chatFor(s: ServiceAccount, chatId: string): { id: string };
  agentFor(s: ServiceAccount, handle: string): { id: string; handle: string };
  handled(fn: (c: any) => any): (c: any) => Promise<any>;
}

/** The plan's title and steps from a request body, trimmed; or the reason it's refused. */
export function parsePlan(b: any): { title: string; steps: string[] } | { error: string } {
  const text = (v: unknown, what: string): string | { error: string } => {
    if (typeof v !== "string") return { error: `${what} is missing: text, 1 to ${MAX_PLAN_TEXT} characters` };
    const t = v.trim();
    if (!t) return { error: `${what} is empty` };
    if (t.length > MAX_PLAN_TEXT) return { error: `${what} is longer than ${MAX_PLAN_TEXT} characters` };
    return t;
  };
  const title = text(b?.title, "the plan's title");
  if (typeof title !== "string") return title;
  if (!Array.isArray(b?.steps) || !b.steps.length) return { error: `steps is a list of 1 to ${MAX_PLAN_STEPS} step titles` };
  if (b.steps.length > MAX_PLAN_STEPS) return { error: `a plan has at most ${MAX_PLAN_STEPS} steps` };
  const steps: string[] = [];
  for (const [i, s] of b.steps.entries()) {
    const t = text(s, `step ${i + 1}`);
    if (typeof t !== "string") return t;
    steps.push(t);
  }
  return { title, steps };
}

export function registerServicePlans(api: Hono<any>, app: App, scope: ServiceScope): void {
  const { svc } = app;
  const me = (c: any) => c.get("service") as ServiceAccount;
  api.post(
    "/api/service/chats/:id/plans",
    scope.handled(async (c) => {
      const s = me(c);
      const chat = scope.chatFor(s, c.req.param("id"));
      let b: any;
      try {
        b = await c.req.json();
      } catch {
        return c.json({ error: "the body must be JSON" }, 400);
      }
      const agent = scope.agentFor(s, b?.agent);
      if (!svc.isMember(chat.id, "agent", agent.id)) return c.json({ error: `@${agent.handle} isn't in that chat` }, 409);
      const plan = parsePlan(b);
      if ("error" in plan) return c.json({ error: plan.error }, 400);
      // as propose_plan (gateway.ts) does it, as the agent
      const planId = id("plan_");
      const steps = plan.steps.map((title) => svc.createTask({ chatId: chat.id, title, assigneeType: "agent", assigneeId: agent.id, planId, createdBy: agent.id }));
      const message = svc.insertMessage({ chatId: chat.id, authorType: "agent", authorId: agent.id, kind: "plan", body: plan.title, meta: { planId, steps } });
      return c.json({ plan: { id: planId, messageId: message.id }, tasks: steps.map((t: any) => svc.task(t.id)) }, 201);
    }),
  );
}
