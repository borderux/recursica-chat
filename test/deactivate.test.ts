// SPDX-License-Identifier: AGPL-3.0-only
// Deactivated people (server/src/deactivate.ts): an admin turns a person off and on again. Each way
// in is refused while the person is off: a session they already hold, by cookie or Bearer token, a
// live connection, a password, and a session from the server's CLI. Google sign-in is checked in
// google.test.ts. Their messages stay, attributed to them.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, setupOwner, Client, waitFor } from "./helpers.ts";
import { memberSession } from "../server/src/clisession.ts";
import { isDeactivated } from "../server/src/deactivate.ts";

const PASSWORD = "example-password-1";

async function setup() {
  const h = await startApp();
  const owner = await setupOwner(h);
  for (const [email, role] of [
    ["person-a@example.com", "member"],
    ["person-b@example.com", "admin"],
    ["person-c@example.com", "builder"],
  ])
    assert.equal((await owner.post("/api/users", { email, name: email.split("@")[0], password: PASSWORD, role })).status, 200);
  const users = (await owner.get("/api/users")).json.users as any[];
  const idOf = (email: string) => users.find((u) => u.email === email).id;
  const signIn = async (email: string) => {
    const c = new Client(h.url);
    const r = await c.post("/api/login", { email, password: PASSWORD });
    return { c, r };
  };
  return { h, owner, idOf, signIn };
}

test("deactivating ends the person's sessions at once, by cookie and by Bearer token, and closes their live connection", async () => {
  const { h, owner, idOf, signIn } = await setup();
  try {
    const { c: person } = await signIn("person-a@example.com");
    const bearer = memberSession(h.app.db, "person-a@example.com", 5).token;
    assert.equal((await person.get("/api/me")).status, 200);
    const ws = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: person.cookie } });
    await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
    // bounded, so a connection left open fails the test instead of hanging it
    const closed = new Promise<number>((r) => (ws.on("close", (code) => r(code)), setTimeout(() => r(-1), 5_000).unref()));

    const r = await owner.post(`/api/users/${idOf("person-a@example.com")}/deactivate`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sessionsEnded, 2);
    assert.equal(await closed, 4003, "the live connection closes");
    assert.equal((await person.get("/api/me")).status, 401, "the cookie session ended");
    assert.equal((await fetch(`${h.url}/api/me`, { headers: { authorization: `Bearer ${bearer}` } })).status, 401, "the Bearer session ended");

    // a session that somehow remains (written straight into the table) lets them in nowhere either
    h.app.db
      .prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)")
      .run("left-over-token-0123456789", idOf("person-a@example.com"), Date.now() + 60_000);
    assert.equal((await fetch(`${h.url}/api/me`, { headers: { authorization: "Bearer left-over-token-0123456789" } })).status, 401);
    const again = new WebSocket(h.url.replace("http", "ws") + "/ws", { headers: { origin: h.url, cookie: "cc_session=left-over-token-0123456789" } });
    await new Promise((r) => (again.on("error", r), again.on("close", r)));
    assert.notEqual(again.readyState, WebSocket.OPEN, "no new live connection");
  } finally {
    await h.close();
  }
});

test("a deactivated person can't sign in by password or get a CLI session; a reactivated one can again", async () => {
  const { h, owner, idOf, signIn } = await setup();
  try {
    const id = idOf("person-a@example.com");
    await owner.post(`/api/users/${id}/deactivate`, {});
    const pw = await signIn("person-a@example.com");
    assert.equal(pw.r.status, 403);
    assert.match(pw.r.json.error, /This account is deactivated/);
    assert.equal(pw.c.cookie, "", "no session cookie");
    assert.equal(
      (await new Client(h.url).post("/api/login", { email: "person-a@example.com", password: "wrong" })).status,
      401,
      "a wrong password still says only that",
    );
    assert.throws(() => memberSession(h.app.db, "person-a@example.com", 5), /is deactivated: no session/);
    const n = (h.app.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id) as any).n;
    assert.equal(n, 0, "no refused way in made a session");

    assert.equal((await owner.post(`/api/users/${id}/reactivate`, {})).status, 200);
    assert.equal(isDeactivated(h.app.db, id), false);
    assert.equal((await signIn("person-a@example.com")).r.status, 200);
    assert.ok(memberSession(h.app.db, "person-a@example.com", 5).token);
  } finally {
    await h.close();
  }
});

test("their messages stay, attributed to them, and the people list shows them as deactivated", async () => {
  const { h, owner, idOf, signIn } = await setup();
  try {
    const id = idOf("person-a@example.com");
    const chat = (await owner.post("/api/chats", { name: "Room", users: [id] })).json.chat;
    const { c: person } = await signIn("person-a@example.com");
    const sent = await person.post(`/api/chats/${chat.id}/messages`, { body: "written before" });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));

    await owner.post(`/api/users/${id}/deactivate`, {});
    const msgs = (await owner.get(`/api/chats/${chat.id}/messages`)).json.messages as any[];
    const m = msgs.find((x) => x.body === "written before");
    assert.equal(m.authorType, "user");
    assert.equal(m.authorId, id, "still attributed to them");
    const listed = (await owner.get("/api/users")).json.users.find((u: any) => u.id === id);
    assert.equal(listed.deactivated, true);
    assert.equal(listed.email, "person-a@example.com", "still listed, with their details");
    assert.equal((await owner.get("/api/users")).json.users.filter((u: any) => u.deactivated).length, 1);
  } finally {
    await h.close();
  }
});

test("only an admin deactivates or reactivates; never the owner, and never themselves", async () => {
  const { h, owner, idOf, signIn } = await setup();
  try {
    const ownerId = (await owner.get("/api/me")).json.user.id;
    const { c: admin } = await signIn("person-b@example.com");
    const { c: builder } = await signIn("person-c@example.com");
    const { c: member } = await signIn("person-a@example.com");
    for (const c of [builder, member]) {
      assert.equal((await c.post(`/api/users/${idOf("person-a@example.com")}/deactivate`, {})).status, 403);
      assert.equal((await c.post(`/api/users/${idOf("person-a@example.com")}/reactivate`, {})).status, 403);
    }
    const ownerTry = await admin.post(`/api/users/${ownerId}/deactivate`, {});
    assert.equal(ownerTry.status, 403);
    assert.match(ownerTry.json.error, /owner can't be deactivated/);
    assert.equal((await owner.post(`/api/users/${ownerId}/deactivate`, {})).status, 403, "not even by the owner");
    assert.equal((await admin.post(`/api/users/${idOf("person-b@example.com")}/deactivate`, {})).status, 400, "not yourself");
    assert.equal((await admin.post(`/api/users/u_nobody/deactivate`, {})).status, 404);
    assert.equal((await admin.post(`/api/users/${idOf("person-c@example.com")}/deactivate`, {})).status, 200, "an admin may deactivate a builder");
    assert.equal((await builder.get("/api/me")).status, 401);
    await waitFor(() => isDeactivated(h.app.db, idOf("person-c@example.com")), "deactivated");
  } finally {
    await h.close();
  }
});
