// SPDX-License-Identifier: AGPL-3.0-only
// @mentions in a message, the same way the server reads them (server/src/services.ts). Plain
// TypeScript with nothing from the browser, so the tests can load it.
const MENTION = /(^|[^\w@])@([a-z][a-z0-9_-]{1,30})/gi;

/** Every @handle in the text, lowercase, once each. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...String(text).matchAll(MENTION)].map((m) => m[2].toLowerCase()))];
}

/** Whether a message from someone else mentions this username, and so should notify them. */
export function mentionsMe(m: { body: string; authorType: string; authorId: string }, me: { id: string; handle?: string | null }): boolean {
  if (!me.handle || (m.authorType === "user" && m.authorId === me.id)) return false;
  return mentionsIn(m.body).includes(me.handle.toLowerCase());
}
