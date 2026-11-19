// SPDX-License-Identifier: AGPL-3.0-only
// Which live events a signed-in person's websocket gets: the same rule as the REST routes.
// Most events name their chat at the top (chatId). Three carry it inside their payload, and each
// carries text from that chat, so each is checked against its own chat. One more is cut down:
//   - delivery: the message an agent was handed, with its text (delivery.chatId)
//   - approval: an agent's request, with the tool call's details. Like GET /api/approvals: people
//     who can see its chat, and the person whose request led to it. One with no chat goes to that
//     person and to admins.
//   - memory: a chat's memory stays with the people in that chat, like GET /api/memories. Team and
//     agent memories go to everyone.
//   - agent_status: everyone sees whether an agent is busy, but the detail (the start of the message
//     the agent is working on) and the chat go only to people who can see that chat.
import type { AgentStatus, BusEvent } from "./bus.ts";

export interface Viewer {
  userId: string;
  isAdmin: boolean;
  /** Whether this person may see the chat: a member, or a chat of agents only. */
  seesChat: (chatId: string) => boolean;
}

/** The event as this person may see it, or null for none of it. */
export function eventFor(e: BusEvent, v: Viewer): BusEvent | null {
  if (e.type === "agent_status") return { ...e, status: statusSeenBy(e.status, v.seesChat) };
  return eventVisible(e, v) ? e : null;
}

/**
 * An agent's status as one person may see it. Busy or idle goes to everyone. The detail and the
 * chat go only to people who can see the chat the agent is working in. The REST routes that return
 * an agent use this too (api.ts).
 */
export function statusSeenBy(status: AgentStatus, seesChat: (chatId: string) => boolean): AgentStatus {
  if (!status.chatId || seesChat(status.chatId)) return status;
  const { chatId: _hidden, ...rest } = status;
  return { ...rest, detail: "" };
}

export function eventVisible(e: BusEvent, v: Viewer): boolean {
  if ("chatId" in e && e.chatId && !v.seesChat(e.chatId)) return false;
  switch (e.type) {
    case "chat":
      return v.seesChat(String((e.chat as any)?.id ?? ""));
    case "delivery":
      return v.seesChat(String((e.delivery as any)?.chatId ?? ""));
    case "approval": {
      const ap = e.approval as any;
      const requester = ap?.detail?.requester;
      if (requester?.type === "user" && requester.id === v.userId) return true;
      return ap?.chatId ? v.seesChat(String(ap.chatId)) : v.isAdmin;
    }
    case "memory": {
      const m = e.memory as any;
      return m?.scope !== "chat" || v.seesChat(String(m.scopeId ?? ""));
    }
    default:
      return true;
  }
}
