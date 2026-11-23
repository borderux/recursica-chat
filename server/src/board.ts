// SPDX-License-Identifier: AGPL-3.0-only
// The Board: every open task a person may see, across all their chats, in one call (GET /api/board).
// The web app lays the tasks out in columns by status (web/src/screens/Board.tsx).
//
// - Who sees what: the same rule as GET /api/tasks. Tasks from the chats the person is in, plus the
//   agents-only chats, which everyone may read. No admin override: the board is a person's own view.
// - Plan titles come only from the plan cards in those same chats, and only from the task's own chat.
// - Filters: agent (assigned to it, or created by it), chat, person (assigned to them, or created by
//   them) and plan. Done and cancelled tasks show the last 14 days by updated_at, unless done=all.
// - Moving a card is PATCH /api/tasks/:id, with its own permission check. Nothing here writes.
import type { Hono } from "hono";
import type { App } from "./app.ts";

/** Done and cancelled tasks older than this leave the board, unless the person asks for all of them. */
export const DONE_WINDOW_MS = 14 * 86400_000;

export interface BoardFilters {
  agent?: string;
  chat?: string;
  person?: string;
  plan?: string;
  /** "all": every done and cancelled task; otherwise the last DONE_WINDOW_MS */
  done?: string;
}

export interface BoardData {
  tasks: any[];
  /** plan id to title, for the plans of the tasks this person may see */
  plans: Record<string, string>;
  /** what the filter menus offer: drawn from every task on the board, before any filter */
  options: { agents: string[]; chats: string[]; people: string[]; plans: string[] };
  /** done and cancelled tasks updated before this are left out (0: none are) */
  doneSince: number;
  /** how many done and cancelled tasks the window left out */
  doneHidden: number;
}

const isFinished = (t: { status: string }) => t.status === "done" || t.status === "cancelled";

/** The board for one person, as GET /api/board returns it. `at`: the time now, for the Done window. */
export function boardFor(app: App, userId: string, f: BoardFilters = {}, at = Date.now()): BoardData {
  const { svc, db } = app;
  const visible = new Set(svc.chatsForUser(userId).map((c: any) => c.id as string));
  const all = svc.tasks().filter((t) => visible.has(t.chatId));
  const agentIds = new Set((db.prepare("SELECT id FROM agents").all() as any[]).map((r) => r.id as string));
  const userIds = new Set((db.prepare("SELECT id FROM users").all() as any[]).map((r) => r.id as string));

  // plan titles: the plan card in the task's own chat, never one from another chat
  const plans: Record<string, string> = {};
  const planCard = db.prepare("SELECT body FROM messages WHERE kind = 'plan' AND chat_id = ? AND json_extract(meta, '$.planId') = ? LIMIT 1");
  for (const t of all) {
    if (!t.planId || t.planId in plans) continue;
    const r = planCard.get(t.chatId, t.planId) as any;
    if (r) plans[t.planId] = String(r.body ?? "").slice(0, 200);
  }

  const agentsOf = (t: any) => [t.assigneeType === "agent" ? t.assigneeId : "", agentIds.has(t.createdBy) ? t.createdBy : ""].filter(Boolean) as string[];
  const peopleOf = (t: any) => [t.assigneeType === "user" ? t.assigneeId : "", userIds.has(t.createdBy) ? t.createdBy : ""].filter(Boolean) as string[];
  const options = {
    agents: [...new Set(all.flatMap(agentsOf))],
    chats: [...new Set(all.map((t) => t.chatId as string))],
    people: [...new Set(all.flatMap(peopleOf))],
    plans: [...new Set(all.map((t) => t.planId as string).filter((p) => p && p in plans))],
  };

  const doneSince = f.done === "all" ? 0 : at - DONE_WINDOW_MS;
  let doneHidden = 0;
  const tasks = all.filter((t) => {
    if (f.agent && !agentsOf(t).includes(f.agent)) return false;
    if (f.chat && t.chatId !== f.chat) return false;
    if (f.person && !peopleOf(t).includes(f.person)) return false;
    if (f.plan && t.planId !== f.plan) return false;
    if (doneSince && isFinished(t) && t.updatedAt < doneSince) {
      doneHidden++;
      return false;
    }
    return true;
  });
  return { tasks, plans, options, doneSince, doneHidden };
}

export function registerBoard(api: Hono<any>, app: App): void {
  api.get("/api/board", (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    return c.json(boardFor(app, c.get("user").id, { agent: q("agent"), chat: q("chat"), person: q("person"), plan: q("plan"), done: q("done") }));
  });
}
