import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A turn's container is stopped by the bridge's deadline timer. When that
// timer is gone (a bridge restart mid-turn) or its `docker kill` fails, the
// container keeps running in the agent's home and every new turn of that
// agent fails to start. Every 5 minutes the bridge now stops any turn
// container past its deadline plus the stop grace, and posts each one to the
// stack's Slack channel.

type Row = { name: string; deadline: string; createdAt: string };
type Docker = { listWithDeadlines: () => Promise<Row[]>; remove: (names: string[]) => Promise<unknown> };
type Bridge = {
  overdueTurnContainers: (rows: Row[], handles: string[], now?: number, graceMs?: number) => { name: string; deadline: number }[];
  overdueNote: (c: { name: string; deadline: number }, now?: number, graceMs?: number) => string;
  dockerTimeMs: (s: string) => number;
  postToSlack: (text: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch) => Promise<boolean>;
  sweepOverdueTurnContainers: (handles: string[], docker?: Docker, post?: (t: string) => Promise<unknown>, now?: number) => Promise<string[]>;
  startTurnSweep: (load: () => unknown[], sweep: (h: string[]) => unknown, every?: number) => ReturnType<typeof setInterval>;
  buildHermesSpawn: (home: string, args: string[], env?: Record<string, string>, handle?: string, deadline?: number) => { args: string[] };
  TURN_SWEEP_MS: number;
  DEADLINE_LABEL: string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const GRACE = 45_000;
const now = Date.parse("2026-01-02T12:00:00Z");
const min = 60_000;

const rows: Row[] = [
  { name: "cc-turn-designer-be0d6713", deadline: String(now - 20 * min), createdAt: "" }, // overdue
  { name: "cc-turn-designer-qa-0a1b2c3d", deadline: String(now - 20 * min), createdAt: "" }, // overdue, another agent
  { name: "cc-turn-reviewer-11223344", deadline: String(now - 30_000), createdAt: "" }, // past deadline, inside grace
  { name: "cc-turn-writer-55667788", deadline: String(now + 5 * min), createdAt: "" }, // still running its turn
  { name: "cc-turn-helper-99aabbcc", deadline: "", createdAt: "2026-01-02 06:00:00 -0500 EST" }, // no label: started 1 h ago
  { name: "circlechat-api-1", deadline: "", createdAt: "2026-01-01 00:00:00 +0000 UTC" },
];

describe("which turn containers are overdue", () => {
  it("is every container of the bridge's agents past its deadline plus grace, and no other", () => {
    const overdue = bridge.overdueTurnContainers(rows, ["designer", "reviewer", "writer", "helper"], now, GRACE);
    expect(overdue.map((c) => c.name)).toEqual(["cc-turn-designer-be0d6713", "cc-turn-helper-99aabbcc"]);
    expect(overdue[0].deadline).toBe(now - 20 * min);
  });

  it("stops a container exactly one grace after its deadline, not before", () => {
    const at = [{ name: "cc-turn-designer-be0d6713", deadline: String(now - GRACE), createdAt: "" }];
    expect(bridge.overdueTurnContainers(at, ["designer"], now, GRACE)).toEqual([]);
    expect(bridge.overdueTurnContainers(at, ["designer"], now + 1, GRACE)).toHaveLength(1);
  });

  it("judges an unlabelled container by its start time plus the default turn limit", () => {
    expect(bridge.dockerTimeMs("2026-01-02 06:00:00 -0500 EST")).toBe(Date.parse("2026-01-02T11:00:00Z"));
    expect(bridge.dockerTimeMs("2026-01-02 06:00:00.123 +0000 UTC")).toBe(Date.parse("2026-01-02T06:00:00Z"));
    expect(bridge.dockerTimeMs("an hour ago")).toBeNaN();
    // Just started, without a label: not overdue.
    const fresh = [{ name: "cc-turn-helper-99aabbcc", deadline: "", createdAt: "2026-01-02 11:59:00 +0000 UTC" }];
    expect(bridge.overdueTurnContainers(fresh, ["helper"], now, GRACE)).toEqual([]);
    // A time it cannot read is left alone.
    expect(bridge.overdueTurnContainers([{ name: "cc-turn-helper-99aabbcc", deadline: "", createdAt: "?" }], ["helper"], now)).toEqual([]);
  });

  it("sweeps every 5 minutes", () => {
    expect(bridge.TURN_SWEEP_MS).toBe(5 * 60_000);
  });
});

describe("each turn's container carries its deadline", () => {
  it("as a label on docker run", () => {
    const spec = bridge.buildHermesSpawn("/homes/.hermes-designer", ["chat"], {}, "designer", now + 1234.4);
    const i = spec.args.indexOf("--label");
    expect(i).toBeGreaterThan(0);
    expect(spec.args[i + 1]).toBe(`${bridge.DEADLINE_LABEL}=${now + 1234}`);
    expect(spec.args.indexOf("--label")).toBeLessThan(spec.args.indexOf("chat"));
    expect(bridge.buildHermesSpawn("/homes/.hermes-designer", ["chat"], {}, "designer").args).not.toContain("--label");
  });

  it("for Hermes and OpenClaw turns alike", () => {
    const src = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    expect(src).toMatch(/buildHermesSpawn\(hermesHome, hermesArgs, envExtras, handle, deadline\)/);
    const openclaw = src.slice(src.indexOf("function callOpenClaw("));
    expect(openclaw.slice(0, openclaw.indexOf("stopByDeadline("))).toMatch(/\.\.\.deadlineLabelArgs\(deadline\)/);
  });
});

describe("a sweep", () => {
  it("stops each overdue container and posts each one to Slack", async () => {
    const remove = vi.fn(async () => "");
    const post = vi.fn(async (_text: string) => true);
    const stopped = await bridge.sweepOverdueTurnContainers(["designer", "helper", "reviewer"], { listWithDeadlines: async () => rows, remove }, post, now);
    expect(stopped).toEqual(["cc-turn-designer-be0d6713", "cc-turn-helper-99aabbcc"]);
    expect(remove.mock.calls).toEqual([[["cc-turn-designer-be0d6713"]], [["cc-turn-helper-99aabbcc"]]]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe(
      "Stopped turn container cc-turn-designer-be0d6713: still running 20 min after its deadline (stop grace 45 s).",
    );
    expect(post.mock.calls[1][0]).toMatch(/^Stopped turn container cc-turn-helper-99aabbcc: /);
  });

  it("posts nothing for a container it failed to stop, and goes on to the next", async () => {
    const remove = vi.fn(async (names: string[]) => {
      if (names[0] === "cc-turn-designer-be0d6713") throw new Error("no such container");
      return "";
    });
    const post = vi.fn(async () => true);
    const stopped = await bridge.sweepOverdueTurnContainers(["designer", "helper"], { listWithDeadlines: async () => rows, remove }, post, now);
    expect(stopped).toEqual(["cc-turn-helper-99aabbcc"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps the stop when Slack fails, and never throws", async () => {
    const post = vi.fn(async () => { throw new Error("slack down"); });
    const stopped = await bridge.sweepOverdueTurnContainers(["designer"], { listWithDeadlines: async () => rows, remove: async () => "" }, post, now);
    expect(stopped).toEqual(["cc-turn-designer-be0d6713"]);
    await expect(
      bridge.sweepOverdueTurnContainers(["designer"], { listWithDeadlines: async () => { throw new Error("docker down"); }, remove: async () => "" }, post, now),
    ).resolves.toEqual([]);
  });

  it("does nothing without agents", async () => {
    const listWithDeadlines = vi.fn(async () => rows);
    expect(await bridge.sweepOverdueTurnContainers([], { listWithDeadlines, remove: async () => "" }, async () => true, now)).toEqual([]);
    expect(listWithDeadlines).not.toHaveBeenCalled();
  });
});

describe("posting to the stack's Slack channel", () => {
  it("sends the line to SLACK_CHANNEL with SLACK_BOT_TOKEN, named for the stack", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const env = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C0EXAMPLE", STACK_NAME: "acme" };
    expect(await bridge.postToSlack("hello", env, fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-test");
    expect(JSON.parse(String(init.body))).toEqual({ channel: "C0EXAMPLE", text: "hello", username: "acme" });
  });

  it("posts nothing when the token or the channel is missing", async () => {
    const fetchImpl = vi.fn();
    expect(await bridge.postToSlack("x", { SLACK_CHANNEL: "C0EXAMPLE" }, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(await bridge.postToSlack("x", { SLACK_BOT_TOKEN: "xoxb-test" }, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a refused post without the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" })));
    const err = await bridge
      .postToSlack("x", { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C0EXAMPLE" }, fetchImpl as unknown as typeof fetch)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/channel_not_found/);
    expect(String(err)).not.toMatch(/xoxb/);
  });
});

describe("the bridge runs the sweep", () => {
  it("on a timer, over the agents in its config whose turns run in containers", () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn();
      const t = bridge.startTurnSweep(() => [{ handle: "designer" }, { handle: "porter", kind: "openclaw" }], sweep, 1000);
      expect(sweep).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledWith(["designer", "porter"]);
      vi.advanceTimersByTime(1000);
      expect(sweep).toHaveBeenCalledTimes(2);
      clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick when the config cannot be read", () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn();
      const t = bridge.startTurnSweep(() => { throw new Error("bad json"); }, sweep, 1000);
      vi.advanceTimersByTime(1000);
      expect(sweep).not.toHaveBeenCalled();
      clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  it("from the entrypoint, after the bridge starts", () => {
    const src = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    const entry = src.slice(src.indexOf("if (!process.env.CC_BRIDGE_IMPORT_ONLY) {"));
    expect(entry).toMatch(/await startBridge\(\);\s*startTurnSweep\(\);/);
  });

  it("with the stack's Slack settings passed to the bridge container", () => {
    const compose = readFileSync(resolve(__dirname, "../../../compose.agents.yml"), "utf8");
    const bridgeSvc = compose.slice(compose.indexOf("\n  bridge:"));
    for (const k of ["SLACK_BOT_TOKEN", "SLACK_CHANNEL", "STACK_NAME"]) expect(bridgeSvc).toMatch(new RegExp(`^\\s+${k}: \\$\\{${k}:-\\}$`, "m"));
  });
});
