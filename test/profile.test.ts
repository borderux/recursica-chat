// SPDX-License-Identifier: AGPL-3.0-only
// Your own profile: anyone changes their own full name through PATCH /api/me, their own avatar
// color through PUT /api/me/look, and their own username through PUT /api/me/handle, and nothing
// else about themselves or anyone else. Usernames: defaults, rules, unique across people and agents
// (in the API and in the database), and how agents see people. And @mentions of a person.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TONES } from "../server/src/profile.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mentionsIn, mentionsMe } from "../web/src/mentions.ts";
import { startApp, setupOwner, mockAgent, Client, type Harness } from "./helpers.ts";

let h: Harness;
let owner: Client;
let member: Client;
let memberId: string;

before(async () => {
  h = await startApp();
  owner = await setupOwner(h);
  const r = await owner.post("/api/users", { email: "person-c@example.com", name: "person-c", password: "example-password-4", role: "member" });
  assert.equal(r.status, 200);
  member = new Client(h.url);
  assert.equal((await member.post("/api/login", { email: "person-c@example.com", password: "example-password-4" })).status, 200);
  memberId = (await member.get("/api/me")).json.user.id;
});
after(async () => {
  await h.close();
});

const nameOf = async (c: Client, id: string) => (await c.get("/api/users")).json.users.find((u: any) => u.id === id)?.name;

test("a member changes their own display name, and everyone sees it", async () => {
  const r = await member.patch("/api/me", { name: "  Person C  " });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, "Person C", "trimmed");
  assert.equal((await member.get("/api/me")).json.user.name, "Person C");
  assert.equal(await nameOf(owner, memberId), "Person C", "the owner sees the new name");
});

test("a name is at most 60 characters; an empty name, or only spaces, changes nothing", async () => {
  assert.equal((await member.patch("/api/me", { name: "x".repeat(80) })).json.user.name, "x".repeat(60));
  for (const name of ["", "   ", null]) {
    const r = await member.patch("/api/me", { name });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.name, "x".repeat(60), JSON.stringify(name));
  }
});

test("the profile changes only your name: not your email, your role, or anyone else", async () => {
  const ownerBefore = (await owner.get("/api/me")).json.user;
  const r = await member.patch("/api/me", { name: "Person C", email: "person-x@example.com", role: "owner", id: ownerBefore.id });
  assert.equal(r.status, 200);
  const u = (await member.get("/api/me")).json.user;
  assert.equal(u.id, memberId);
  assert.equal(u.email, "person-c@example.com");
  assert.equal(u.role, "member");
  const ownerAfter = (await owner.get("/api/me")).json.user;
  assert.deepEqual(ownerAfter, ownerBefore, "the owner is untouched");
});

test("without a session, nobody changes a name", async () => {
  const r = await new Client(h.url).patch("/api/me", { name: "Someone" });
  assert.equal(r.status, 401);
  assert.equal(await nameOf(owner, memberId), "Person C");
});

// ---------------------------------------------------------------- avatar color

// the colors people chose, from GET /api/profiles
const looks = async (c: Client) =>
  Object.fromEntries(
    Object.entries((await c.get("/api/profiles")).json.profiles as Record<string, any>)
      .filter(([, p]) => p.tone)
      .map(([id, p]) => [id, p.tone]),
  );

test("a member chooses their own avatar color, and everyone sees it; null goes back to automatic", async () => {
  assert.deepEqual(await looks(owner), {}, "nobody has chosen yet");
  const r = await member.put("/api/me/look", { tone: "mint" });
  assert.equal(r.status, 200);
  assert.deepEqual(await looks(owner), { [memberId]: "mint" }, "the owner sees it");
  assert.equal((await member.put("/api/me/look", { tone: "slate" })).status, 200);
  assert.deepEqual(await looks(member), { [memberId]: "slate" }, "a second choice replaces the first");
  assert.equal((await member.put("/api/me/look", { tone: null })).status, 200);
  assert.deepEqual(await looks(owner), {});
});

test("only a color from the list: anything else is refused and changes nothing", async () => {
  assert.equal((await member.put("/api/me/look", { tone: "sky" })).status, 200);
  for (const tone of ["red", "#ff0000", "sky; background: url(https://x.example/)", "SKY", "", 5, true, ["sky"], { tone: "sky" }]) {
    const r = await member.put("/api/me/look", { tone });
    assert.equal(r.status, 400, JSON.stringify(tone));
    assert.match(r.json.error, /tone must be one of/);
  }
  assert.deepEqual(await looks(owner), { [memberId]: "sky" }, "still sky");
});

test("you change only your own color, never someone else's", async () => {
  const ownerId = (await owner.get("/api/me")).json.user.id;
  assert.equal((await member.put("/api/me/look", { tone: "rose", user_id: ownerId, userId: ownerId, id: ownerId })).status, 200);
  const l = await looks(owner);
  assert.equal(l[memberId], "rose");
  assert.equal(l[ownerId], undefined, "the owner's color is untouched");
});

test("without a session, nobody reads or changes colors", async () => {
  const c = new Client(h.url);
  assert.equal((await c.get("/api/profiles")).status, 401);
  assert.equal((await c.put("/api/me/look", { tone: "sand" })).status, 401);
});

test("a color goes with its account", async () => {
  const db = h.app.db;
  db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES('u_gone', 'person-g@example.com', 'person-g', 'x', 'member', 0)").run();
  db.prepare("INSERT INTO user_looks(user_id, tone) VALUES('u_gone', 'peach')").run();
  db.prepare("DELETE FROM users WHERE id = 'u_gone'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_looks WHERE user_id = 'u_gone'").get() as any).n, 0);
});

test("the web app offers exactly the server's colors", () => {
  const ui = readFileSync(new URL("../web/src/ui/ui.tsx", import.meta.url), "utf8");
  const block = ui.slice(ui.indexOf("export const NAMED_TONES"), ui.indexOf("};", ui.indexOf("export const NAMED_TONES")));
  const names = [...block.matchAll(/^\s+([a-z]+): /gm)].map((m) => m[1]);
  assert.deepEqual(names, [...TONES]);
});

// ---------------------------------------------------------------- usernames

const profiles = async (c: Client = owner) => (await c.get("/api/profiles")).json.profiles as Record<string, { handle: string }>;
const handleOf = async (id: string) => (await profiles())[id]?.handle;
const idOf = async (c: Client) => (await c.get("/api/me")).json.user.id as string;
const addPerson = async (email: string) => {
  const r = await owner.post("/api/users", { email, name: "Example Person", password: "example-password-4", role: "member" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.user?.id ?? (await owner.get("/api/users")).json.users.find((u: any) => u.email === email).id;
};

test("usernames default to the email's part before the @, made valid and unique", async () => {
  assert.equal(await handleOf(await idOf(owner)), "tash", "the owner, who existed before");
  assert.equal(await handleOf(memberId), "person-c");
  await mockAgent(owner, "designer");
  const cases: [string, string][] = [
    ["first.last@example.com", "firstlast"],
    ["9lives@example.com", "u9lives"],
    ["x@example.com", "xuser"],
    ["all@example.com", "all-2"], // reserved for mentioning every agent
    ["designer@example.com", "designer-2"], // an agent's handle
    ["person-c@other.example", "person-c-2"], // another person's
    ["Person-C@third.example", "person-c-3"],
  ];
  for (const [email, want] of cases) assert.equal(await handleOf(await addPerson(email)), want, email);
});

test("you change your own username; the rules and reserved words hold; nobody else's changes", async () => {
  const ownerId = await idOf(owner);
  const r = await member.put("/api/me/handle", { handle: "@Person-C2", userId: ownerId, user_id: ownerId, id: ownerId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.handle, "person-c2");
  assert.equal(await handleOf(memberId), "person-c2");
  assert.equal(await handleOf(ownerId), "tash", "the owner's is untouched");
  for (const handle of ["1abc", "a", "has space", "x".repeat(31), "dots.not-ok", "", "émile"]) {
    assert.equal((await member.put("/api/me/handle", { handle })).status, 400, handle);
  }
  assert.match((await member.put("/api/me/handle", { handle: "everyone" })).json.error, /kept for mentioning every agent/);
  for (const handle of ["designer", "tash"]) {
    const t = await member.put("/api/me/handle", { handle });
    assert.equal(t.status, 400, handle);
    assert.match(t.json.error, new RegExp(`@${handle} is taken`));
  }
  assert.equal((await member.put("/api/me/handle", { handle: "person-c2" })).status, 200, "keeping your own is fine");
  assert.equal(await handleOf(memberId), "person-c2");
  assert.equal((await new Client(h.url).put("/api/me/handle", { handle: "someone" })).status, 401);
});

test("an agent can't take a person's username: create, rename or import", async () => {
  const created = await owner.post("/api/agents", { name: "Tash", handle: "tash", engine: "mock", sandbox: "local" });
  assert.equal(created.status, 400);
  assert.match(created.json.error, /@tash is taken/);
  const a = await mockAgent(owner, "reviewer");
  const renamed = await owner.patch(`/api/agents/${a.id}`, { handle: "person-c2" });
  assert.equal(renamed.status, 400);
  assert.match(renamed.json.error, /@person-c2 is taken/);
  const dir = join(h.dir, "import-person-handle");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), "# Example\nYou help.");
  const imported = await owner.post("/api/agents/import", { path: dir, engine: "mock", sandbox: "local", handle: "tash" });
  assert.equal(imported.status, 400, JSON.stringify(imported.json));
  assert.match(imported.json.error, /@tash is taken/);
});

test("the database itself refuses a handle a person and an agent would share", () => {
  const db = h.app.db;
  assert.throws(
    () => db.prepare("INSERT INTO agents(id, handle, name, engine, created_at) VALUES('a_x', 'tash', 'X', 'mock', 0)").run(),
    /a person's username/,
  );
  assert.throws(() => db.prepare("UPDATE agents SET handle = 'tash' WHERE handle = 'designer'").run(), /a person's username/);
  assert.throws(() => db.prepare("UPDATE user_handles SET handle = 'designer' WHERE handle = 'tash'").run(), /an agent's handle/);
  db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES('u_y', 'person-y@example.com', 'Y', 'x', 'member', 0)").run();
  assert.throws(() => db.prepare("INSERT INTO user_handles(user_id, handle) VALUES('u_y', 'designer')").run(), /an agent's handle/);
  db.prepare("DELETE FROM users WHERE id = 'u_y'").run();
});

test("agents see people as @username", async () => {
  const g = h.app.gateway as any;
  assert.equal(g.authorName("user", memberId), "@person-c2");
  assert.equal(g.authorName("user", await idOf(owner)), "@tash");
  assert.equal(g.authorName("user", "u_nobody"), "someone");
});

test("a username goes with its account", () => {
  const db = h.app.db;
  db.prepare("INSERT INTO users(id, email, name, pass_hash, role, created_at) VALUES('u_gone2', 'person-h@example.com', 'H', 'x', 'member', 0)").run();
  db.prepare("INSERT INTO user_handles(user_id, handle) VALUES('u_gone2', 'person-h')").run();
  db.prepare("DELETE FROM users WHERE id = 'u_gone2'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_handles WHERE user_id = 'u_gone2'").get() as any).n, 0);
});

// ---------------------------------------------------------------- @mentions of a person

test("a mention notifies the person it names, and only for someone else's message", () => {
  const me = { id: "u_me", handle: "person-c2" };
  const from = (body: string, authorType = "user", authorId = "u_other") => mentionsMe({ body, authorType, authorId }, me);
  assert.deepEqual(mentionsIn("hi @Person-C2 and @designer, @designer"), ["person-c2", "designer"]);
  assert.equal(from("@person-c2 can you look?"), true);
  assert.equal(from("thanks @Person-C2!"), true, "any case");
  assert.equal(from("over to @person-c2", "agent", "a_1"), true, "an agent's mention too");
  assert.equal(from("@person-c2 note to self", "user", "u_me"), false, "not your own message");
  assert.equal(from("@person-c22 is someone else"), false);
  assert.equal(from("write to person-c2@example.com"), false, "an email address isn't a mention");
  assert.equal(from("write to mail@person-c2.example"), false, "nor is a domain after an @ inside a word");
  assert.equal(mentionsMe({ body: "@person-c2", authorType: "user", authorId: "u_other" }, { id: "u_me", handle: null }), false);
});
