// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts delete-person (server/src/deleteperson.ts): root deletes a deactivated account that has no
// work, with its sessions, username, look, photo, deactivated record, chat memberships and read
// marks, in one transaction. The owner, admins, an active account and any account with work are
// refused, and nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startApp, setupOwner, Client } from "./helpers.ts";
import { deletePerson } from "../server/src/deleteperson.ts";

const PASSWORD = "example-password-1";

async function setup() {
  const h = await startApp();
  const owner = await setupOwner(h);
  for (const [email, role] of [
    ["person-a@example.com", "member"],
    ["person-b@example.com", "admin"],
    ["person-c@example.com", "member"],
  ])
    assert.equal((await owner.post("/api/users", { email, name: email.split("@")[0], password: PASSWORD, role })).status, 200);
  const users = (await owner.get("/api/users")).json.users as any[];
  const idOf = (email: string) => users.find((u) => u.email === email).id;
  const signIn = async (email: string) => {
    const c = new Client(h.url);
    assert.equal((await c.post("/api/login", { email, password: PASSWORD })).status, 200);
    return c;
  };
  const deactivate = async (email: string) => assert.equal((await owner.post(`/api/users/${idOf(email)}/deactivate`, {})).status, 200);
  return { h, owner, idOf, signIn, deactivate };
}
const rows = (db: any, sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as any).n);

test("an account that never took part: deleted with its sessions, username, look, photo, deactivated record, memberships and read marks", async () => {
  const { h, owner, idOf, signIn, deactivate } = await setup();
  try {
    const db = h.app.db;
    const id = idOf("person-a@example.com");
    const a = await signIn("person-a@example.com");
    assert.equal((await a.put("/api/me/handle", { handle: "example-program" })).status, 200);
    assert.equal((await a.put("/api/me/look", { tone: "sky" })).status, 200);
    db.prepare("INSERT INTO user_photos(user_id, type, bytes, sha256, fetched_at) VALUES(?, 'image/png', ?, 'x', 1)").run(id, Buffer.from("png"));
    const group = (await owner.post("/api/chats", { name: "Group", users: [id] })).json.chat;
    await a.post(`/api/chats/${group.id}/read`, {});
    await deactivate("person-a@example.com");
    // deactivating ends every session; one made after it, such as by a script, still goes
    db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES('example-session', ?, ?)").run(id, Date.now() + 60_000);

    const lines = deletePerson(db, " Person-A@example.com ");
    assert.deepEqual(lines, [
      `Deleted person-a@example.com (${id}): sessions, username @example-program, look, photo, deactivated record, chat memberships, read marks, account.`,
    ]);
    for (const [table, col] of [
      ["users", "id"],
      ["sessions", "user_id"],
      ["user_handles", "user_id"],
      ["user_looks", "user_id"],
      ["user_photos", "user_id"],
      ["deactivated_users", "user_id"],
      ["chat_members", "member_id"],
      ["chat_reads", "user_id"],
    ])
      assert.equal(rows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, id), 0, table);
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM chats WHERE id = ?", group.id), 1, "the chat stays");
    assert.equal(
      (await owner.get("/api/users")).json.users.some((u: any) => u.email === "person-a@example.com"),
      false,
    );
    assert.throws(() => deletePerson(db, "person-a@example.com"), /no account for person-a@example\.com/);
  } finally {
    await h.close();
  }
});

test("refused, with nothing changed: the owner, an admin, an active account, an unknown one, and any account with work", async () => {
  const { h, idOf, signIn, deactivate } = await setup();
  try {
    const db = h.app.db;
    assert.throws(() => deletePerson(db, "tash@lumen.test"), /is the owner: refused/);
    assert.throws(() => deletePerson(db, "person-b@example.com"), /is an admin: refused/);
    assert.throws(() => deletePerson(db, "person-c@example.com"), /isn't deactivated: deactivate the account first/);
    assert.throws(() => deletePerson(db, "nobody@example.com"), /no account for nobody@example\.com/);
    assert.throws(() => deletePerson(db, ""), /usage: cli\.ts delete-person <email>/);

    // each kind of work, on its own, refuses it
    const id = idOf("person-c@example.com");
    const c = await signIn("person-c@example.com");
    const group = (await c.post("/api/chats", { name: "Work" })).json.chat;
    await deactivate("person-c@example.com");
    const t = Date.now();
    const kinds: [string, string, string][] = [
      [
        "1 messages",
        `INSERT INTO messages(id, chat_id, author_type, author_id, body, ts) VALUES('m_x', '${group.id}', 'user', '${id}', 'hello', ${t})`,
        "DELETE FROM messages WHERE id = 'm_x'",
      ],
      [
        "1 tasks",
        `INSERT INTO tasks(id, chat_id, title, created_by, created_at, updated_at) VALUES('t_x', '${group.id}', 'made', '${id}', ${t}, ${t})`,
        "DELETE FROM tasks WHERE id = 't_x'",
      ],
      [
        "1 tasks",
        `INSERT INTO tasks(id, chat_id, title, assignee_type, assignee_id, created_at, updated_at) VALUES('t_y', '${group.id}', 'held', 'user', '${id}', ${t}, ${t})`,
        "DELETE FROM tasks WHERE id = 't_y'",
      ],
      [
        "1 approvals",
        `INSERT INTO approvals(id, agent_id, source, title, state, decided_by, created_at, expires_at) VALUES('ap_x', 'a_x', 'gateway', 'ok?', 'approved', '${id}', ${t}, ${t})`,
        "DELETE FROM approvals WHERE id = 'ap_x'",
      ],
      [
        "1 memories",
        `INSERT INTO memories(id, scope, text, by_type, by_id, created_at) VALUES('mem_x', 'team', 'a fact', 'user', '${id}', ${t})`,
        "DELETE FROM memories WHERE id = 'mem_x'",
      ],
      [
        "1 connections",
        `INSERT INTO connections(id, app, name, identity, owner_user_id, created_at) VALUES('conn_x', 'example-app', 'Mine', 'user', '${id}', ${t})`,
        "DELETE FROM connections WHERE id = 'conn_x'",
      ],
    ];
    for (const [what, add, undo] of kinds) {
      db.exec(add);
      assert.throws(() => deletePerson(db, "person-c@example.com"), new RegExp(`still has work: ${what}\\.`), what);
      db.exec(undo);
    }
    // a file on a message of theirs counts too, alongside the message
    db.exec(`INSERT INTO messages(id, chat_id, author_type, author_id, body, ts) VALUES('m_f', '${group.id}', 'user', '${id}', 'a file', ${t})`);
    db.exec(`INSERT INTO files(id, chat_id, message_id, name, size, sha256, created_at) VALUES('f_x', '${group.id}', 'm_f', 'a.txt', 1, 'x', ${t})`);
    assert.throws(() => deletePerson(db, "person-c@example.com"), /still has work: 1 messages, 1 files\./);
    db.exec("DELETE FROM messages WHERE id = 'm_f'");

    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id), 1, "nothing changed");
    assert.match(deletePerson(db, "person-c@example.com")[0], /^Deleted person-c@example\.com/, "with its work gone, it may go");
  } finally {
    await h.close();
  }
});

test(
  "cli delete-person: refused for anyone but root, with nothing on stdout and no change",
  { skip: process.getuid?.() === 0 ? "running as root" : false },
  async () => {
    const { h, idOf, deactivate } = await setup();
    try {
      await deactivate("person-a@example.com");
      const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
      const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
      const r = spawnSync("node", [cli, "delete-person", "person-a@example.com"], { env, encoding: "utf8" });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /only root may run this: use sudo/);
      assert.equal(rows(h.app.db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", idOf("person-a@example.com")), 1);
    } finally {
      await h.close();
    }
  },
);
