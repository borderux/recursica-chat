// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts session / end-sessions (server/src/clisession.ts): a short session for a member account,
// made by root on the server, for a check that drives the API while password sign-in is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { startApp, setupOwner } from "./helpers.ts";
import { asDataOwner, sessionArgs, memberSession, endSessions, SESSION_MAX_MINUTES } from "../server/src/clisession.ts";

const people = async (c: any) => {
  for (const [email, role] of [
    ["person-a@example.com", "member"],
    ["person-b@example.com", "builder"],
    ["person-c@example.com", "admin"],
  ])
    assert.equal((await c.post("/api/users", { email, name: email.split("@")[0], role })).status, 200);
};
const me = (url: string, t: string) => fetch(url + "/api/me", { headers: { authorization: `Bearer ${t}` } });

test("cli session: only root, then as the data folder's owner", () => {
  const calls: string[] = [];
  const proc = (uid: number) => ({ getuid: () => uid, setgid: (g: number) => calls.push(`gid ${g}`), setuid: (u: number) => calls.push(`uid ${u}`) });
  const dir = import.meta.dirname;
  const st = statSync(dir);

  assert.match(asDataOwner(dir, proc(501)) ?? "", /only root/);
  assert.match(asDataOwner(dir, {}) ?? "", /only root/, "no uid at all (Windows) is refused");
  assert.deepEqual(calls, [], "a refusal changes no ids");

  assert.match(asDataOwner(join(dir, "no-such-folder"), proc(0)) ?? "", /no data folder/);
  assert.equal(asDataOwner(dir, proc(0)), null);
  if (st.uid !== 0) assert.deepEqual(calls, [`gid ${st.gid}`, `uid ${st.uid}`], "the group first: after setuid, setgid would be refused");
});

test("cli session: the arguments", () => {
  assert.deepEqual(sessionArgs(["Person-A@Example.com"]), { email: "person-a@example.com", minutes: SESSION_MAX_MINUTES });
  assert.equal(SESSION_MAX_MINUTES, 60);
  assert.deepEqual(sessionArgs(["person-a@example.com", "--minutes", "5"]), { email: "person-a@example.com", minutes: 5 });
  assert.deepEqual(sessionArgs(["person-a@example.com", "--minutes", "60"]).minutes, 60);
  for (const bad of [
    [],
    ["--minutes", "5"],
    ["person-a@example.com", "--minutes"],
    ["person-a@example.com", "--minutes", "0"],
    ["person-a@example.com", "--minutes", "61"],
    ["person-a@example.com", "--minutes", "1440"],
    ["person-a@example.com", "--minutes", "5.5"],
    ["person-a@example.com", "--minutes", "-5"],
    ["person-a@example.com", "--hours", "1"],
    ["person-a@example.com", "--minutes", "5", "extra"],
  ])
    assert.throws(() => sessionArgs(bad), Error, JSON.stringify(bad));
});

test("cli session: a member or builder gets a working session of at most an hour; owners and admins never", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    await people(owner);
    const db = h.app.db;
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n as number;

    const before = Date.now();
    const s = memberSession(db, "Person-A@example.com", 5);
    assert.match(s.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(s.expiresAt >= before + 5 * 60_000 && s.expiresAt <= Date.now() + 5 * 60_000);
    const r = await me(h.url, s.token);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).user.email, "person-a@example.com");
    const cookie = await fetch(h.url + "/api/me", { headers: { cookie: `cc_session=${s.token}` } });
    assert.equal(cookie.status, 200, "the token also works as the session cookie");

    const hour = memberSession(db, "person-a@example.com");
    assert.ok(hour.expiresAt <= Date.now() + 60 * 60_000, "the default is the most: an hour");
    assert.equal((await me(h.url, memberSession(db, "person-b@example.com", 1).token)).status, 200, "a builder too");

    const n = count();
    for (const email of ["tash@lumen.test", "person-c@example.com"]) assert.throws(() => memberSession(db, email), /is an (owner|admin)/);
    assert.throws(() => memberSession(db, "nobody@example.com"), /no user/);
    for (const m of [0, 61, 1.5, NaN]) assert.throws(() => memberSession(db, "person-a@example.com", m), /minutes/);
    assert.equal(count(), n, "a refusal makes no session");

    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, s.token);
    assert.equal((await me(h.url, s.token)).status, 401, "an ended session lets nobody in");
  } finally {
    await h.close();
  }
});

test("cli end-sessions: signs a member out everywhere, and nobody else", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    await people(owner);
    const db = h.app.db;
    const a1 = memberSession(db, "person-a@example.com").token;
    const a2 = memberSession(db, "person-a@example.com").token;
    const b = memberSession(db, "person-b@example.com").token;
    assert.equal(endSessions(db, "PERSON-A@example.com"), 2);
    assert.equal((await me(h.url, a1)).status, 401);
    assert.equal((await me(h.url, a2)).status, 401);
    assert.equal((await me(h.url, b)).status, 200, "another account keeps its session");
    assert.equal((await owner.get("/api/me")).status, 200, "the owner keeps theirs");
    assert.throws(() => endSessions(db, "tash@lumen.test"), /is an owner/);
    assert.throws(() => endSessions(db, "person-c@example.com"), /is an admin/);
    assert.equal((await owner.get("/api/me")).status, 200);
  } finally {
    await h.close();
  }
});

test(
  "cli session: refused for anyone but root, with nothing on stdout and no session made",
  { skip: process.getuid?.() === 0 ? "running as root" : false },
  async () => {
    const h = await startApp();
    try {
      const owner = await setupOwner(h);
      await people(owner);
      const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
      const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
      const n = (h.app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n;
      for (const args of [
        ["session", "person-a@example.com"],
        ["end-sessions", "person-a@example.com"],
      ]) {
        const r = spawnSync("node", [cli, ...args], { env, encoding: "utf8" });
        assert.equal(r.status, 2, args[0]);
        assert.equal(r.stdout, "", "no token");
        assert.match(r.stderr, /only root may run this: use sudo/);
      }
      assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n, n);
    } finally {
      await h.close();
    }
  },
);
