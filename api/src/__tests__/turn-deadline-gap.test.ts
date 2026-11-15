import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  turnLimitMs,
  dispatchTimeoutMs,
  turnMsLeft,
  replyInTime,
  TURN_DELIVERY_MS,
  DISPATCH_SLACK_MS,
} from "../lib/config.js";
import { turnDeadline } from "../agents/turn-queue.js";

// The gap: the api waited HERMES_TIMEOUT + 60 s for the bridge, but each turn's
// deadline was HERMES_TIMEOUT + 45 s (the grace). A reply in the 15 s between
// them reached the worker and was cancelled as run_timeout at the apply step.
// Now the deadline, the bridge's kill time and the api's wait all come from one
// setting, and every reply the worker receives is applied.

type Bridge = {
  turnDeadlineAt: (turnMs: unknown, now?: number) => number;
  turnStopTimes: (deadline: number, now?: number, graceMs?: number) => { termMs: number; killMs: number };
  stopByDeadline: (p: EventEmitter & { kill: (s: string) => void }, deadline: number, name?: string) => void;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});
afterEach(() => vi.useRealTimers());

const t = (hms: string) => new Date(`2026-11-15T${hms}Z`);

describe("a reply in what was the gap is applied", () => {
  // A turn starts at 10:00:00 with the defaults: 480 s plus 45 s of grace.
  const startedAt = t("10:00:00");
  const deadline = turnDeadline(startedAt, null, turnLimitMs({}));

  it("the turn's deadline is 10:08:45; the old api wait ran to 10:09:00", () => {
    expect(deadline).toEqual(t("10:08:45"));
    expect(+startedAt + (480 + 60) * 1000).toBe(+t("10:09:00"));
  });

  it("a reply at 10:08:50 is applied, not cancelled as run_timeout", () => {
    expect(replyInTime(t("10:08:50"), deadline)).toBe(true);
    // And one that arrives just before the deadline, as before.
    expect(replyInTime(t("10:08:44"), deadline)).toBe(true);
  });

  it("the api is still waiting for it at 10:08:50", () => {
    // The worker dispatches two seconds into the turn.
    const sentAt = t("10:00:02");
    const waitEnds = +sentAt + dispatchTimeoutMs(deadline, sentAt);
    expect(waitEnds).toBe(+t("10:09:00"));
    expect(+t("10:08:50")).toBeLessThan(waitEnds);
  });

  it("the bridge ends the turn by the deadline: SIGTERM after the turn limit, the container killed at the deadline", () => {
    const sentAt = t("10:00:02");
    const frameAt = +sentAt + 50; // the frame reaches the bridge
    const bridgeDeadline = bridge.turnDeadlineAt(turnMsLeft(deadline, sentAt), frameAt);
    expect(bridgeDeadline).toBeLessThanOrEqual(+deadline + 50);
    const { termMs, killMs } = bridge.turnStopTimes(bridgeDeadline, frameAt, 45_000);
    expect(frameAt + termMs).toBe(bridgeDeadline - 45_000);
    expect(frameAt + killMs).toBe(bridgeDeadline);
  });

  it("for any setting, the bridge kills by the deadline, the api waits past it, and the worker applies all the api returns", () => {
    for (const env of [{}, { HERMES_TIMEOUT: "60", CC_AGENT_STOP_GRACE_SEC: "5" }, { HERMES_TIMEOUT: "1800", CC_AGENT_STOP_GRACE_SEC: "120" }]) {
      const start = t("10:00:00");
      const dl = turnDeadline(start, null, turnLimitMs(env));
      const sentAt = new Date(+start + 3_000);
      const bridgeKill = bridge.turnDeadlineAt(turnMsLeft(dl, sentAt, env), +sentAt);
      const apiWaitEnds = +sentAt + dispatchTimeoutMs(dl, sentAt, env);
      const workerGivesUp = apiWaitEnds + DISPATCH_SLACK_MS;
      expect(bridgeKill).toBeLessThanOrEqual(+dl);
      expect(apiWaitEnds).toBe(+dl + TURN_DELIVERY_MS);
      // The last reply the worker can receive is still applied.
      expect(replyInTime(new Date(workerGivesUp), dl)).toBe(true);
    }
  });

  it("only a reply later than any wait allows is cancelled", () => {
    expect(replyInTime(new Date(+deadline + TURN_DELIVERY_MS + DISPATCH_SLACK_MS + 1), deadline)).toBe(false);
    expect(replyInTime(t("12:00:00"), null)).toBe(true);
  });
});

describe("the bridge stops a turn's process by the deadline", () => {
  function fakeProcess() {
    const p = Object.assign(new EventEmitter(), { signals: [] as string[], kill(s: string) { p.signals.push(s); } });
    return p;
  }

  it("sends SIGTERM when only the grace is left, and SIGKILL at the deadline", () => {
    vi.useFakeTimers();
    const p = fakeProcess();
    bridge.stopByDeadline(p, Date.now() + 60_000);
    vi.advanceTimersByTime(14_999);
    expect(p.signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(p.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(45_000);
    expect(p.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does nothing once the process has closed", () => {
    vi.useFakeTimers();
    const p = fakeProcess();
    bridge.stopByDeadline(p, Date.now() + 60_000);
    p.emit("close", 0, null);
    vi.advanceTimersByTime(120_000);
    expect(p.signals).toEqual([]);
  });

  it("follows the api's turnMs, and falls back to its own limit without one", () => {
    expect(bridge.turnDeadlineAt(30_000, 1_000)).toBe(31_000);
    expect(bridge.turnDeadlineAt(undefined, 1_000)).toBe(1_000 + 525_000);
  });
});

describe("the pieces are wired to the one setting", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

  it("the worker judges the reply by when it arrived", () => {
    const worker = src("../worker.ts");
    expect(worker).toMatch(/const replyAt = new Date\(\);/);
    expect(worker).toMatch(/!replyInTime\(replyAt, controlBeforeApply\.timeoutAt\)/);
    expect(worker).not.toMatch(/controlBeforeApply\.timeoutAt <= new Date\(\)/);
  });

  it("the api sends the bridge the time left, and waits until the deadline", () => {
    expect(src("../agents/adapters/hermes.ts")).toMatch(/timeoutMs, turnMs \}/);
    expect(src("../ws/agent-socket.ts")).toMatch(/turnMs: body\.turnMs/);
  });

  it("the bridge has no fixed spawn timeout left", () => {
    const b = src("../../hermes-multi-bridge.mjs");
    expect(b).not.toMatch(/timeout: HERMES_TIMEOUT \* 1000/);
    expect(b).toMatch(/turnDeadlineAt\(frame\.turnMs, frameAt\)/);
  });
});
