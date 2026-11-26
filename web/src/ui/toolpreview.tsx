// SPDX-License-Identifier: AGPL-3.0-only
// An approval card's call, when the tool's MCP server gives a preview of it (server/src/toolpreview.ts):
// the preview's Markdown on top, rendered as safely as agent replies are, and below it the exact call,
// always on the card, as a tree to read (web/src/jsontree.ts): indented, each level opens and closes,
// and a string that is itself JSON, such as a JSON file's content, shown formatted. Display only: the
// call and the approval are unchanged. Without a preview, the card shows the call as before.
import type { ReactNode } from "react";
import { Markdown } from "./Markdown.tsx";
import { OPEN_DEPTH, jsonTree, summary, type JsonNode } from "../jsontree.ts";

/** An approval's preview, when its detail holds one. */
export const previewOf = (detail: any): string | undefined => (typeof detail?.preview === "string" && detail.preview.trim() ? detail.preview : undefined);

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** A level's children: an object's keys, an array's items, or the JSON a string holds. */
function children(n: JsonNode): [string, JsonNode][] | undefined {
  if (n.kind === "object") return n.entries.map(([k, v]) => [JSON.stringify(k), v]);
  if (n.kind === "array") return n.items.map((v, i) => [String(i), v]);
  if (n.kind === "json-text") return children(n.node);
  return undefined;
}

/** One row of the tree: a key and its value, or a level that opens and closes. */
function Row({ label, n, depth }: { label: ReactNode; n: JsonNode; depth: number }) {
  const kids = children(n);
  if (!kids) return <div className="jt-row">{label}{n.kind === "value" ? <span className="jt-v">{n.json}</span> : null}</div>;
  if (!kids.length) return <div className="jt-row">{label}{n.kind === "array" || (n.kind === "json-text" && n.node.kind === "array") ? "[]" : "{}"}</div>;
  return (
    <details className="jt" open={depth < OPEN_DEPTH}>
      <summary style={{ cursor: "pointer" }}>
        {label}
        <span className="muted">{summary(n.kind === "json-text" ? n.node : n)}</span>
        {n.kind === "json-text" ? <span className="muted"> · JSON text, shown formatted</span> : null}
      </summary>
      <div style={{ paddingLeft: 14, marginLeft: 4, borderLeft: "1px solid var(--line)" }}>
        {kids.map(([k, v]) => (
          <Row key={k} label={<span className="jt-k">{k}: </span>} n={v} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

/** The exact call, as a tree: the tool's name, then its arguments. */
export function ExactCall({ tool, args }: { tool: string; args: unknown }) {
  return (
    <div className="exact-call" style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.55, background: "var(--surface)", borderRadius: 12, padding: "10px 12px", maxHeight: 320, overflow: "auto", overflowWrap: "anywhere" }}>
      <Row label={<b>{tool} </b>} n={jsonTree(args ?? {})} depth={0} />
    </div>
  );
}

export function CallPreview({ tool, args, preview }: { tool: string; args: unknown; preview: string }) {
  return (
    <div className="call-preview" style={{ background: "var(--bg)", borderRadius: 14, padding: "10px 12px" }}>
      <div style={{ maxHeight: 420, overflow: "auto" }}>
        <Markdown text={preview} />
      </div>
      <div className="small muted" style={{ margin: "8px 0 6px" }}>
        The exact call
      </div>
      <ExactCall tool={tool} args={args} />
    </div>
  );
}
