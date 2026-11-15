import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { statusAfterTurnStart, statusAfterAgentWork } from "../agents/task-status-follows-work.js";

// Observed: a person created a one-line prototype task and assigned a designer
// agent. The agent's turn started at once and wrote the page 1m44s in, without
// a question: the instruction said "start the work in this turn … otherwise do
// the first real step of the work now", and a small model took the nearest
// imperative. The turn ran for many minutes on a slow model, and the card
// stayed in Backlog with nothing on it, because the card moved only when the
// turn's first comment landed at its end.

type Bridge = { buildPrompt: (entry: unknown, packet: unknown) => string };
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const packet = {
  trigger: "task_assigned",
  agent: { handle: "designer", name: "Designer", memberId: "m_agent" },
  members: { m_person: { kind: "user", handle: "pat" }, m_agent: { kind: "agent", handle: "designer" } },
  task: {
    id: "task_demo",
    title: "Test: pricing page",
    bodyMd: "I need a pricing page for our app with three plans, and a button to pick one.",
    status: "backlog",
    recentComments: [],
  },
  inbox: [],
  myTasks: [{ id: "task_demo", title: "Test: pricing page", status: "backlog" }],
};
const entry = { handle: "designer", name: "Designer", hermesHome: "/opt/hermes-homes/.hermes-designer" };

describe("an assigned task's instruction puts asking first", () => {
  it("says a persona that asks replies with only its question and writes no files", () => {
    const prompt = bridge.buildPrompt(entry, packet);
    expect(prompt).toContain("Asking comes first: if your persona asks before working, your whole reply this turn is that question; write no files.");
    expect(prompt).toContain("the person's answer starts your next turn");
  });

  it("says to start the work only when the persona does not ask, and after the asking rule", () => {
    const prompt = bridge.buildPrompt(entry, packet);
    const ask = prompt.indexOf("your whole reply this turn is that question");
    const work = prompt.indexOf("Only when your persona does not ask before working, do the first real step of the work now.");
    expect(ask).toBeGreaterThan(0);
    expect(work).toBeGreaterThan(ask);
  });

  it("no longer tells every assignee to start the work in this turn", () => {
    const prompt = bridge.buildPrompt(entry, packet);
    expect(prompt).not.toContain("start the work in this turn");
    expect(prompt).not.toContain("otherwise do the first real step of the work now");
  });
});

describe("a card moves to In progress when its assignee's turn starts", () => {
  it("moves a Backlog task, and nothing else", () => {
    expect(statusAfterTurnStart("backlog")).toBe("in_progress");
    for (const s of ["in_progress", "review", "done", "blocked", "cancelled", "whatever"]) {
      expect(statusAfterTurnStart(s)).toBeNull();
    }
  });

  it("leaves the deliverable rule as it was: a deliverable still moves the task to Review", () => {
    expect(statusAfterAgentWork("in_progress", { deliverable: true })).toBe("review");
  });

  it("the worker moves the task once the turn goes to the model, before it builds the context", () => {
    const src = readFileSync(resolve(__dirname, "../worker.ts"), "utf8");
    const budget = src.indexOf("const gate = await enforceBudgets(agent);");
    const move = src.indexOf("await advanceTaskOnTurnStart(agent.id, payload.taskId, agent.workspaceId)");
    const context = src.indexOf("const packet = await buildContext({");
    const dispatch = src.indexOf("response = await callAgent(agent, kind, packet);");
    expect(budget).toBeGreaterThan(0);
    // After the gates that can still skip the turn, so a skipped turn moves nothing.
    expect(move).toBeGreaterThan(budget);
    // Before the context, so the agent sees the task In progress, and long before the reply.
    expect(context).toBeGreaterThan(move);
    expect(dispatch).toBeGreaterThan(context);
  });

  it("checks the agent is an assignee, through the same rule as a comment", () => {
    const src = readFileSync(resolve(__dirname, "../agents/task-status-follows-work.ts"), "utf8");
    expect(src).toMatch(/advanceTaskForAgentWork\(taskId, member\.id, workspaceId, \{ deliverable: false \}, trace, "the assignee's turn started"\)/);
  });
});
