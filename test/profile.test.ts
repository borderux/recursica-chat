// SPDX-License-Identifier: AGPL-3.0-only
// Your own profile: anyone changes their own display name through PATCH /api/me, and their own
// avatar color through PUT /api/me/look, and nothing else about themselves or anyone else.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TONES } from "../server/src/profile.ts";
import { startApp, setupOwner, Client, type Harness } from "./helpers.ts";

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

const looks = async (c: Client) => (await c.get("/api/looks")).json.looks;

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
  assert.equal((await c.get("/api/looks")).status, 401);
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
