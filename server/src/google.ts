// SPDX-License-Identifier: AGPL-3.0-only
// Sign in with Google, for owners and admins.
//
//   CIRCLECHAT_GOOGLE_CLIENT_ID            the OAuth client's id; sign-in with Google is on when set
//   CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE   a file holding the client secret (never the secret itself
//                                          in the environment); not readable by others
//   CIRCLECHAT_GOOGLE_DOMAIN               optional: only accounts of this Google Workspace domain
//   CIRCLECHAT_PASSWORD_SIGNIN             all (default) | members (owners and admins must use
//                                          Google) | off (nobody signs in with a password)
//
// The redirect address is <first address in CIRCLECHAT_PUBLIC_URL>/auth/google/callback, so
// CIRCLECHAT_PUBLIC_URL must be set too.
//
// The flow: authorization code with PKCE (S256), a state and a nonce. The state, nonce and code
// verifier stay on the server, under a random id in a short-lived httpOnly cookie, and each flow
// can be used once. Google's endpoints are fixed (no discovery, so nothing to steer elsewhere).
// The ID token comes straight from Google's token endpoint over TLS, so its signature isn't
// checked (OpenID Connect Core 3.1.3.7), but every claim that matters is: iss, aud (and azp),
// exp, iat, nonce, email_verified, and hd when a domain is set.
//
// Sign-in only finds an existing owner or admin by email. It never creates an account and never
// signs in a member.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { allowedOrigins } from "./origin.ts";

export type PasswordSignIn = "all" | "members" | "off";

/** Google's endpoints. Fixed in production; the tests point them at a fake Google. */
export const GOOGLE = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const FLOW_COOKIE = "cc_google_flow";
const FLOW_MS = 10 * 60_000;
const SKEW_S = 60;

export interface GoogleConfig {
  clientId: string;
  secretFile: string;
  domain: string | null;
  redirectUri: string;
}

/** Sign-in with Google's settings, or null when it is off. Throws on settings that don't fit. */
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = (env.CIRCLECHAT_GOOGLE_CLIENT_ID ?? "").trim();
  if (!clientId) return null;
  const secretFile = (env.CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE ?? "").trim();
  if (!secretFile) throw new Error("CIRCLECHAT_GOOGLE_CLIENT_ID is set, so CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE must name the client secret's file");
  const origins = allowedOrigins(env);
  if (!origins?.length) throw new Error("Sign-in with Google needs CIRCLECHAT_PUBLIC_URL: its first address is where Google sends people back");
  const domain = (env.CIRCLECHAT_GOOGLE_DOMAIN ?? "").trim().toLowerCase() || null;
  return { clientId, secretFile, domain, redirectUri: `${origins[0]}/auth/google/callback` };
}

/** Reads the client secret. The file must be a plain file that others can't read or write. */
export function readClientSecret(file: string): string {
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${file} isn't a plain file`);
  if (st.mode & 0o006) throw new Error(`${file} must not be readable or writable by others`);
  const secret = readFileSync(file, "utf8").trim();
  if (!secret) throw new Error(`${file} is empty`);
  return secret;
}

/** CIRCLECHAT_PASSWORD_SIGNIN. members and off need sign-in with Google, or nobody could get in. */
export function passwordSignIn(env: NodeJS.ProcessEnv = process.env): PasswordSignIn {
  const raw = (env.CIRCLECHAT_PASSWORD_SIGNIN ?? "").trim().toLowerCase() || "all";
  if (raw !== "all" && raw !== "members" && raw !== "off") throw new Error(`CIRCLECHAT_PASSWORD_SIGNIN: "${raw}" isn't one of all, members, off`);
  if (raw !== "all" && !googleConfig(env))
    throw new Error(`CIRCLECHAT_PASSWORD_SIGNIN=${raw} needs sign-in with Google (CIRCLECHAT_GOOGLE_CLIENT_ID), or owners and admins couldn't sign in`);
  return raw;
}

/** Why this role may not sign in with a password, or null when it may. */
export function passwordRefusal(role: string, mode: PasswordSignIn = passwordSignIn()): string | null {
  if (mode === "off") return "Password sign-in is off. Sign in with Google.";
  if (mode === "members" && (role === "owner" || role === "admin")) return "Owners and admins sign in with Google.";
  return null;
}

const b64url = (b: Buffer) => b.toString("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Why an ID token's claims are refused, or null when they pass. `now` in seconds. */
export function idTokenProblem(
  claims: any,
  want: { clientId: string; nonce: string; domain: string | null },
  now = Math.floor(Date.now() / 1000),
): string | null {
  if (!claims || typeof claims !== "object") return "no-claims";
  if (!ISSUERS.has(claims.iss)) return "issuer";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(want.clientId)) return "audience";
  if (aud.length > 1 && claims.azp !== want.clientId) return "audience";
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) return "expired";
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > now) return "issued-in-future";
  if (typeof claims.nonce !== "string" || !same(claims.nonce, want.nonce)) return "nonce";
  if (claims.email_verified !== true) return "email-not-verified";
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return "no-email";
  if (want.domain && String(claims.hd ?? "").toLowerCase() !== want.domain) return "domain";
  return null;
}

/** The claims in a JWT's payload. Throws on anything that isn't one. */
export function jwtClaims(jwt: string): any {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}

export interface GoogleDeps {
  db: { prepare(sql: string): { get(...args: any[]): unknown } };
  /** signs the user in, and sets the session cookie */
  login(c: Context, uid: string): unknown;
  isHttps(c: Context): boolean;
}

/** Adds /auth/google/start and /auth/google/callback. They answer 404 while sign-in with Google is off. */
export function registerGoogleSignIn(api: Hono<any>, deps: GoogleDeps): void {
  const flows = new Map<string, Flow>();
  const sweep = () => {
    const t = Date.now();
    for (const [k, f] of flows) if (f.expires < t) flows.delete(k);
  };
  const fail = (c: Context, reason: string) => {
    console.warn(`[google] sign-in refused: ${reason}`);
    deleteCookie(c, FLOW_COOKIE, { path: "/auth/google" });
    return c.redirect(`/?signin=google-${encodeURIComponent(reason)}`, 302);
  };

  api.get("/auth/google/start", (c) => {
    const cfg = googleConfig();
    if (!cfg) return c.notFound();
    sweep();
    if (flows.size > 10_000) flows.clear(); // never grow without bound
    const id = b64url(randomBytes(24));
    const flow: Flow = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)), expires: Date.now() + FLOW_MS };
    flows.set(id, flow);
    setCookie(c, FLOW_COOKIE, id, { httpOnly: true, sameSite: "Lax", path: "/auth/google", maxAge: FLOW_MS / 1000, secure: deps.isHttps(c) });
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: "openid email",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: b64url(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(cfg.domain ? { hd: cfg.domain } : {}),
    });
    return c.redirect(`${GOOGLE.authUrl}?${q}`, 302);
  });

  api.get("/auth/google/callback", async (c) => {
    const cfg = googleConfig();
    if (!cfg) return c.notFound();
    // the flow this browser started, once: a callback without it (another browser's, or a replay)
    // is refused, so nobody can sign someone else in to their own account
    const id = getCookie(c, FLOW_COOKIE) ?? "";
    const flow = flows.get(id);
    flows.delete(id);
    if (!flow || flow.expires < Date.now()) return fail(c, "no-flow");
    if (!same(c.req.query("state") ?? "", flow.state)) return fail(c, "state");
    if (c.req.query("error")) return fail(c, "cancelled");
    const code = c.req.query("code") ?? "";
    if (!code) return fail(c, "no-code");

    let idToken = "";
    try {
      const r = await fetch(GOOGLE.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: readClientSecret(cfg.secretFile),
          redirect_uri: cfg.redirectUri,
          grant_type: "authorization_code",
          code_verifier: flow.verifier,
        }),
        redirect: "error",
      });
      if (!r.ok) return fail(c, "token-endpoint");
      idToken = String(((await r.json()) as any)?.id_token ?? "");
    } catch {
      return fail(c, "token-endpoint");
    }
    let claims: any;
    try {
      claims = jwtClaims(idToken);
    } catch {
      return fail(c, "token");
    }
    const problem = idTokenProblem(claims, { clientId: cfg.clientId, nonce: flow.nonce, domain: cfg.domain });
    if (problem) return fail(c, problem);

    const email = String(claims.email).toLowerCase();
    const u = deps.db.prepare("SELECT id, role FROM users WHERE email = ?").get(email) as any;
    if (!u || (u.role !== "owner" && u.role !== "admin")) return fail(c, "no-account");
    deleteCookie(c, FLOW_COOKIE, { path: "/auth/google" });
    deps.login(c, u.id);
    return c.redirect("/", 302);
  });
}
