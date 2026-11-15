import { describe, it, expect } from "vitest";
import { FIND_ID_STEPS, isSlackId, normalizeSlackId, slackLinkError, waitingForCode, type SlackLink } from "./slackLink";

const link = (over: Partial<SlackLink>): SlackLink => ({
  slackUserId: null, verifiedAt: null, pendingSlackUserId: null, codeStatus: "none", sendError: null, triesLeft: null, prompt: true, ...over,
});

describe("Slack member ID", () => {
  it("takes U or W, then capitals and digits, and reads lower case as capitals", () => {
    expect(normalizeSlackId(" u0person1 ")).toBe("U0PERSON1");
    expect(isSlackId("u0person1")).toBe(true);
    expect(isSlackId("W0123ABCD")).toBe(true);
    for (const bad of ["", "C0123ABCD", "U01", "U0123 ABCD", "@person"]) expect(isSlackId(bad), bad).toBe(false);
  });
  it("tells the person where Slack shows the ID", () => {
    expect(FIND_ID_STEPS).toBe("In Slack, click your profile picture, then Profile, then the ⋯ button, then Copy member ID.");
  });
  it("waits only while the code is on the way", () => {
    expect(waitingForCode(link({ pendingSlackUserId: "U0PERSON1", codeStatus: "requested" }))).toBe(true);
    for (const s of ["none", "sent", "expired", "failed"] as const) expect(waitingForCode(link({ codeStatus: s })), s).toBe(false);
    expect(waitingForCode(undefined)).toBe(false);
  });
  it("gives a sentence for each error, and one for an unknown error", () => {
    for (const code of ["slack_id_invalid", "slack_id_in_use", "too_many_requests", "wrong_code", "code_expired", "too_many_tries", "user_not_found"]) {
      expect(slackLinkError(code), code).not.toBe(slackLinkError("other"));
    }
  });
});
