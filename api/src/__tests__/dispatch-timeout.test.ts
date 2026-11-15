import { describe, expect, it } from "vitest";
import { dispatchTimeoutMs, turnMsLeft, TURN_DELIVERY_MS } from "../lib/config.js";

const t = (hms: string) => new Date(`2026-11-15T${hms}Z`);

describe("dispatchTimeoutMs", () => {
  it("waits until the turn's deadline, plus delivery", () => {
    expect(dispatchTimeoutMs(t("10:08:45"), t("10:00:02"))).toBe(523_000 + TURN_DELIVERY_MS);
  });
  it("without a deadline, waits one whole turn plus delivery", () => {
    expect(dispatchTimeoutMs(null, new Date(), {})).toBe((480 + 45) * 1000 + TURN_DELIVERY_MS);
    expect(dispatchTimeoutMs(null, new Date(), { HERMES_TIMEOUT: "900" })).toBe((900 + 45) * 1000 + TURN_DELIVERY_MS);
  });
  it("ignores empty or junk HERMES_TIMEOUT", () => {
    expect(dispatchTimeoutMs(null, new Date(), { HERMES_TIMEOUT: "" })).toBe(540_000);
    expect(dispatchTimeoutMs(null, new Date(), { HERMES_TIMEOUT: "abc" })).toBe(540_000);
  });
  it("has no second setting: CC_DISPATCH_TIMEOUT_MS is ignored", () => {
    expect(dispatchTimeoutMs(null, new Date(), { CC_DISPATCH_TIMEOUT_MS: "1200000", HERMES_TIMEOUT: "900" })).toBe(960_000);
  });
  it("gives the bridge the time left until the deadline", () => {
    expect(turnMsLeft(t("10:08:45"), t("10:00:02"))).toBe(523_000);
    expect(turnMsLeft(null, new Date(), {})).toBe(525_000);
  });
});
