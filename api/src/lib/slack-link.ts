// Fork: reads and writes for a person's Slack member ID. The rules are in
// slack-link-rules.ts. Only the routes in routes/slack-link.ts call this file,
// and only with the signed-in person's own user ID.
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { userSlack } from "../db/fork-schema.js";
import { redis } from "./redis.js";
import { MAX_REQUESTS_PER_HOUR, checkCode, publicLink, type LinkRow } from "./slack-link-rules.js";

async function row(userId: string): Promise<LinkRow | undefined> {
  const [r] = await db.select().from(userSlack).where(eq(userSlack.userId, userId)).limit(1);
  return r;
}

export async function getLink(userId: string) {
  return publicLink(await row(userId), new Date());
}

// Keeps the ID as pending, clears any older code, and asks the notifier for a
// code. Refuses a fourth request within an hour, and an ID another person has
// verified.
export async function requestCode(userId: string, slackUserId: string): Promise<{ ok: true } | { ok: false; error: "too_many_requests" | "slack_id_in_use" }> {
  const [taken] = await db.select({ userId: userSlack.userId }).from(userSlack)
    .where(and(eq(userSlack.slackUserId, slackUserId), ne(userSlack.userId, userId))).limit(1);
  if (taken) return { ok: false, error: "slack_id_in_use" };
  const key = `cc:slack-code:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  if (count > MAX_REQUESTS_PER_HOUR) return { ok: false, error: "too_many_requests" };
  const now = new Date();
  const fresh = {
    pendingSlackUserId: slackUserId, codeRequestedAt: now, codeSalt: null, codeHash: null, codeSentAt: null,
    codeExpiresAt: null, codeAttempts: 0, sendError: null, updatedAt: now,
  };
  await db.insert(userSlack).values({ userId, ...fresh }).onConflictDoUpdate({ target: userSlack.userId, set: fresh });
  await db.execute(sql`select pg_notify('slack_code', ${userId})`);
  return { ok: true };
}

// Checks a typed code. A wrong code costs one try. On a match, the pending ID
// becomes the verified ID, and the modal never asks again.
export async function verifyCode(userId: string, code: string) {
  const r = await row(userId);
  const result = checkCode(r, code, new Date());
  if (!result.ok) {
    if (result.error === "wrong_code") {
      await db.update(userSlack).set({ codeAttempts: sql`${userSlack.codeAttempts} + 1`, updatedAt: new Date() }).where(eq(userSlack.userId, userId));
    }
    return result;
  }
  const now = new Date();
  try {
    await db.update(userSlack).set({
      slackUserId: result.slackUserId, verifiedAt: now, pendingSlackUserId: null, codeRequestedAt: null,
      codeSalt: null, codeHash: null, codeSentAt: null, codeExpiresAt: null, codeAttempts: 0, sendError: null,
      promptClosedAt: sql`coalesce(${userSlack.promptClosedAt}, now())`, updatedAt: now,
    }).where(eq(userSlack.userId, userId));
  } catch (e) {
    // The unique index: another person verified the same ID first.
    if ((e as { code?: string }).code === "23505") return { ok: false as const, error: "slack_id_in_use" as const };
    throw e;
  }
  return result;
}

// Removes the verified and the pending ID. DMs stop at once.
export async function removeLink(userId: string): Promise<void> {
  await db.update(userSlack).set({
    slackUserId: null, verifiedAt: null, pendingSlackUserId: null, codeRequestedAt: null, codeSalt: null,
    codeHash: null, codeSentAt: null, codeExpiresAt: null, codeAttempts: 0, sendError: null, updatedAt: new Date(),
  }).where(eq(userSlack.userId, userId));
}

// Skip, or any close of the modal: the modal never asks again.
export async function closePrompt(userId: string): Promise<void> {
  const now = new Date();
  await db.insert(userSlack).values({ userId, promptClosedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: userSlack.userId, set: { promptClosedAt: now, updatedAt: now } });
}
