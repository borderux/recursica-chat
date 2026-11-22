// SPDX-License-Identifier: AGPL-3.0-only
// The starters an empty chat shows (server/src/starters.ts): the agent's own, or the generic ones.
// A starter with [placeholders] opens a small dialog (StarterDialog in screens/Chats.tsx): one field
// per placeholder, a live preview, and Send once every field is filled.

/** Shown for an agent with no starters of its own. */
export const GENERIC_STARTERS = [
  "What can you do for our team?",
  "Find the 3 best tools for running a small team and compare them",
  "Plan a product launch for next Tuesday as a checklist",
  "Write a short, friendly welcome email for new customers",
];

/** The agent's starters, or the generic ones when it has none. */
export const startersFor = (agent?: { starters?: string[] }): string[] => (agent?.starters?.length ? agent.starters : GENERIC_STARTERS);

const PLACEHOLDER = /\[([^\[\]\n]+)\]/g;

/** Each placeholder's text, in order, once each: "One interview about [your subject]" gives ["your subject"]. */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const label = m[1].trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** The starter's text in parts: plain text, and each placeholder with its value, or blank when it has none yet. */
export function previewParts(text: string, values: Record<string, string>): { text: string; blank?: boolean }[] {
  const parts: { text: string; blank?: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    const v = (values[m[1].trim()] ?? "").trim();
    parts.push(v ? { text: v } : { text: m[0], blank: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** The finished message: each placeholder replaced by its value; one with no value keeps its brackets. */
export const fillStarter = (text: string, values: Record<string, string>) =>
  previewParts(text, values)
    .map((p) => p.text)
    .join("");

/** Whether every placeholder has a value. */
export const allFilled = (labels: string[], values: Record<string, string>) => labels.every((l) => (values[l] ?? "").trim().length > 0);

/** Whether the starter mentions an attachment, such as "based on the attached persona": the dialog then offers Attach. */
export const mentionsAttachment = (text: string) => /\battach(?:ed|ment|ments|ing)?\b/i.test(text);
