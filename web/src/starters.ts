// SPDX-License-Identifier: AGPL-3.0-only
// The starters an empty chat shows (server/src/starters.ts): the agent's own, or the generic ones.

/** Shown for an agent with no starters of its own. */
export const GENERIC_STARTERS = [
  "What can you do for our team?",
  "Find the 3 best tools for running a small team and compare them",
  "Plan a product launch for next Tuesday as a checklist",
  "Write a short, friendly welcome email for new customers",
];

/** The agent's starters, or the generic ones when it has none. */
export const startersFor = (agent?: { starters?: string[] }): string[] => (agent?.starters?.length ? agent.starters : GENERIC_STARTERS);

/**
 * Where the first [placeholder] is, as [start, end) around the brackets, or null when there is none.
 * A starter with one fills the message box for editing, with the placeholder selected, instead of
 * sending.
 */
export function placeholderIn(text: string): [number, number] | null {
  const m = /\[[^\[\]\n]+\]/.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}
