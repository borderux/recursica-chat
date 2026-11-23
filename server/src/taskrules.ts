// SPDX-License-Identifier: AGPL-3.0-only
// Who can change a task's status. A task is "agent-run" when it's assigned to an agent (assigneeType
// "agent"), including an agent a service drives. The agent moves its own task; a person doesn't.
//
// - An agent-run task that isn't finished (todo, working, checking, needs_you): a person may only
//   cancel it. Any other status from a person through PATCH /api/tasks/:id is refused with 403 and a
//   plain reason. A person answers a task that needs them in its chat (the web app posts an
//   @mention), and the status stays the agent's to change. Admins too: no override.
// - A done or cancelled agent-run task: a person sets no status. POST /api/tasks/:id/reopen, for
//   anyone who can see its chat, sets it back to todo and posts a message from that person in the
//   task's chat, @mentioning the agent, so the agent wakes the usual way. An agent a service drives
//   is reopened only when that service has said it can redo work (service_accounts.can_redo, off
//   until the service, PUT /api/service/redo, or an admin, PUT /api/service-accounts/:name/redo, turns
//   it on); otherwise 409.
// - A person's task, or one assigned to no one: every status, as before.
// - Agents (their tools) and services (/api/service/tasks/:id) set any status, as before: those
//   routes don't come through here.
// The web app offers only what these rules allow (web/src/taskrules.ts); the server's answer counts.
import type { Hono } from "hono";
import type { App } from "./app.ts";
import { driverOf, serviceByName, serviceCanRedo, setServiceRedo } from "./serviceaccounts.ts";

type Status = "todo" | "working" | "needs_you" | "checking" | "done" | "cancelled";
interface TaskLike {
  status: string;
  assigneeType: string;
  assigneeId: string;
}

export const isAgentRun = (t: Pick<TaskLike, "assigneeType">) => t.assigneeType === "agent";
export const isFinished = (s: string) => s === "done" || s === "cancelled";

/** Why a person may not set this status on this task, or null when they may. `agent`: the agent's name. */
export function personMoveRefusal(t: TaskLike, to: string, agent: string): string | null {
  if (!isAgentRun(t) || to === t.status) return null;
  if (isFinished(t.status)) return `This task is run by ${agent} and is finished: reopen it to have ${agent} redo it.`;
  if (to === "cancelled") return null;
  return `This task is run by ${agent}: you can cancel it or answer it, not move it.`;
}

/** The plain sentence for a driven agent whose service can't redo work. */
export const cantRedo = (agent: string) => `${agent} can't redo a finished task. Ask in the chat for a new run.`;

/** The message a reopen posts, from the person, to the agent. */
export const reopenText = (handle: string, person: string, title: string) => `@${handle} Reopened by ${person}: please redo "${title}".`;

class Refusal extends Error {
  status: 403 | 404 | 409 | 400;
  constructor(status: 403 | 404 | 409 | 400, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The status rule on PATCH /api/tasks/:id, POST /api/tasks/:id/reopen, and an admin's switch for a
 * service's redo. Registered after the session check and before the task routes in api.ts.
 */
export function registerTaskRules(api: Hono<any>, app: App, can: { isAdmin: (u: any) => boolean; seesChat: (u: any, chatId: string) => boolean }): void {
  const { svc, db } = app;
  const agentName = (id: string) => svc.agent(id)?.name ?? "an agent";
  const answer = async (c: any, f: () => unknown | Promise<unknown>) => {
    try {
      return c.json(await f());
    } catch (e) {
      if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  // a person's status change: checked here, then upstream's route does the rest
  api.use("/api/tasks/:id", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    const t = svc.task(c.req.param("id"));
    if (!t || !can.seesChat(c.get("user"), t.chatId)) return next(); // the route's own 404
    let b: any;
    try {
      b = await c.req.json();
    } catch {
      return next();
    }
    const to = typeof b?.status === "string" ? (b.status as Status) : undefined;
    const no = to ? personMoveRefusal(t, to, agentName(t.assigneeId)) : null;
    if (no) return c.json({ error: no }, 403);
    return next();
  });

  api.post("/api/tasks/:id/reopen", (c) =>
    answer(c, () => {
      const u = c.get("user");
      const t = svc.task(c.req.param("id"));
      if (!t || !can.seesChat(u, t.chatId)) throw new Refusal(404, "no such task");
      if (t.archivedAt) throw new Refusal(409, "This task is archived. Restore it first.");
      if (!isAgentRun(t)) throw new Refusal(409, "Only a task an agent runs is reopened. Set its status instead.");
      if (!isFinished(t.status)) throw new Refusal(409, "This task isn't finished.");
      const a = svc.agent(t.assigneeId);
      if (!a) throw new Refusal(409, "The agent that ran this task is gone, so no one can redo it.");
      const chat = svc.chat(t.chatId);
      if (!chat || chat.archivedAt) throw new Refusal(409, "This chat is archived. Restore it to write in it.");
      if (!svc.chatAgents(chat.id).some((x) => x.id === a.id)) throw new Refusal(409, `${a.name} isn't in this chat any more, so it can't redo the task.`);
      const sid = driverOf(db, a.id);
      if (sid && !serviceCanRedo(db, sid)) throw new Refusal(409, cantRedo(a.name));
      const task = svc.updateTask(t.id, { status: "todo" });
      // like a message the person writes: one stepping into an agents-only chat joins it
      if (chat.kind === "agents" && !svc.isMember(chat.id, "user", u.id)) svc.addMember(chat.id, "user", u.id);
      const message = svc.post({ chatId: chat.id, authorType: "user", authorId: u.id, body: reopenText(a.handle, u.name, t.title) });
      return { task, message };
    }),
  );

  api.put("/api/service-accounts/:name/redo", (c) =>
    answer(c, async () => {
      if (!can.isAdmin(c.get("user"))) throw new Refusal(403, "Only admins and above can do that");
      const s = serviceByName(db, c.req.param("name"));
      if (!s) throw new Refusal(404, "no such service");
      let b: any;
      try {
        b = await c.req.json();
      } catch {
        b = undefined;
      }
      if (typeof b?.redo !== "boolean") throw new Refusal(400, "redo is true or false");
      setServiceRedo(db, s.id, b.redo);
      return { service: { name: s.name, redo: b.redo } };
    }),
  );
}
