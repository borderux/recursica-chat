import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { turnLimitMs } from "../lib/config.js";
import {
  turnDeadline,
  turnHoldsAgent,
  recoverAfterRestart,
  sweepQueues,
  closedByRestart,
  QUEUE_SWEEP_MS,
  WORKER_RESTARTED,
  type LeftRunning,
} from "../agents/turn-queue.js";

// A turn that never ended held its agent's queue. Observed shape: the worker
// restarted mid-turn (a deploy), its run stayed `running` with no deadline,
// and the requests behind it waited until CC_TURN_STALE_MS (30 min) ran out,
// with nothing to start them even then, since a queue moved only when a turn
// ended.

const t = (hms: string) => new Date(`2026-11-15T${hms}Z`);

describe("each turn gets a real deadline when it starts", () => {
  it("is the bridge's turn limit plus its grace, read the way the bridge reads them", () => {
    expect(turnLimitMs({})).toBe((480 + 45) * 1000);
    expect(turnLimitMs({ HERMES_TIMEOUT: "600", CC_AGENT_STOP_GRACE_SEC: "30" })).toBe(630_000);
    // compose declares both empty when the operator set nothing.
    expect(turnLimitMs({ HERMES_TIMEOUT: "", CC_AGENT_STOP_GRACE_SEC: "" })).toBe(525_000);
    // The bridge gives the container at least 5 s; 0 is unset there.
    expect(turnLimitMs({ HERMES_TIMEOUT: "100", CC_AGENT_STOP_GRACE_SEC: "2" })).toBe(105_000);
    expect(turnLimitMs({ HERMES_TIMEOUT: "100", CC_AGENT_STOP_GRACE_SEC: "0" })).toBe(145_000);
  });

  it("starts from the turn's start, and keeps a later deadline a person set", () => {
    const now = t("10:00:00");
    expect(turnDeadline(now, null, 525_000)).toEqual(t("10:08:45"));
    expect(turnDeadline(now, t("10:01:00"), 525_000)).toEqual(t("10:08:45"));
    expect(turnDeadline(now, t("10:30:00"), 525_000)).toEqual(t("10:30:00"));
  });

  it("holds the agent until the deadline, and not after", () => {
    const startedAt = t("10:00:00");
    const timeoutAt = turnDeadline(startedAt, null, 525_000);
    expect(turnHoldsAgent({ status: "running", startedAt, timeoutAt }, t("10:08:44"))).toBe(true);
    expect(turnHoldsAgent({ status: "running", startedAt, timeoutAt }, t("10:08:45"))).toBe(false);
  });

  it("is set by claimTurn when the turn starts, which also starts its clock", () => {
    const src = readFileSync(resolve(__dirname, "../agents/turn-queue.ts"), "utf8");
    expect(src).toMatch(/status: "running", startedAt: now, timeoutAt: turnDeadline\(now,/);
  });
});

describe("a new worker fails the runs the last worker left running, then starts each queue", () => {
  const left: LeftRunning[] = [
    { id: "r_writer", agentId: "a_writer", conversationId: "c1" },
    { id: "r_designer", agentId: "a_designer", conversationId: null },
    { id: "r_designer_2", agentId: "a_designer", conversationId: null },
  ];

  it("fails every run as worker_restarted and releases each affected agent once", async () => {
    const failRuns = vi.fn(async (_agentId: string, ids: string[]) => ids);
    const release = vi.fn(async (agentId: string) => (agentId === "a_writer" ? "r_writer_next" : null));
    const out = await recoverAfterRestart({ runningRuns: async () => left, failRuns, release });
    expect(failRuns).toHaveBeenCalledWith("a_writer", ["r_writer"]);
    expect(failRuns).toHaveBeenCalledWith("a_designer", ["r_designer", "r_designer_2"]);
    expect(release.mock.calls.map((c) => c[0]).sort()).toEqual(["a_designer", "a_writer"]);
    expect(out.failed.map((r) => r.id)).toEqual(["r_writer", "r_designer", "r_designer_2"]);
    expect(out.started).toEqual(["r_writer_next"]);
    expect(WORKER_RESTARTED).toBe("worker_restarted");
  });

  it("fails each run before it releases that agent's queue", async () => {
    const order: string[] = [];
    await recoverAfterRestart({
      runningRuns: async () => left.slice(0, 1),
      failRuns: async (a, ids) => (order.push(`fail:${a}`), ids),
      release: async (a) => (order.push(`release:${a}`), null),
    });
    expect(order).toEqual(["fail:a_writer", "release:a_writer"]);
  });

  it("reports only the runs it failed, and keeps going when one agent errors", async () => {
    const out = await recoverAfterRestart({
      runningRuns: async () => left,
      // r_designer_2 finished on its own in the meantime.
      failRuns: async (a, ids) => {
        if (a === "a_writer") throw new Error("db down for this agent");
        return ids.filter((id) => id !== "r_designer_2");
      },
      release: async () => "r_next",
    });
    expect(out.failed.map((r) => r.id)).toEqual(["r_designer"]);
    expect(out.started).toEqual(["r_next"]);
  });

  it("does nothing when no run was left running", async () => {
    const release = vi.fn(async () => null);
    const out = await recoverAfterRestart({ runningRuns: async () => [], failRuns: async () => [], release });
    expect(out).toEqual({ failed: [], started: [] });
    expect(release).not.toHaveBeenCalled();
  });

  it("never runs again a job BullMQ hands back for a run the restart failed", () => {
    expect(closedByRestart({ status: "failed", errorText: "worker_restarted" })).toBe(true);
    // A job retry after worker_error still runs, as before.
    expect(closedByRestart({ status: "failed", errorText: "worker_error" })).toBe(false);
    expect(closedByRestart({ status: "queued", errorText: null })).toBe(false);
  });

  it("runs before the worker takes its first job", () => {
    const src = readFileSync(resolve(__dirname, "../worker.ts"), "utf8");
    expect(src).toMatch(/autorun: false/);
    const recover = src.indexOf("await recoverAfterRestart()");
    const run = src.indexOf("worker.run()");
    expect(recover).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(recover);
    expect(src).toMatch(/if \(controlAtStart && closedByRestart\(controlAtStart\)\) return;/);
  });
});

describe("every minute, a queue whose agent has no live turn starts", () => {
  it("sweeps once a minute by default", () => {
    expect(QUEUE_SWEEP_MS).toBe(60_000);
    const src = readFileSync(resolve(__dirname, "../worker.ts"), "utf8");
    expect(src).toMatch(/setInterval\(\(\) => \{\s*sweepQueues\(\)[\s\S]*?\}, QUEUE_SWEEP_MS\);/);
  });

  it("releases each agent with requests waiting; one with a live turn starts nothing", async () => {
    // releaseTurn returns null when the agent still has a live turn.
    const live = new Set(["a_busy"]);
    const release = vi.fn(async (a: string) => (live.has(a) ? null : `r_head_${a}`));
    const started = await sweepQueues({ queuedAgents: async () => ["a_busy", "a_stuck", "a_idle"], release });
    expect(release).toHaveBeenCalledTimes(3);
    expect(started).toEqual(["r_head_a_stuck", "r_head_a_idle"]);
  });

  it("keeps sweeping the other agents when one fails", async () => {
    const started = await sweepQueues({
      queuedAgents: async () => ["a_bad", "a_good"],
      release: async (a) => {
        if (a === "a_bad") throw new Error("lock timeout");
        return "r_good";
      },
    });
    expect(started).toEqual(["r_good"]);
  });

  it("does nothing when no queue has anyone waiting", async () => {
    const release = vi.fn(async () => null);
    expect(await sweepQueues({ queuedAgents: async () => [], release })).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });
});
