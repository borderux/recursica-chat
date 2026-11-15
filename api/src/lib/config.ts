import { coerceInt, coerceNum, envInt } from "./env.js";

const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: envInt("PORT", 3000, { min: 1 }),
  databaseUrl: required("DATABASE_URL", "postgres://postgres:circlechat@localhost:5432/circlechat"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me-at-least-32-chars-long"),
  publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:5173"),
  apiInternalUrl:
    process.env.API_INTERNAL_URL ?? `http://localhost:${envInt("PORT", 3000, { min: 1 })}`,
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  smtpUrl: process.env.SMTP_URL ?? "",
  // CORS compares origins, not full URLs (PUBLIC_BASE_URL may include a path
  // or a trailing slash in operator-managed deployments).
  publicOrigin: new URL(required("PUBLIC_BASE_URL", "http://localhost:5173")).origin,
} as const;

// ───────────────── approval policy (read at call time, so tests + hot env
// changes work) ─────────────────
//
// Anything here changes how much a human must be in the loop, so every
// default is the conservative one: cards expire (so nothing waits forever),
// denials are remembered (so agents can't re-ask), and nothing is
// auto-approved unless an operator lists it.

const num = (name: string, fallback: number, min = 0): number =>
  coerceNum(process.env[name], fallback, { min });

// Hours a pending approval may wait for a human before it is marked
// `expired`, the agent is woken with approval_response status "expired", and
// tasks blocked on it are released. 0 = never expire (the legacy behaviour).
// APPROVAL_DEFAULT_TTL is accepted as an alias.
export function approvalTtlHours(): number {
  if (process.env.APPROVAL_TTL_HOURS != null && process.env.APPROVAL_TTL_HOURS.trim() !== "") {
    return num("APPROVAL_TTL_HOURS", 72);
  }
  return num("APPROVAL_DEFAULT_TTL", 72);
}

// Days a denied (or expired) approval keeps refusing equivalent re-requests.
export function approvalDenialMemoryDays(): number {
  return num("APPROVAL_DENIAL_MEMORY_DAYS", 7);
}

// Comma-separated approval scopes that are auto-approved (with an audit row)
// for every agent in the deployment. Entries match an approval's scope
// exactly (case-insensitive) or by prefix with a trailing `*`
// (`tasks.*`, `risk:*`, `deploy*`). Credential requests are never
// auto-approved — approving them produces no secret. Empty by default.
export function autoApproveScopes(): string[] {
  return (process.env.AUTO_APPROVE_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// One setting decides how long a turn lasts: the turn limit below. From it:
//   - each turn's deadline, set when the turn starts (agents/turn-queue.ts);
//   - when the bridge kills the turn: it gets the time left until the
//     deadline with the dispatch, sends SIGTERM when the limit is spent and
//     kills the container at the deadline (api/hermes-multi-bridge.mjs);
//   - how long the api waits for the bridge's reply: until the deadline, plus
//     TURN_DELIVERY_MS for a reply the bridge sends as it kills the turn;
//   - whether a reply is applied: every reply the worker receives arrived in
//     that wait, so none is cancelled as run_timeout (replyInTime).
// CC_DISPATCH_TIMEOUT_MS, a second setting for the wait, is gone: a wait
// longer than the deadline let a reply arrive after it and be cancelled.

// The longest one turn can take: the bridge's turn limit (HERMES_TIMEOUT
// seconds) plus the grace its container gets to shut down
// (CC_AGENT_STOP_GRACE_SEC, at least 5 s). Read the same way the bridge
// reads both values.
export function turnLimitMs(env: Record<string, string | undefined> = process.env): number {
  const limitSec = coerceNum(env.HERMES_TIMEOUT, 480, { min: 1 });
  const graceSec = Math.max(5, coerceNum(env.CC_AGENT_STOP_GRACE_SEC, 45, { min: 1 }));
  return (limitSec + graceSec) * 1000;
}

// Time for a reply the bridge sends at the deadline to reach the api.
export const TURN_DELIVERY_MS = 15_000;
// Time for the api's answer (the reply, or its 504) to reach the worker.
export const DISPATCH_SLACK_MS = 15_000;

// How long the api waits for the bridge: until the turn's deadline, plus
// delivery. A dispatch without a deadline waits one whole turn.
export function dispatchTimeoutMs(
  timeoutAt: Date | null = null,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
): number {
  const untilDeadline = timeoutAt ? +timeoutAt - +now : turnLimitMs(env);
  return Math.max(1_000, untilDeadline) + TURN_DELIVERY_MS;
}

// The time the bridge has for the turn: what is left until the deadline.
export function turnMsLeft(timeoutAt: Date | null, now = new Date(), env: Record<string, string | undefined> = process.env): number {
  return Math.max(1_000, timeoutAt ? +timeoutAt - +now : turnLimitMs(env));
}

// A reply the worker received in the dispatch's wait is applied. Only a reply
// that came later than any wait allows (a run whose deadline was cut short)
// is cancelled as run_timeout.
export function replyInTime(replyAt: Date, timeoutAt: Date | null): boolean {
  return !timeoutAt || +replyAt <= +timeoutAt + TURN_DELIVERY_MS + DISPATCH_SLACK_MS;
}
