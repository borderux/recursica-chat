// Fork: a person's Slack member ID, for Slack DMs about mentions. The server
// rules are in api/src/lib/slack-link-rules.ts.

export type CodeStatus = "none" | "requested" | "sent" | "expired" | "failed";
export interface SlackLink {
  slackUserId: string | null;
  verifiedAt: string | null;
  pendingSlackUserId: string | null;
  codeStatus: CodeStatus;
  sendError: string | null;
  triesLeft: number | null;
  prompt: boolean;
}

// The steps that find the ID in Slack, shown under each Slack ID field.
export const FIND_ID_STEPS = "In Slack, click your profile picture, then Profile, then the ⋯ button, then Copy member ID.";

// A Slack member ID: U or W, then capital letters and digits. Lower case reads as capitals.
export const normalizeSlackId = (s: string) => s.trim().toUpperCase();
export const isSlackId = (s: string) => /^[UW][A-Z0-9]{6,19}$/.test(normalizeSlackId(s));

// The screen polls while the code is on the way, so the code field opens when the code is sent.
export const waitingForCode = (link: SlackLink | undefined) => link?.codeStatus === "requested";

// A sentence for each error the server returns.
export function slackLinkError(code: string): string {
  switch (code) {
    case "slack_id_invalid": return "That isn't a Slack member ID. A member ID starts with U or W, such as U0123ABCD.";
    case "slack_id_in_use": return "Another person in CircleChat already uses that Slack member ID.";
    case "too_many_requests": return "You asked for 3 codes in the last hour. Try again later.";
    case "code_invalid": return "Type the 6 digits from the Slack message.";
    case "wrong_code": return "That code doesn't match. Check the Slack message and try again.";
    case "code_expired": return "The code expired. Send a new code.";
    case "too_many_tries": return "Too many wrong tries. Send a new code.";
    case "no_code": return "No code is waiting. Send a code first.";
    case "user_not_found": return "Slack doesn't know that member ID. Check the ID and try again.";
    default: return "CircleChat couldn't save the Slack ID. Try again.";
  }
}
