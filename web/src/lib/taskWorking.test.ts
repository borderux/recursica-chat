import { describe, it, expect } from "vitest";
import { markerTitle, workOnTask, workingFor, workingLine, type TaskWork } from "./taskWorking";

const now = Date.parse("2026-01-02T12:00:00Z");
const work = (over: Partial<TaskWork>): TaskWork => ({
  taskId: "tsk_a",
  runId: "run_1",
  agentId: "agt_1",
  agentMemberId: "mem_designer",
  agentName: "designer",
  agentHandle: "designer",
  startedAt: "2026-01-02T11:58:00Z",
  phase: "reading skills",
  ...over,
});

describe("the task card's working line", () => {
  it("names the agent, how long it has worked, and the step it is on", () => {
    expect(workingLine(work({}), now)).toBe("designer is working, 2 min: reading skills");
  });

  it("without a step yet, says only that it is working", () => {
    expect(workingLine(work({ phase: null }), now)).toBe("designer is working, 2 min");
  });

  it("falls back to the handle when the agent has no name", () => {
    expect(workingLine(work({ agentName: "" }), now)).toBe("designer is working, 2 min: reading skills");
  });

  it("counts the time from the turn's start", () => {
    expect(workingFor("2026-01-02T11:59:30Z", now)).toBe("<1 min");
    expect(workingFor("2026-01-02T11:45:00Z", now)).toBe("15 min");
    expect(workingFor("2026-01-02T10:55:00Z", now)).toBe("1 h 5 min");
    expect(workingFor("2026-01-02T12:00:30Z", now)).toBe("<1 min");
  });
});

describe("which turns show on a card", () => {
  it("only that task's, oldest first", () => {
    const all = [
      work({ runId: "run_2", agentName: "writer", startedAt: "2026-01-02T11:59:00Z" }),
      work({ runId: "run_3", taskId: "tsk_b" }),
      work({ runId: "run_1" }),
    ];
    expect(workOnTask(all, "tsk_a").map((w) => w.runId)).toEqual(["run_1", "run_2"]);
    expect(workOnTask(undefined, "tsk_a")).toEqual([]);
  });

  it("the board marker's tooltip lists each agent's line", () => {
    expect(markerTitle([work({}), work({ agentName: "writer", phase: "thinking" })], now)).toBe(
      "designer is working, 2 min: reading skills\nwriter is working, 2 min: thinking",
    );
  });
});
