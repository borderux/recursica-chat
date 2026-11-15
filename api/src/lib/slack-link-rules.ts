// Fork: the rules for linking a person's Slack member ID, for Slack DMs about
// mentions. No database, so the rules are easy to test. The reads and writes
// are in slack-link.ts, and the routes in routes/slack-link.ts.
//
// How a person proves a Slack ID belongs to the person:
//   1. The person types the ID. CircleChat keeps the ID as pending and sends
//      the database notice "slack_code".
//   2. A notifier outside CircleChat, which holds the Slack bot token, makes a
//      6-digit code, writes the code's salt and SHA-256 hash, and sends the
//      code to the pending ID as a Slack DM. The code itself is never stored.
//   3. The person types the code. CircleChat hashes the typed code with the
//      salt and compares the two hashes. On a match, the pending ID becomes the
//      verified ID.
// A code works for 10 minutes and for 5 tries. A person asks for at most 3
// codes an hour, so nobody can make the bot DM a stranger often.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const CODE_DIGITS = 6;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_TRIES = 5;
export const MAX_REQUESTS_PER_HOUR = 3;

// A Slack member ID: U or W, then capital letters and digits.
export const SLACK_ID = /^[UW][A-Z0-9]{6,19}$/;
export const SlackIdBody = z.object({ slackUserId: z.string().trim().toUpperCase().regex(SLACK_ID) }).strict();
export const CodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict();

// The hash the notifier writes: SHA-256 of "<salt>:<code>", in hex.
export function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export interface LinkRow {
  slackUserId: string | null;
  verifiedAt: Date | null;
  pendingSlackUserId: string | null;
  codeRequestedAt: Date | null;
  codeSalt: string | null;
  codeHash: string | null;
  codeSentAt: Date | null;
  codeExpiresAt: Date | null;
  codeAttempts: number;
  sendError: string | null;
  promptClosedAt: Date | null;
}

// The state of the code for the pending ID, as the screens show the state.
//   none: no pending ID. requested: waiting for the notifier. sent: a code to
//   type. expired: the code's time or tries ran out. failed: Slack refused the
//   DM, such as for an ID Slack doesn't know.
export type CodeStatus = "none" | "requested" | "sent" | "expired" | "failed";
export function codeStatus(row: LinkRow | undefined, now: Date): CodeStatus {
  if (!row?.pendingSlackUserId) return "none";
  if (row.sendError) return "failed";
  if (!row.codeSentAt || !row.codeHash) return "requested";
  if (!row.codeExpiresAt || row.codeExpiresAt <= now || row.codeAttempts >= MAX_TRIES) return "expired";
  return "sent";
}

// The modal asks once, after any sign-in, each person with no verified ID.
// Skip, any close, or a verified ID ends the asking for good.
export function showPrompt(row: LinkRow | undefined): boolean {
  return !row?.slackUserId && !row?.promptClosedAt;
}

// What GET /users/me/slack returns. Never the salt or the hash.
export function publicLink(row: LinkRow | undefined, now: Date) {
  return {
    slackUserId: row?.slackUserId ?? null,
    verifiedAt: row?.verifiedAt ?? null,
    pendingSlackUserId: row?.pendingSlackUserId ?? null,
    codeStatus: codeStatus(row, now),
    sendError: row?.sendError ?? null,
    triesLeft: row?.pendingSlackUserId ? Math.max(0, MAX_TRIES - (row.codeAttempts ?? 0)) : null,
    prompt: showPrompt(row),
  };
}

// The result of a typed code. A wrong code costs one try.
export type VerifyResult = { ok: true; slackUserId: string } | { ok: false; error: "no_code" | "code_expired" | "too_many_tries" | "wrong_code" };
export function checkCode(row: LinkRow | undefined, typed: string, now: Date): VerifyResult {
  if (!row?.pendingSlackUserId || !row.codeHash || !row.codeSalt || !row.codeSentAt) return { ok: false, error: "no_code" };
  if (row.codeAttempts >= MAX_TRIES) return { ok: false, error: "too_many_tries" };
  if (!row.codeExpiresAt || row.codeExpiresAt <= now) return { ok: false, error: "code_expired" };
  const a = Buffer.from(hashCode(row.codeSalt, typed), "hex");
  const b = Buffer.from(row.codeHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "wrong_code" };
  return { ok: true, slackUserId: row.pendingSlackUserId };
}
