// SPDX-License-Identifier: AGPL-3.0-only
// Tool policy hardening.
//
//   CIRCLECHAT_TOOL_DEFAULT=block   a connected app's tool with no rule is blocked, not decided by
//                                   its kind (read: allow, write: ask, danger: block). Unset, the
//                                   kind decides, as before. MCP tools stay off until reviewed.
//
// The never-list: actions no agent may take, checked before any rule or answer. Nothing in the
// app can change it: not a rule, not an "Always" answer, not an admin.
//   - the GitHub app's tools github_merge_pull_request and github_delete_branch, and the same
//     actions from an MCP server under GitHub's MCP names (<server>__merge_pull_request,
//     <server>__delete_branch);
//   - a call from an HTTP connection to api.github.com that merges (a pull request, or a branch
//     into another), deletes a branch or tag, or deletes a repository, by REST or by GraphQL.
// A never-list matches names and addresses. An MCP server or an API that offers the same action
// under another name or address isn't caught here: repository rules on GitHub are the backstop.

export type ToolDecision = "allow" | "ask" | "block" | "off";

/** "block", or null when unset. Throws on any other value, so a typo fails closed at start. */
export function toolDefault(env: NodeJS.ProcessEnv = process.env): "block" | null {
  const raw = (env.CIRCLECHAT_TOOL_DEFAULT ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "block") return "block";
  throw new Error(`CIRCLECHAT_TOOL_DEFAULT: "${raw}" isn't supported (use block, or leave it unset)`);
}

const NEVER_TOOLS = new Set(["github_merge_pull_request", "github_delete_branch"]);
const NEVER_MCP_TOOLS = new Set(["merge_pull_request", "delete_branch"]);

/** Why a tool is never allowed, by its name alone, or null. */
export function neverByName(name: string, resourceType?: string): string | null {
  const n = name.toLowerCase();
  if (NEVER_TOOLS.has(n)) return `${name} is on the never-list`;
  if (resourceType === "mcp") {
    const own = n.includes("__") ? n.slice(n.lastIndexOf("__") + 2) : n;
    if (NEVER_MCP_TOOLS.has(own)) return `${own} is on the never-list`;
  }
  return null;
}

const GITHUB_API = "api.github.com";
// GraphQL mutations that merge, delete a branch or tag, or delete a repository. A field name can't
// be split or escaped in a GraphQL document, and an alias doesn't hide it, so the name in the
// query text is enough.
const NEVER_GRAPHQL = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|deleteRef|deleteRepository)\b/;

/**
 * Why an HTTP connection's call is never allowed, or null. `url` is the full address the tool would
 * call. A path that can't be decoded is refused: what GitHub would read can't be checked.
 */
export function neverHttp(method: string, url: URL, body?: unknown): string | null {
  if (url.hostname.toLowerCase() !== GITHUB_API) return null;
  let parts: string[];
  try {
    parts = decodeURIComponent(url.pathname).toLowerCase().split("/").filter(Boolean);
  } catch {
    return "a GitHub API path that can't be read";
  }
  const m = method.toUpperCase();
  const repo = parts[0] === "repos" && parts.length >= 3;
  if (m === "PUT" && repo && parts.length === 6 && parts[3] === "pulls" && parts[5] === "merge") return "merging a pull request on GitHub";
  // the other REST merge: one branch straight into another, with no pull request
  if (m === "POST" && repo && parts.length === 4 && parts[3] === "merges") return "merging a branch on GitHub";
  if (m === "DELETE" && repo && parts.length >= 6 && parts[3] === "git" && parts[4] === "refs") return "deleting a branch or tag on GitHub";
  if (m === "DELETE" && repo && parts.length === 3) return "deleting a repository on GitHub";
  if (m === "POST" && parts.length === 1 && parts[0] === "graphql") {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const hit = NEVER_GRAPHQL.exec(text);
    if (hit) return `the GitHub GraphQL mutation ${hit[1]}`;
  }
  return null;
}
