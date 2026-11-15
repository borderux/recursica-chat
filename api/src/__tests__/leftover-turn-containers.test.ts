import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Observed: a deploy restarted the bridge mid-turn. The turn's container kept
// running in the agent's home for an hour, in a tool loop, because the timer
// that would have killed it lived in the old bridge process. Each new turn's
// Hermes then found the home held ("Profile /opt/data is held …"), failed to
// start its model connection, and exited 1 after 48 s.

type Docker = { list: () => Promise<string[]>; remove: (names: string[]) => Promise<unknown> };
type Bridge = {
  turnContainerName: (handle: string, id?: string) => string;
  isTurnContainerOf: (name: string, handle: string) => boolean;
  leftoverTurnContainers: (names: string[], handles: string[]) => string[];
  reapTurnContainers: (handles: string[], docker?: Docker) => Promise<string[]>;
  startBridge: (load: () => unknown[], reap: (h: string[]) => Promise<unknown>, start: () => void) => Promise<void>;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const running = [
  "cc-turn-designer-be0d6713", // the leftover from before the restart
  "cc-turn-designer-qa-0a1b2c3d", // another agent whose handle starts the same way
  "cc-turn-reviewer-11223344",
  "circlechat-api-1",
  "cc-gateway",
];

describe("which containers are an agent's turn containers", () => {
  it("matches the agent's own names, as the bridge makes them", () => {
    expect(bridge.isTurnContainerOf(bridge.turnContainerName("designer"), "designer")).toBe(true);
    expect(bridge.isTurnContainerOf(bridge.turnContainerName("Designer Two"), "Designer Two")).toBe(true);
    expect(bridge.isTurnContainerOf("cc-turn-designer-be0d6713", "designer")).toBe(true);
  });

  it("never matches another agent whose handle starts the same way, or anything else", () => {
    expect(bridge.isTurnContainerOf("cc-turn-designer-qa-0a1b2c3d", "designer")).toBe(false);
    expect(bridge.isTurnContainerOf("cc-turn-a.b-12345678", "a.b")).toBe(true);
    expect(bridge.isTurnContainerOf("cc-turn-axb-12345678", "a.b")).toBe(false);
    expect(bridge.isTurnContainerOf("circlechat-api-1", "designer")).toBe(false);
    expect(bridge.leftoverTurnContainers(running, ["designer", "reviewer"])).toEqual([
      "cc-turn-designer-be0d6713",
      "cc-turn-reviewer-11223344",
    ]);
  });
});

describe("removing leftover turn containers", () => {
  it("removes only the named agents' running turn containers", async () => {
    const remove = vi.fn(async () => "");
    const removed = await bridge.reapTurnContainers(["designer"], { list: async () => running, remove });
    expect(removed).toEqual(["cc-turn-designer-be0d6713"]);
    expect(remove).toHaveBeenCalledWith(["cc-turn-designer-be0d6713"]);
  });

  it("does nothing when none is running, or no agent is named", async () => {
    const list = vi.fn(async () => ["circlechat-api-1"]);
    const remove = vi.fn(async () => "");
    expect(await bridge.reapTurnContainers(["designer"], { list, remove })).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    list.mockClear();
    expect(await bridge.reapTurnContainers([], { list, remove })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("never throws: a docker failure is logged and the turn goes ahead", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      bridge.reapTurnContainers(["designer"], { list: async () => { throw new Error("docker down"); }, remove: async () => "" }),
    ).resolves.toEqual([]);
    err.mockRestore();
  });
});

describe("when the bridge starts, it removes every leftover before it connects", () => {
  it("reaps the turn containers of every agent it serves, then connects", async () => {
    const order: string[] = [];
    await bridge.startBridge(
      () => [{ handle: "designer" }, { handle: "reviewer" }, { handle: "porter", kind: "openclaw" }],
      async (h) => void order.push(`reap:${h.join(",")}`),
      () => void order.push("connect"),
    );
    expect(order).toEqual(["reap:designer,reviewer,porter", "connect"]);
  });

  it("still connects with a bad config, and reaps nothing", async () => {
    const order: string[] = [];
    await bridge.startBridge(
      () => { throw new Error("bad json"); },
      async (h) => void order.push(`reap:${h.length}`),
      () => void order.push("connect"),
    );
    expect(order).toEqual(["reap:0", "connect"]);
  });

  it("is what the entrypoint runs", () => {
    const src = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    const entry = src.slice(src.indexOf("if (!process.env.CC_BRIDGE_IMPORT_ONLY) {"));
    expect(entry).toMatch(/^if \(!process\.env\.CC_BRIDGE_IMPORT_ONLY\) \{\s*await startBridge\(\);/);
    expect(entry).not.toMatch(/^if \(!process\.env\.CC_BRIDGE_IMPORT_ONLY\) \{\s*reconcile\(\);/);
  });
});

describe("before a turn starts, any running container of the same agent is removed", () => {
  it("happens after the turn takes the agent's slot, and before its container starts", () => {
    const src = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    const handler = src.slice(src.indexOf("function connect(entry) {"));
    const slot = handler.indexOf("const slot = await waitForAgentSlot(entry.handle, trigger);");
    const reap = handler.indexOf("if (usesTurnContainers(entry)) await reapTurnContainers([entry.handle]);");
    const spawnTurn = handler.indexOf("await callHermes(promptText");
    expect(slot).toBeGreaterThan(0);
    expect(reap).toBeGreaterThan(slot);
    expect(spawnTurn).toBeGreaterThan(reap);
  });
});
