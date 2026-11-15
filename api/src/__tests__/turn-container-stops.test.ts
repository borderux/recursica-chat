import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { STOPS_PER_HOUR, isOwnTurnContainer, overdueMsOf } from "../lib/turn-container-stops.js";

// The api records each turn container the bridge stopped past its deadline,
// for an operator's notifier to post. An agent's own container holds the
// token that opens its socket, so a report is kept only for that agent's own
// turn containers, once each, and at most STOPS_PER_HOUR per agent.

describe("which reports the api keeps", () => {
  it("only a name of the reporting agent's own turn containers", () => {
    expect(isOwnTurnContainer("cc-turn-designer-be0d6713", "designer")).toBe(true);
    expect(isOwnTurnContainer("cc-turn-designer-two-be0d6713", "Designer Two")).toBe(true);
    expect(isOwnTurnContainer("cc-turn-designer-qa-0a1b2c3d", "designer")).toBe(false);
    expect(isOwnTurnContainer("cc-turn-reviewer-11223344", "designer")).toBe(false);
    expect(isOwnTurnContainer("circlechat-api-1", "designer")).toBe(false);
    expect(isOwnTurnContainer("cc-turn-designer-be0d6713; drop", "designer")).toBe(false);
    expect(isOwnTurnContainer(undefined, "designer")).toBe(false);
  });

  it("names a container exactly as the bridge does", async () => {
    process.env.CC_BRIDGE_IMPORT_ONLY = "1";
    // @ts-ignore — untyped .mjs module
    const bridge = (await import("../../hermes-multi-bridge.mjs")) as { turnContainerName: (h: string) => string };
    for (const h of ["designer", "Designer Two", "a.b", "--x--"]) expect(isOwnTurnContainer(bridge.turnContainerName(h), h)).toBe(true);
  });

  it("an overdue time that is a sane number of ms, or 0", () => {
    expect(overdueMsOf(1_200_000.4)).toBe(1_200_000);
    expect(overdueMsOf(-5)).toBe(0);
    expect(overdueMsOf("lots")).toBe(0);
    expect(overdueMsOf(1e15)).toBe(30 * 24 * 3600_000);
  });

  it("once per container, and at most STOPS_PER_HOUR per agent", () => {
    expect(STOPS_PER_HOUR).toBe(20);
    const lib = readFileSync(resolve(__dirname, "../lib/turn-container-stops.ts"), "utf8");
    expect(lib).toMatch(/if \(n >= STOPS_PER_HOUR\) return false;/);
    expect(lib).toMatch(/\.onConflictDoNothing\(\)/);
  });
});

describe("the agent's socket", () => {
  it("records a turn_container_stopped frame for that agent", () => {
    const socket = readFileSync(resolve(__dirname, "../ws/agent-socket.ts"), "utf8");
    expect(socket).toMatch(/data\.type === "turn_container_stopped"\) \{[\s\S]*?await recordTurnContainerStop\(\{ id: agent\.id, handle: agent\.handle \}, data\);/);
  });
});

describe("the table", () => {
  it("is created by a fork migration that is safe to run on every start", () => {
    const dir = resolve(__dirname, "../../migrations/fork");
    const file = readdirSync(dir).find((f) => f.endsWith("_turn_container_stops.sql"));
    expect(file).toBeTruthy();
    const sql = readFileSync(resolve(dir, file!), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "turn_container_stops"/);
    for (const stmt of sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(stmt).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
    }
  });
});
