// SPDX-License-Identifier: AGPL-3.0-only
// Tool previews for approval cards. An MCP server may name, in a tool's _meta, a preview tool for it:
//
//   { "name": "write_note", "_meta": { "ui/preview": "write_note_preview" }, ... }
//
// The preview tool, on the same server, takes the same arguments, changes nothing, and returns short
// Markdown that says what the call would do. When a call to the tool waits for a person's approval,
// the gateway calls the preview tool with the call's exact arguments, and the approval card shows the
// Markdown above the exact call (web/src/ui/toolpreview.tsx). A preview tool is never
// offered to agents and gets no rule of its own. With no preview, or one that fails, says nothing or
// takes too long, the card is as it was.

/** The _meta key that names a tool's preview tool. */
export const PREVIEW_META = "ui/preview";

/** How long the gateway waits for a preview, and the most of it the card shows. */
export const PREVIEW_LIMITS = { ms: 10_000, chars: 20_000 };

/** A tool as an MCP server lists it. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}

/** A tool as the gateway keeps it in a server's snapshot: with the name of its preview tool, when it has one. */
export interface StoredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
  preview?: string;
}

/**
 * A server's tools as the gateway keeps them: each preview tool taken out of the list, and named on the
 * tool it previews. A _meta that names the tool itself, or a tool the server doesn't list, is no preview.
 */
export function withPreviews(listed: ListedTool[]): StoredTool[] {
  const names = new Set(listed.map((t) => t.name));
  const previewOf = (t: ListedTool) => {
    const p = t._meta?.[PREVIEW_META];
    return typeof p === "string" && p !== t.name && names.has(p) ? p : undefined;
  };
  const previews = new Set(listed.map(previewOf).filter((p): p is string => !!p));
  return listed
    .filter((t) => !previews.has(t.name))
    .map((t) => {
      const preview = previewOf(t);
      return { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, annotations: t.annotations ?? {}, ...(preview ? { preview } : {}) };
    });
}

/** A preview's Markdown, or undefined when it fails, says nothing or takes longer than limits.ms; cut at limits.chars. */
export async function previewText(run: () => Promise<string>, limits = PREVIEW_LIMITS): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new Error("the preview took too long")), limits.ms);
    });
    const text = String((await Promise.race([run(), late])) ?? "").trim();
    if (!text) return undefined;
    return text.length > limits.chars ? `${text.slice(0, limits.chars)}\n\n…` : text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
