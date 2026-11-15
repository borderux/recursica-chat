import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, members, taskAssignees, tasks, users } from "../db/schema.js";

// When an agent asks a question on a task, the people who can answer it are
// @mentioned: the task's assignees who are people, or, with no person
// assigned, the task's creator when that is a person. Agents are never
// @mentioned in a question: an agent's @mention wakes the agent it names, and
// a question is for a person. The agent's own text is not trusted to do this,
// so the executor applies it to every task comment an agent posts.

export type Member = { memberId: string; handle: string };

// A question: a question mark outside code and outside links.
export function isQuestion(body: string): boolean {
  const prose = String(body ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\bhttps?:\/\/\S+/g, "");
  return /\?/.test(prose);
}

// Whom a question on this task mentions.
export function questionAudience(t: { people: Member[]; creator: (Member & { isPerson: boolean }) | null }): Member[] {
  if (t.people.length) return t.people;
  return t.creator?.isPerson ? [{ memberId: t.creator.memberId, handle: t.creator.handle }] : [];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (handle: string) => new RegExp(`(^|[^\\w@])@${escape(handle)}(?![\\w.-]*[\\w-])`, "gi");

// The comment as posted: on a question, every agent's @ is dropped (the name
// stays as plain text), the audience is @mentioned at the start unless the
// text already mentions them, and the mentions are the audience, never an
// agent. Anything that is not a question passes through unchanged.
export function mentionPeopleOnQuestion(
  body: string,
  mentions: readonly string[],
  ctx: { audience: Member[]; agents: Member[] },
): { body: string; mentions: string[]; added: string[]; dropped: string[] } {
  if (!isQuestion(body)) return { body, mentions: [...mentions], added: [], dropped: [] };
  let out = body;
  const dropped: string[] = [];
  for (const a of ctx.agents) {
    const re = mentionRe(a.handle);
    if (re.test(out)) {
      dropped.push(a.handle);
      out = out.replace(mentionRe(a.handle), `$1${a.handle}`);
    }
  }
  const missing = ctx.audience.filter((p) => !mentionRe(p.handle).test(out));
  if (missing.length) out = `${missing.map((p) => `@${p.handle}`).join(" ")} ${out.replace(/^\s+/, "")}`;
  const agentIds = new Set(ctx.agents.map((a) => a.memberId));
  const ids = [...ctx.audience.map((p) => p.memberId), ...mentions.filter((m) => !agentIds.has(m))];
  return { body: out, mentions: Array.from(new Set(ids)), added: missing.map((p) => p.handle), dropped };
}

// The task's people (its assignees who are people), its creator, and every
// agent of the workspace, by handle.
export async function loadQuestionContext(taskId: string, workspaceId: string): Promise<{ audience: Member[]; agents: Member[] }> {
  const [task] = await db.select({ createdBy: tasks.createdBy }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { audience: [], agents: [] };
  const assigned = (await db.select({ memberId: taskAssignees.memberId }).from(taskAssignees).where(eq(taskAssignees.taskId, taskId))).map((r) => r.memberId);
  const ids = Array.from(new Set([...assigned, task.createdBy]));
  const people = ids.length
    ? await db
        .select({ memberId: members.id, handle: users.handle })
        .from(members)
        .innerJoin(users, eq(users.id, members.refId))
        .where(and(inArray(members.id, ids), eq(members.kind, "user")))
    : [];
  const workspaceAgents = await db
    .select({ memberId: members.id, handle: agents.handle })
    .from(members)
    .innerJoin(agents, eq(agents.id, members.refId))
    .where(and(eq(members.workspaceId, workspaceId), eq(members.kind, "agent")));
  const creator = people.find((p) => p.memberId === task.createdBy);
  const audience = questionAudience({
    people: people.filter((p) => assigned.includes(p.memberId)),
    creator: creator ? { ...creator, isPerson: true } : null,
  });
  return { audience, agents: workspaceAgents };
}
