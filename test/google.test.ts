// SPDX-License-Identifier: AGPL-3.0-only
// Sign in with Google, against a fake Google: the code flow with PKCE, state and nonce; every claim
// check; matching only an existing owner or admin, or anyone in the domain, never creating anyone;
// the client secret from a file; and CIRCLECHAT_PASSWORD_SIGNIN. Nothing in this file may reach
// the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOGLE, googleConfig, passwordSignIn, passwordRefusal, idTokenProblem, readClientSecret, inDomain } from "../server/src/google.ts";
import { startApp, setupOwner, fakeServer, Client, type Harness } from "./helpers.ts";
import { noOutsideNetwork, type NetworkGuard } from "./no-network.ts";

const CLIENT_ID = "example-client.apps.googleusercontent.com";
const SECRET = "example-client-secret-value";
const PUBLIC = "https://chat.example.com";
const DOMAIN = "example.com";
const now = () => Math.floor(Date.now() / 1000);

// the client secret's file, made before anything runs (before() runs ahead of the first test)
const dir = mkdtempSync(join(tmpdir(), "google-test-"));
const secretFile = join(dir, "client-secret");
writeFileSync(secretFile, SECRET + "\n");
chmodSync(secretFile, 0o600);
const env = (extra: Record<string, string> = {}) => ({
  CIRCLECHAT_GOOGLE_CLIENT_ID: CLIENT_ID,
  CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE: secretFile,
  CIRCLECHAT_PUBLIC_URL: PUBLIC,
  CIRCLECHAT_GOOGLE_DOMAIN: DOMAIN,
  ...extra,
});

// ---------------------------------------------------------------- settings and checks

test("settings: on with a client id; needs the secret's file and the public address; fails closed", () => {
  assert.equal(googleConfig({}), null);
  assert.deepEqual(googleConfig(env()), { clientId: CLIENT_ID, secretFile, domain: DOMAIN, redirectUri: `${PUBLIC}/auth/google/callback` });
  assert.equal(googleConfig(env({ CIRCLECHAT_GOOGLE_DOMAIN: "" }))!.domain, null);
  assert.throws(() => googleConfig(env({ CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE: "" })), /SECRET_FILE/);
  assert.throws(() => googleConfig(env({ CIRCLECHAT_PUBLIC_URL: "" })), /CIRCLECHAT_PUBLIC_URL/);
});

test("the client secret comes from its file, which others may not read", () => {
  assert.equal(readClientSecret(secretFile), SECRET);
  chmodSync(secretFile, 0o644);
  assert.throws(() => readClientSecret(secretFile), /must not be readable or writable by others/);
  chmodSync(secretFile, 0o600);
  const empty = join(dir, "empty");
  writeFileSync(empty, "\n");
  chmodSync(empty, 0o600);
  assert.throws(() => readClientSecret(empty), /empty/);
});

test("CIRCLECHAT_PASSWORD_SIGNIN: all, members or off; members and off need Google", () => {
  assert.equal(passwordSignIn({}), "all");
  assert.equal(passwordSignIn(env({ CIRCLECHAT_PASSWORD_SIGNIN: "members" })), "members");
  assert.equal(passwordSignIn(env({ CIRCLECHAT_PASSWORD_SIGNIN: "off" })), "off");
  assert.throws(() => passwordSignIn({ CIRCLECHAT_PASSWORD_SIGNIN: "members" }), /needs sign-in with Google/);
  assert.throws(() => passwordSignIn(env({ CIRCLECHAT_PASSWORD_SIGNIN: "admins" })), /isn't one of/);
  assert.equal(passwordRefusal("owner", "all"), null);
  assert.match(passwordRefusal("owner", "members")!, /sign in with Google/);
  assert.match(passwordRefusal("admin", "members")!, /sign in with Google/);
  assert.equal(passwordRefusal("builder", "members"), null);
  assert.equal(passwordRefusal("member", "members"), null);
  assert.match(passwordRefusal("member", "off")!, /off/);
});

test("the ID token's claims: issuer, audience, expiry, nonce, verified email and domain", () => {
  const want = { clientId: CLIENT_ID, nonce: "n1", domain: DOMAIN };
  const ok = { iss: "https://accounts.google.com", aud: CLIENT_ID, exp: now() + 300, iat: now(), nonce: "n1", email: "person-a@example.com", email_verified: true, hd: DOMAIN };
  assert.equal(idTokenProblem(ok, want), null);
  assert.equal(idTokenProblem({ ...ok, iss: "accounts.google.com" }, want), null);
  const cases: [Record<string, unknown>, string][] = [
    [{ iss: "https://accounts.example.com" }, "issuer"],
    [{ aud: "another-client" }, "audience"],
    [{ aud: [CLIENT_ID, "another-client"] }, "audience"], // several audiences need azp = us
    [{ exp: now() - 3600 }, "expired"],
    [{ exp: undefined }, "expired"],
    [{ iat: now() + 3600 }, "issued-in-future"],
    [{ nonce: "n2" }, "nonce"],
    [{ nonce: undefined }, "nonce"],
    [{ email_verified: false }, "email-not-verified"],
    [{ email_verified: "true" }, "email-not-verified"],
    [{ email: undefined }, "no-email"],
    [{ hd: "other.example" }, "domain"],
    [{ hd: undefined }, "domain"],
  ];
  for (const [change, why] of cases) assert.equal(idTokenProblem({ ...ok, ...change }, want), why, JSON.stringify(change));
  assert.equal(idTokenProblem({ ...ok, aud: [CLIENT_ID, "x"], azp: CLIENT_ID }, want), null);
  assert.equal(idTokenProblem({ ...ok, hd: undefined }, { ...want, domain: null }), null, "no domain set: any verified account");
});

// ---------------------------------------------------------------- the real server, a fake Google

let h: Harness;
let owner: Client;
let ownerEmail: string;
let guard: NetworkGuard;
let google: Awaited<ReturnType<typeof fakeServer>>;
const realGoogle = { ...GOOGLE };
// what the fake Google will answer for each code it hands out
const codes = new Map<string, { challenge: string; claims: Record<string, unknown> }>();
const exchanges: { verifierMatched: boolean; secret: string; redirectUri: string }[] = [];
let tokenStatus = 200;

const jwt = (claims: object) => ["{}", JSON.stringify(claims)].map((p) => Buffer.from(p).toString("base64url")).join(".") + ".sig";

before(async () => {
  guard = noOutsideNetwork();
  h = await startApp();
  owner = await setupOwner(h);
  ownerEmail = (await owner.get("/api/me")).json.user.email;
  for (const [email, role] of [
    ["person-a@example.com", "admin"],
    ["person-c@example.com", "member"],
    ["person-e@other.example", "member"],
  ]) {
    assert.equal((await owner.post("/api/users", { email, name: email.split("@")[0], password: "example-password-4", role })).status, 200);
  }
  google = await fakeServer((r) => {
    if (r.method !== "POST" || r.url !== "/token") return { status: 404 };
    const f = new URLSearchParams(String(r.body));
    const entry = codes.get(f.get("code") ?? "");
    codes.delete(f.get("code") ?? ""); // a code works once
    if (!entry) return { status: 400, body: { error: "invalid_grant" } };
    const verifierMatched = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === entry.challenge;
    exchanges.push({ verifierMatched, secret: f.get("client_secret") ?? "", redirectUri: f.get("redirect_uri") ?? "" });
    if (!verifierMatched || f.get("client_id") !== CLIENT_ID || f.get("grant_type") !== "authorization_code") return { status: 400, body: { error: "invalid_grant" } };
    if (tokenStatus !== 200) return { status: tokenStatus, body: { error: "server_error" } };
    return { body: { id_token: jwt(entry.claims), access_token: "example-access-token" } };
  });
  GOOGLE.tokenUrl = `${google.url}/token`;
  // set after the server started, so its origin check still accepts the test client's loopback
  // Origin; the sign-in routes read these at each request
  Object.assign(process.env, env());
});
after(async () => {
  for (const k of Object.keys(env())) delete process.env[k];
  delete process.env.CIRCLECHAT_PASSWORD_SIGNIN;
  Object.assign(GOOGLE, realGoogle);
  await google.close();
  await h.close();
  rmSync(dir, { recursive: true, force: true });
  guard.release();
  assert.deepEqual(guard.attempts, [], "nothing tried to reach the real Google");
});

const cookieOf = (r: Response, name: string) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(name + "="));

/** Start a sign-in, let the fake Google answer with these claims, and return where the callback goes. */
async function signIn(claims: Record<string, unknown> = {}, opts: { state?: string; cookie?: string | null; error?: string; replay?: boolean } = {}) {
  const start = await fetch(`${h.url}/auth/google/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, GOOGLE.authUrl);
  const p = to.searchParams;
  const flowCookie = cookieOf(start, "cc_google_flow")!;
  assert.ok(flowCookie, "the flow's cookie");
  const code = randomBytes(12).toString("base64url");
  codes.set(code, {
    challenge: p.get("code_challenge")!,
    claims: { iss: "https://accounts.google.com", aud: CLIENT_ID, exp: now() + 300, iat: now(), nonce: p.get("nonce"), email: "person-a@example.com", email_verified: true, hd: DOMAIN, ...claims },
  });
  const q = new URLSearchParams(opts.error ? { error: opts.error, state: p.get("state")! } : { code, state: opts.state ?? p.get("state")! });
  const call = () => fetch(`${h.url}/auth/google/callback?${q}`, { redirect: "manual", headers: opts.cookie === null ? {} : { cookie: opts.cookie ?? flowCookie } });
  let r = await call();
  if (opts.replay) r = await call();
  return { params: p, status: r.status, location: r.headers.get("location") ?? "", session: cookieOf(r, "cc_session") };
}
const me = async (session?: string) => (session ? (await fetch(`${h.url}/api/me`, { headers: { cookie: session } })).json() : null) as Promise<any>;
const userCount = async () => (await owner.get("/api/users")).json.users.length;

test("the request to Google: code flow, PKCE S256, state, nonce, the domain, and the public redirect", async () => {
  const start = await fetch(`${h.url}/auth/google/start`, { redirect: "manual" });
  const p = new URL(start.headers.get("location")!).searchParams;
  assert.equal(p.get("client_id"), CLIENT_ID);
  assert.equal(p.get("redirect_uri"), `${PUBLIC}/auth/google/callback`);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "openid email");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("hd"), DOMAIN);
  for (const k of ["state", "nonce", "code_challenge"]) assert.ok((p.get(k) ?? "").length >= 32, k);
  const flow = (start.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("cc_google_flow="))!;
  assert.match(flow, /HttpOnly/i);
  assert.match(flow, /Path=\/auth\/google/);
  assert.match(flow, /SameSite=Lax/i);
});

test("an admin signs in, with PKCE checked and the secret from its file", async () => {
  const r = await signIn();
  assert.equal(r.status, 302);
  assert.equal(r.location, "/");
  const u = (await me(r.session)).user;
  assert.equal(u.email, "person-a@example.com");
  assert.equal(u.role, "admin");
  const x = exchanges.at(-1)!;
  assert.equal(x.verifierMatched, true, "the code verifier matched the challenge");
  assert.equal(x.secret, SECRET, "the secret came from the file");
  assert.equal(x.redirectUri, `${PUBLIC}/auth/google/callback`);
});

test("the owner signs in by the same email", async () => {
  const r = await signIn({ email: ownerEmail.toUpperCase() });
  assert.equal((await me(r.session)).user.role, "owner", "the email matches whatever its case");
});

test("the domain: an exact match only, never a subdomain or a lookalike", () => {
  assert.equal(inDomain("person-a@example.com", DOMAIN), true);
  assert.equal(inDomain("PERSON-A@EXAMPLE.COM", DOMAIN), true);
  for (const email of ["person-a@sub.example.com", "person-a@notexample.com", "person-a@example.com.other.example", "person-a@other.example"])
    assert.equal(inDomain(email, DOMAIN), false, email);
  assert.equal(inDomain("person-a@example.com", null), false, "no domain set: nobody");
});

test("a member in the domain signs in with their own role; outside it, or with no account, refused; nobody is created", async () => {
  const n = await userCount();
  const member = await signIn({ email: "person-c@example.com" });
  assert.equal(member.location, "/");
  const u = (await me(member.session)).user;
  assert.equal(u.email, "person-c@example.com");
  assert.equal(u.role, "member", "signed in as the member they are, nothing more");
  // person-e is a member whose email is outside the domain, such as an alias of a domain account
  for (const email of ["person-e@other.example", "person-d@example.com"]) {
    const r = await signIn({ email });
    assert.equal(r.location, "/?signin=google-no-account", email);
    assert.equal(r.session, undefined, `${email}: no session`);
  }
  assert.equal(await userCount(), n, "no account was created");
});

test("with no domain set, Google matches only owners and admins", async () => {
  delete process.env.CIRCLECHAT_GOOGLE_DOMAIN;
  try {
    assert.equal((await signIn({ email: "person-c@example.com", hd: undefined })).location, "/?signin=google-no-account");
    assert.equal((await me((await signIn({ hd: undefined })).session)).user.role, "admin");
  } finally {
    process.env.CIRCLECHAT_GOOGLE_DOMAIN = DOMAIN;
  }
});

test("each claim check refuses through the real callback", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ email_verified: false }, "email-not-verified"],
    [{ aud: "another-client" }, "audience"],
    [{ iss: "https://accounts.example.com" }, "issuer"],
    [{ exp: now() - 3600 }, "expired"],
    [{ nonce: "not-the-nonce" }, "nonce"],
    [{ hd: "other.example" }, "domain"],
    [{ hd: undefined }, "domain"],
  ];
  for (const [claims, why] of cases) {
    const r = await signIn(claims);
    assert.equal(r.location, `/?signin=google-${why}`, JSON.stringify(claims));
    assert.equal(r.session, undefined);
  }
});

test("a callback that isn't this browser's own flow is refused: wrong state, no flow cookie, a replay, a cancel", async () => {
  assert.equal((await signIn({}, { state: "not-the-state" })).location, "/?signin=google-state");
  assert.equal((await signIn({}, { cookie: null })).location, "/?signin=google-no-flow", "another browser's callback, or a forced sign-in");
  const replay = await signIn({}, { replay: true });
  assert.equal(replay.location, "/?signin=google-no-flow", "each flow works once");
  assert.equal((await signIn({}, { error: "access_denied" })).location, "/?signin=google-cancelled");
});

test("Google's token endpoint failing is a refusal, not a sign-in", async () => {
  tokenStatus = 500;
  try {
    const r = await signIn();
    assert.equal(r.location, "/?signin=google-token-endpoint");
    assert.equal(r.session, undefined);
  } finally {
    tokenStatus = 200;
  }
});

test("passwords: members keeps them for members only; off for everyone; a wrong password says nothing more", async () => {
  const pw = (email: string, password = "example-password-4") => new Client(h.url).post("/api/login", { email, password });
  assert.equal((await pw("person-a@example.com")).status, 200, "all: an admin may still use a password");
  process.env.CIRCLECHAT_PASSWORD_SIGNIN = "members";
  try {
    const admin = await pw("person-a@example.com");
    assert.equal(admin.status, 403);
    assert.match(admin.json.error, /Owners and admins sign in with Google/);
    assert.equal((await pw("person-a@example.com", "wrong-password")).status, 401, "a wrong password doesn't reveal the role");
    assert.equal((await pw("person-c@example.com")).status, 200, "a member still signs in with a password");
    const state = (await new Client(h.url).get("/api/state")).json;
    assert.equal(state.google, true);
    assert.equal(state.passwordSignIn, "members");
    process.env.CIRCLECHAT_PASSWORD_SIGNIN = "off";
    assert.equal((await pw("person-c@example.com")).status, 403, "off: nobody signs in with a password");
    assert.ok((await me((await signIn()).session)).user, "Google still works");
    assert.equal((await me((await signIn({ email: "person-c@example.com" })).session)).user.role, "member", "for a member in the domain too");
  } finally {
    delete process.env.CIRCLECHAT_PASSWORD_SIGNIN;
  }
});

test("with Google off, its routes don't exist", async () => {
  delete process.env.CIRCLECHAT_GOOGLE_CLIENT_ID;
  try {
    assert.equal((await fetch(`${h.url}/auth/google/start`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${h.url}/auth/google/callback?code=x&state=y`, { redirect: "manual" })).status, 404);
    assert.equal((await new Client(h.url).get("/api/state")).json.google, false);
  } finally {
    process.env.CIRCLECHAT_GOOGLE_CLIENT_ID = CLIENT_ID;
  }
});
