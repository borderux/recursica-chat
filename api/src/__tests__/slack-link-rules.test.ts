// Fork: the rules for linking a person's Slack member ID (lib/slack-link-rules.ts).
import { describe, it, expect } from "vitest";
import { CodeBody, MAX_TRIES, SlackIdBody, checkCode, codeStatus, hashCode, publicLink, showPrompt, type LinkRow } from "../lib/slack-link-rules.js";

const NOW = new Date("2030-01-01T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const empty: LinkRow = {
  slackUserId: null, verifiedAt: null, pendingSlackUserId: null, codeRequestedAt: null, codeSalt: null, codeHash: null,
  codeSentAt: null, codeExpiresAt: null, codeAttempts: 0, sendError: null, promptClosedAt: null,
};
// A row after the notifier sent the code 123456.
const sent: LinkRow = {
  ...empty, pendingSlackUserId: "U0PERSON1", codeRequestedAt: NOW, codeSalt: "a1b2", codeHash: hashCode("a1b2", "123456"),
  codeSentAt: NOW, codeExpiresAt: later(600_000),
};

describe("Slack member ID", () => {
  it("takes U or W, then capital letters and digits, and reads a lower-case ID as capitals", () => {
    expect(SlackIdBody.parse({ slackUserId: " u0person1 " }).slackUserId).toBe("U0PERSON1");
    expect(SlackIdBody.safeParse({ slackUserId: "W0123ABCD" }).success).toBe(true);
    for (const bad of ["", "C0123ABCD", "U01", "U0123$(id)", "U0123ABCD; x", "U0123 ABCD"]) {
      expect(SlackIdBody.safeParse({ slackUserId: bad }).success, bad).toBe(false);
    }
    expect(SlackIdBody.safeParse({ slackUserId: "U0PERSON1", userId: "u_other" }).success, "no other person's user ID").toBe(false);
  });
  it("takes a 6-digit code only", () => {
    expect(CodeBody.safeParse({ code: "123456" }).success).toBe(true);
    for (const bad of ["12345", "1234567", "12345a", ""]) expect(CodeBody.safeParse({ code: bad }).success, bad).toBe(false);
  });
});

describe("the code", () => {
  it("hashes the salt and the code with SHA-256, as the notifier does", () => {
    expect(hashCode("a1b2", "123456")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode("a1b2", "123456")).not.toBe(hashCode("c3d4", "123456"));
  });
  it("matches the right code, and moves the pending ID to verified", () => {
    expect(checkCode(sent, "123456", NOW)).toEqual({ ok: true, slackUserId: "U0PERSON1" });
  });
  it("refuses a wrong code, an expired code, a code after 5 tries, and a missing code", () => {
    expect(checkCode(sent, "654321", NOW)).toEqual({ ok: false, error: "wrong_code" });
    expect(checkCode(sent, "123456", later(600_000))).toEqual({ ok: false, error: "code_expired" });
    expect(checkCode({ ...sent, codeAttempts: MAX_TRIES }, "123456", NOW)).toEqual({ ok: false, error: "too_many_tries" });
    expect(checkCode({ ...sent, codeHash: null }, "123456", NOW)).toEqual({ ok: false, error: "no_code" });
    expect(checkCode(undefined, "123456", NOW)).toEqual({ ok: false, error: "no_code" });
  });
  it("reports the code's state for the screens", () => {
    expect(codeStatus(undefined, NOW)).toBe("none");
    expect(codeStatus({ ...sent, codeSentAt: null, codeHash: null }, NOW)).toBe("requested");
    expect(codeStatus(sent, NOW)).toBe("sent");
    expect(codeStatus(sent, later(600_000))).toBe("expired");
    expect(codeStatus({ ...sent, codeAttempts: MAX_TRIES }, NOW)).toBe("expired");
    expect(codeStatus({ ...sent, sendError: "user_not_found" }, NOW)).toBe("failed");
  });
  it("never returns the salt or the hash", () => {
    const shown = JSON.stringify(publicLink(sent, NOW));
    expect(shown).not.toContain("a1b2");
    expect(shown).not.toContain(sent.codeHash!);
    expect(publicLink(sent, NOW).triesLeft).toBe(MAX_TRIES);
  });
});

describe("the modal", () => {
  it("asks each person with no verified ID, once: skip, close or a verified ID ends the asking", () => {
    expect(showPrompt(undefined)).toBe(true);
    expect(showPrompt(empty)).toBe(true);
    expect(showPrompt({ ...empty, promptClosedAt: NOW })).toBe(false);
    expect(showPrompt({ ...empty, slackUserId: "U0PERSON1", verifiedAt: NOW })).toBe(false);
  });
});
