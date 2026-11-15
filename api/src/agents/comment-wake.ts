// Whom a new task comment wakes. Only agents ever wake: the caller fires a
// trigger for each member returned, and that skips people
// (maybeFireAgentTrigger in lib/tasks-core.ts).
//
// A person's comment:
//   - with no @mentions wakes the task's assignees: the person is steering.
//   - with @mentions wakes only the members it mentions. So a comment that
//     mentions only people wakes no agent, and one that mentions an agent
//     wakes that agent. Observed: on a task assigned to an agent, a comment
//     that mentioned only a person got a reply from the assigned agent a
//     minute later, because every person's comment woke every assignee.
// An agent's comment wakes only the members it mentions. Fanning agent
// comments out to every assignee made comment → wake → comment loops between
// co-assigned agents.
//
// The author never wakes on their own comment.
export function commentWakeList(p: {
  actorMemberId: string;
  actorIsAgent: boolean;
  mentions: readonly string[];
  assignees: readonly string[];
}): string[] {
  const mentions = Array.from(new Set(p.mentions));
  const wake = p.actorIsAgent || mentions.length ? mentions : Array.from(new Set(p.assignees));
  return wake.filter((m) => m !== p.actorMemberId);
}
