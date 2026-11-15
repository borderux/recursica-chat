import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commentWakeList } from "../agents/comment-wake.js";

// Observed: on a task assigned to an agent, a person posted a comment that
// @mentioned only another person. The assigned agent replied a minute later,
// because every person's comment woke every assignee. Members here: two
// people (mem_person_a, mem_person_b) and two agents (mem_designer, mem_writer).
// The list may hold people: the trigger skips them, so only agents wake.
const assignees = ["mem_designer", "mem_person_b"];
const person = { actorMemberId: "mem_person_a", actorIsAgent: false, assignees };
const agents = new Set(["mem_designer", "mem_writer"]);
const agentsWoken = (list: string[]) => list.filter((m) => agents.has(m));

describe("a person's comment on a task", () => {
  it("that @mentions only people wakes none of the task's assigned agents", () => {
    const list = commentWakeList({ ...person, mentions: ["mem_person_b"] });
    expect(agentsWoken(list)).toEqual([]);
    expect(list).not.toContain("mem_designer");
  });

  it("that @mentions an agent wakes that agent", () => {
    expect(agentsWoken(commentWakeList({ ...person, mentions: ["mem_designer"] }))).toEqual(["mem_designer"]);
  });

  it("that @mentions an agent who is not assigned wakes that agent, and not the assigned one", () => {
    expect(agentsWoken(commentWakeList({ ...person, mentions: ["mem_writer"] }))).toEqual(["mem_writer"]);
  });

  it("that @mentions a person and an agent wakes the agent", () => {
    expect(agentsWoken(commentWakeList({ ...person, mentions: ["mem_person_b", "mem_writer"] }))).toEqual(["mem_writer"]);
  });

  it("with no @mentions wakes the assignees, as before", () => {
    expect(agentsWoken(commentWakeList({ ...person, mentions: [] }))).toEqual(["mem_designer"]);
  });

  it("never wakes its author", () => {
    expect(commentWakeList({ ...person, assignees: ["mem_person_a", "mem_designer"], mentions: [] })).toEqual(["mem_designer"]);
    expect(commentWakeList({ ...person, mentions: ["mem_person_a"] })).toEqual([]);
  });
});

describe("an agent's comment on a task", () => {
  const agent = { actorMemberId: "mem_writer", actorIsAgent: true, assignees: ["mem_designer", "mem_writer"] };

  it("wakes only the members it @mentions, never every assignee", () => {
    expect(commentWakeList({ ...agent, mentions: [] })).toEqual([]);
    expect(commentWakeList({ ...agent, mentions: ["mem_designer"] })).toEqual(["mem_designer"]);
  });
});

describe("addComment", () => {
  const src = readFileSync(resolve(__dirname, "../lib/tasks-core.ts"), "utf8");
  const add = src.slice(src.indexOf("export async function addComment("), src.indexOf("export async function deleteComment("));

  it("wakes the members commentWakeList picks, each through the trigger that skips people", () => {
    expect(add).toMatch(/for \(const mid of commentWakeList\(\{ actorMemberId, actorIsAgent, mentions: mentioned, assignees \}\)\) \{\s*await maybeFireAgentTrigger\(mid, taskId, t!\.conversationId, "task_comment"\);/);
    expect(add).not.toMatch(/wake\.add\(a\.memberId\)/);
    const trigger = src.slice(src.indexOf("export async function maybeFireAgentTrigger("));
    expect(trigger.slice(0, 800)).toMatch(/if \(!m \|\| m\.kind !== "agent"\) return;/);
  });

  it("counts an @handle in a person's comment body as a mention, so a comment sent without a mentions array is judged the same", () => {
    expect(add).toMatch(/resolveHandlesToMemberIds\(extractMentionHandles\(bodyMd\), workspaceId\)/);
    expect(add.indexOf("if (!actorIsAgent) {\n    const fromBody")).toBeGreaterThan(0);
  });
});
