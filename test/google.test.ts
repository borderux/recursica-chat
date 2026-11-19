// SPDX-License-Identifier: AGPL-3.0-only
// Sign in with Google, against a fake Google: the code flow with PKCE, state and nonce; every claim
// check; matching only an existing owner or admin, or anyone in the domain, never creating anyone;
// the client secret from a file; CIRCLECHAT_PASSWORD_SIGNIN; and the copy of the Google photo (from
// a fake photo host). Nothing in this file may reach the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOGLE, googleConfig, passwordSignIn, passwordRefusal, idTokenProblem, readClientSecret, inDomain } from "../server/src/google.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PHOTO, photoUrl } from "../server/src/profile.ts";
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
  assert.equal(p.get("scope"), "openid email profile");
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

test("a deactivated person is refused, with no session, and signs in again once reactivated", async () => {
  const id = (await owner.get("/api/users")).json.users.find((u: any) => u.email === "person-a@example.com").id;
  assert.equal((await owner.post(`/api/users/${id}/deactivate`, {})).status, 200);
  try {
    const r = await signIn();
    assert.equal(r.status, 302);
    assert.equal(r.location, "/?signin=google-deactivated");
    assert.equal(r.session, undefined, "no session cookie");
  } finally {
    assert.equal((await owner.post(`/api/users/${id}/reactivate`, {})).status, 200);
  }
  const again = await signIn();
  assert.equal(again.location, "/");
  assert.equal((await me(again.session)).user.email, "person-a@example.com");
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

// ---------------------------------------------------------------- the Google photo

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(200, 3)]);

/** A fake photo host: each path answers one way. Records the paths asked for. */
async function photoHost() {
  const asked: string[] = [];
  const send = (res: any, type: string, body: Buffer | string, extra: Record<string, string> = {}) => res.writeHead(200, { "content-type": type, ...extra }).end(body);
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    asked.push(path);
    if (path === "/a/jpeg=s256-c") return send(res, "image/jpeg", JPEG);
    if (path === "/a/png=s256-c") return send(res, "image/png", PNG);
    if (path === "/a/webp=s256-c") return send(res, "image/webp", WEBP);
    if (path === "/a/jpeg-as-text=s256-c") return send(res, "text/html", JPEG); // the bytes decide, not the header
    if (path === "/a/svg=s256-c") return send(res, "image/jpeg", '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    if (path === "/a/html=s256-c") return send(res, "image/png", "<html><script>1</script></html>");
    if (path === "/a/gif=s256-c") return send(res, "image/gif", Buffer.from("GIF89a" + "x".repeat(100)));
    if (path === "/a/big=s256-c") return send(res, "image/jpeg", Buffer.concat([JPEG, Buffer.alloc(PHOTO.maxBytes)]));
    if (path === "/a/big-unsized=s256-c") {
      // no content-length: the size is only known by reading
      res.writeHead(200, { "content-type": "image/jpeg", "transfer-encoding": "chunked" });
      res.write(JPEG);
      for (let i = 0; i < 40; i++) res.write(Buffer.alloc(8 * 1024));
      return res.end();
    }
    if (path === "/a/redirect=s256-c") return res.writeHead(302, { location: "/a/png=s256-c" }).end(); // a PNG, so following it would show
    if (path === "/a/missing=s256-c") return res.writeHead(404).end();
    if (path === "/a/slow=s256-c") return void setTimeout(() => send(res, "image/png", PNG), 2000);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { host, base: `http://${host}`, asked, close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

test("the Google photo: fetched at sign-in from the photo host only, checked, stored, and served by us", async () => {
  const host = await photoHost();
  const realPhoto = { ...PHOTO };
  Object.assign(PHOTO, { protocol: "http:", host: host.host, timeoutMs: 500 });
  try {
    const adminId = (await owner.get("/api/users")).json.users.find((u: any) => u.email === "person-a@example.com").id;
    const photo = (session?: string, extra: Record<string, string> = {}) => fetch(`${h.url}/api/people/${adminId}/photo`, { headers: { ...(session ? { cookie: session } : {}), ...extra } });
    const version = async (session: string) => (await (await fetch(`${h.url}/api/profiles`, { headers: { cookie: session } })).json()).profiles[adminId];
    const sign = async (picture?: string) => {
      const r = await signIn(picture === undefined ? {} : { picture });
      assert.equal(r.location, "/", `signed in (${picture})`);
      assert.ok(r.session, "a photo never stops a sign-in");
      return r.session!;
    };

    // a JPEG, asked for at 256 pixels, kept, and served with safe headers
    let s = await sign(`${host.base}/a/jpeg=s96-c`);
    assert.ok(host.asked.includes("/a/jpeg=s256-c"), "asked for 256 pixels");
    let r = await photo(s);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.match(r.headers.get("cache-control") ?? "", /^private/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
    const etag = r.headers.get("etag")!;
    assert.equal((await photo(s, { "if-none-match": etag })).status, 304);
    const v1 = await version(s);
    assert.ok(v1.photo, "the profile has a photo version");
    assert.equal(v1.usePhoto, true);

    // PNG and WebP too; the type comes from the bytes, never from the host's header
    for (const [path, type] of [["png", "image/png"], ["webp", "image/webp"], ["jpeg-as-text", "image/jpeg"]]) {
      s = await sign(`${host.base}/a/${path}=s96-c`);
      assert.equal((await photo(s)).headers.get("content-type"), type, path);
    }
    s = await sign(`${host.base}/a/jpeg=s96-c`);
    const kept = Buffer.from(await (await photo(s)).arrayBuffer());

    // refused, and the previous copy stays: not an image, too large, a redirect, an error, too slow
    for (const path of ["svg", "html", "gif", "big", "big-unsized", "redirect", "missing", "slow"]) {
      const before = Date.now();
      s = await sign(`${host.base}/a/${path}=s96-c`);
      assert.ok(Date.now() - before < 1800, `${path}: the sign-in waited at most the time limit`);
      assert.deepEqual(Buffer.from(await (await photo(s)).arrayBuffer()), kept, `${path}: the previous copy stays`);
    }

    // refused before any request: another host (even this same machine under another name), the
    // real Google host (not this test's), another protocol, or a user name in the address
    assert.equal(photoUrl(`${host.base}/a/jpeg=s96-c`)?.href, `${host.base}/a/jpeg=s256-c`);
    for (const picture of [
      `http://localhost:${host.host.split(":")[1]}/a/jpeg=s96-c`,
      `https://${host.host}/a/jpeg=s96-c`,
      `http://user:secret@${host.host}/a/jpeg=s96-c`,
      `http://user@${host.host}/a/jpeg=s96-c`,
    ])
      assert.equal(photoUrl(picture), null, picture);
    const n = host.asked.length;
    for (const picture of [
      `http://localhost:${host.host.split(":")[1]}/a/jpeg=s96-c`,
      "https://evil.example/a/jpeg=s96-c",
      "https://lh3.googleusercontent.com.evil.example/a/jpeg=s96-c",
      `https://${host.host}/a/jpeg=s96-c`,
      `http://user:secret@${host.host}/a/jpeg=s96-c`,
      "javascript:alert(1)",
      "not a url",
    ]) {
      s = await sign(picture);
      assert.deepEqual(Buffer.from(await (await photo(s)).arrayBuffer()), kept, picture);
    }
    assert.equal(host.asked.length, n, "nothing was fetched for those");
    assert.deepEqual(guard.attempts, [], "nothing tried to leave the machine");

    // turned off: hidden, even after the next sign-in; then back on
    assert.equal((await new Client(h.url).put("/api/me/photo", { use: false })).status, 401);
    const put = (use: unknown) => fetch(`${h.url}/api/me/photo`, { method: "PUT", headers: { cookie: s, "content-type": "application/json", origin: h.url }, body: JSON.stringify({ use }) });
    assert.equal((await put("no")).status, 400);
    assert.equal((await put(false)).status, 200);
    assert.equal((await photo(s)).status, 404);
    assert.equal((await version(s)).photo, null);
    assert.equal((await version(s)).hasPhoto, true, "you still see that a copy exists");
    s = await sign(`${host.base}/a/png=s96-c`);
    assert.equal((await photo(s)).status, 404, "still off after a sign-in");
    assert.equal((await put(true)).status, 200);
    assert.equal((await photo(s)).headers.get("content-type"), "image/png");

    // no picture at sign-in: the copy is removed
    s = await sign();
    assert.equal((await photo(s)).status, 404);
    assert.equal((await version(s)).photo, null);
    assert.equal((await version(s)).hasPhoto, false);

    // without a session, no photo
    s = await sign(`${host.base}/a/jpeg=s96-c`);
    assert.equal((await photo()).status, 401);
  } finally {
    Object.assign(PHOTO, realPhoto);
    await host.close();
  }
});

test("a photo goes with its account", () => {
  const db = h.app.db;
  db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES('u_photo', 'person-p@example.com', 'P', 'x', 'member', 0)").run();
  db.prepare("INSERT INTO user_photos(user_id, type, bytes, sha256) VALUES('u_photo', 'image/jpeg', ?, 'x')").run(JPEG);
  db.prepare("DELETE FROM users WHERE id = 'u_photo'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_photos WHERE user_id = 'u_photo'").get() as any).n, 0);
});
