// SPDX-License-Identifier: AGPL-3.0-only
// Refuse a browser request that changes something, or opens the event socket, unless it comes from
// this app's own pages. A page on another site, or on another port of the same host, would
// otherwise send the session cookie with a request it made, and the server would act on it (or,
// for the event socket, show it everything the signed-in person can see).
//
//   CIRCLECHAT_PUBLIC_URL=https://chat.example.com[,https://other.example.com]
//
// Each address people use to open the app, comma-separated: the web app's address and the
// desktop app's server address (the desktop app loads the server's own pages, so its requests
// carry that origin). Unset, only a loopback page on the server's own host and port may change
// anything: local development. Behind a proxy, or on any other address, every browser request
// that changes something is then refused until the setting names the address.
//
// The check covers /api/* with POST, PUT, PATCH or DELETE, and the /ws event socket. It doesn't
// cover webhooks (/hooks/*, signed), the agents' tool endpoint (/mcp/*) or the model proxy
// (/llm/*): they never read the session cookie, and their callers aren't browsers.

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The allowed origins from CIRCLECHAT_PUBLIC_URL, or null when it isn't set. Throws on a bad value. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = (env.CIRCLECHAT_PUBLIC_URL ?? "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new Error(`CIRCLECHAT_PUBLIC_URL: "${s}" isn't an address`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`CIRCLECHAT_PUBLIC_URL: "${s}" must start with https:// or http://`);
      return u.origin;
    });
}

export interface OriginRequest {
  method: string;
  /** true for the /ws upgrade, which is checked whatever its method */
  socket?: boolean;
  origin?: string;
  secFetchSite?: string;
  /** the Host header the request arrived with */
  host?: string;
  cookie?: string;
}

/** Why the request is refused, or null when it may go on. */
export function originProblem(r: OriginRequest, allowed: string[] | null): string | null {
  if (!r.socket && !CHANGES.has(r.method.toUpperCase())) return null;
  if (r.origin) {
    return originAllowed(r.origin, r.host, allowed) ? null : `This server doesn't accept requests from ${r.origin} (CIRCLECHAT_PUBLIC_URL).`;
  }
  // Every current browser sends Origin on these requests; Sec-Fetch-Site is the fallback.
  if (r.secFetchSite) {
    return r.secFetchSite === "same-origin" ? null : `This server doesn't accept ${r.secFetchSite} requests.`;
  }
  // Neither header: not a browser. Only a request that doesn't use the session cookie may go on,
  // such as one with an API token, or a script signing in.
  return hasSession(r.cookie) ? "A request with a session must come from this app's own pages." : null;
}

function originAllowed(origin: string, host: string | undefined, allowed: string[] | null): boolean {
  let o: URL;
  try {
    o = new URL(origin); // "null" (a sandboxed or file page) throws, and is refused
  } catch {
    return false;
  }
  if (allowed) return allowed.includes(o.origin);
  // Unset: local development only. The page must be on loopback, on the host and port the
  // request itself arrived at.
  return LOOPBACK.has(o.hostname) && !!host && o.host.toLowerCase() === host.toLowerCase();
}

function hasSession(cookie: string | undefined): boolean {
  return /(?:^|;\s*)cc_session=[^;]/.test(cookie ?? "");
}
