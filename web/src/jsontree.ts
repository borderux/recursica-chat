// SPDX-License-Identifier: AGPL-3.0-only
// A tool call's arguments as a tree to read on an approval card (web/src/ui/toolpreview.tsx): objects
// and arrays as levels that open and close, each value as JSON. A string that is itself JSON, such as a
// JSON file's content, is shown formatted as the JSON it holds, marked as text. Display only: the call
// the agent sent, and the approval, are unchanged.

export type JsonNode =
  | { kind: "object"; entries: [string, JsonNode][] }
  | { kind: "array"; items: JsonNode[] }
  /** A string holding JSON: shown as the JSON it holds. `text` is the string as sent. */
  | { kind: "json-text"; node: JsonNode; text: string }
  /** Any other value, as JSON: "a string", 12, true, null. */
  | { kind: "value"; json: string };

/** A string's JSON, when it holds an object or an array (after any leading or trailing space); else undefined. */
export function jsonIn(s: string): unknown {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A value as a tree. */
export function jsonTree(v: unknown): JsonNode {
  if (Array.isArray(v)) return { kind: "array", items: v.map(jsonTree) };
  if (v && typeof v === "object") return { kind: "object", entries: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonTree(x)]) };
  if (typeof v === "string") {
    const inner = jsonIn(v);
    if (inner !== undefined) return { kind: "json-text", node: jsonTree(inner), text: v };
  }
  return { kind: "value", json: v === undefined ? "null" : JSON.stringify(v) };
}

/** A level's one-line summary when it's closed: {3 keys}, [2 items]. */
export function summary(n: JsonNode): string {
  if (n.kind === "object") return `{${n.entries.length} ${n.entries.length === 1 ? "key" : "keys"}}`;
  if (n.kind === "array") return `[${n.items.length} ${n.items.length === 1 ? "item" : "items"}]`;
  if (n.kind === "json-text") return `${summary(n.node)} JSON text`;
  return n.json;
}

/** Levels deeper than this start closed. */
export const OPEN_DEPTH = 3;
