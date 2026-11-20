// SPDX-License-Identifier: AGPL-3.0-only
// Archive (server/src/archive.ts): tasks, plans and chats leave every list but stay in the database and
// the export, show under Archived, and come back on restore. Who may: an admin, a person in the
// item's chat, and a service for the tasks of the agents it drives. And the cancelled task status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startApp, setupOwner, mockAgent, Client, type Harness } from "./helpers.ts";
import { openDb } from "../server/src/db.ts";
import { exportWorkspace } from "../server/src/hosting.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";

const PASSWORD = "example-password-1";

async function setup() {
  const h = await startApp();
  const owner = await setupOwner(h);
  for (const [email, role] of [
    ["person-a@example.com", "member"],
    ["person-b@example.com", "member"],
  ])
    assert.equal((await owner.post("/api/users", { email, name: email.split("@")[0], password: PASSWORD, role })).status, 200);
  const users = (await owner.get("/api/users")).json.users as any[];
  const idOf = (email: string) => users.find((u) => u.email === email).id;
  const signIn = async (email: string) => {
    const c = new Client(h.url);
    assert.equal((await c.post("/api/login", { email, password: PASSWORD })).status, 200);
    return c;
  };
  const designer = await mockAgent(owner, "designer");
  const writer = await mockAgent(owner, "writer");
  // a group the owner isn't in: person-a and the designer; person-b is outside it
  const a = await signIn("person-a@example.com");
  const b = await signIn("person-b@example.com");
  const group = (await a.post("/api/chats", { name: "Group", agents: [designer.id, writer.id] })).json.chat;
  return { h, owner, a, b, idOf, designer, writer, group };
}
const plan = async (h: Harness, agent: any, chatId: string, steps: string[]) => {
  const r = await h.app.gateway.call(
    "propose_plan",
    { title: "A made-up set", steps: steps.map((title) => ({ title, assignee: agent.handle })) },
    { agent: h.app.svc.agent(agent.id)!, chatId, requester: { type: "user", id: "" } },
  );
  return { planId: h.app.svc.task(/Task ids: (.*)$/.exec(r.text)![1].split(", ")[0]).planId as string, ids: /Task ids: (.*)$/.exec(r.text)![1].split(", ") };
};
const titles = (r: any) => (r.json.tasks as any[]).map((t) => t.title);

test("a task: archived by a person in its chat, it leaves the lists and search, stays, shows under Archived, and comes back", async () => {
  const { h, owner, a, b, group } = await setup();
  try {
    const task = (await a.post("/api/tasks", { chatId: group.id, title: "Old leftover task" })).json.task;
    await a.post("/api/tasks", { chatId: group.id, title: "Still open" });
    assert.equal((await b.post(`/api/tasks/${task.id}/archive`)).status, 403, "a person outside the chat");
    const r = await a.post(`/api/tasks/${task.id}/archive`);
    assert.deepEqual(r.json, { ok: true, changed: 1 });
    assert.deepEqual((await a.post(`/api/tasks/${task.id}/archive`)).json, { ok: true, changed: 0 }, "twice changes nothing");
    assert.deepEqual(titles(await a.get("/api/tasks")), ["Still open"]);
    assert.deepEqual(titles(await a.get(`/api/tasks?chat=${group.id}`)), ["Still open"]);
    assert.deepEqual((await a.get("/api/search?q=leftover")).json.tasks, [], "and search");
    const shelf = (await a.get("/api/archived")).json;
    assert.deepEqual(shelf.tasks.map((t: any) => [t.title, !!t.archivedAt]), [["Old leftover task", true]]);
    assert.deepEqual((await b.get("/api/archived")).json.tasks, [], "not for someone outside the chat");
    const row = h.app.db.prepare("SELECT title, archived_at, archived_by FROM tasks WHERE id = ?").get(task.id) as any;
    assert.equal(row.title, "Old leftover task", "never deleted");
    assert.ok(row.archived_at > 0 && row.archived_by);

    // in the export, as archived
    const out = await exportWorkspace(h.app);
    const tarred = Buffer.from(await new Response(out.stream).arrayBuffer());
    const ws = JSON.parse(spawnSync("tar", ["-xzOf", "-", "circlechat-export/workspace.json"], { input: tarred, maxBuffer: 64 * 1024 * 1024 }).stdout.toString());
    assert.ok(ws.tables.tasks.some((t: any) => t.id === task.id && t.archived_at), "the export keeps it, with when it was archived");

    // an admin may restore it, though not in the chat
    assert.equal((await owner.post(`/api/tasks/${task.id}/restore`)).status, 200);
    assert.deepEqual(titles(await a.get("/api/tasks")).sort(), ["Old leftover task", "Still open"]);
    assert.deepEqual((await a.get("/api/archived")).json.tasks, []);
    assert.equal((await a.post("/api/tasks/t_none/archive")).status, 404);
  } finally {
    await h.close();
  }
});

test("a plan: every task at once, its card shows them archived, and it restores at once", async () => {
  const { h, a, designer, group } = await setup();
  try {
    const { planId, ids } = await plan(h, designer, group.id, ["Interview 1 of 1 — A made-up gadget", "Zip the transcripts"]);
    const r = await a.post(`/api/plans/${planId}/archive`);
    assert.deepEqual(r.json, { ok: true, changed: 2 });
    assert.deepEqual(titles(await a.get("/api/tasks")), []);
    const card = (await a.get(`/api/chats/${group.id}/messages`)).json.messages.find((m: any) => m.kind === "plan");
    assert.ok(card.meta.steps.every((s: any) => s.archivedAt), "the plan card mirrors its tasks");
    assert.equal((await a.post(`/api/tasks/${ids[1]}/restore`)).status, 200, "one task of it on its own");
    assert.deepEqual(titles(await a.get("/api/tasks")), ["Zip the transcripts"]);
    assert.deepEqual((await a.post(`/api/plans/${planId}/restore`)).json, { ok: true, changed: 1 });
    assert.equal((await a.get("/api/tasks")).json.tasks.length, 2);
    assert.equal((await a.post("/api/plans/p_none/archive")).status, 404);
  } finally {
    await h.close();
  }
});

test("a chat: it leaves the chat list, its tasks leave the task lists, it reads but takes no message, and it restores", async () => {
  const { h, owner, a, b, designer, group } = await setup();
  try {
    await a.post("/api/tasks", { chatId: group.id, title: "In the old chat" });
    assert.equal((await b.post(`/api/chats/${group.id}/archive`)).status, 403);
    assert.equal((await a.post(`/api/chats/${group.id}/archive`)).status, 200);
    assert.ok(!(await a.get("/api/chats")).json.chats.some((c: any) => c.id === group.id));
    assert.deepEqual(titles(await a.get("/api/tasks")), [], "its tasks leave with it");
    assert.deepEqual((await a.get("/api/search?q=old")).json.chats, []);
    const shelf = (await a.get("/api/archived")).json;
    assert.deepEqual(shelf.chats.map((c: any) => c.id), [group.id]);
    assert.ok((await owner.get("/api/archived")).json.chats.some((c: any) => c.id === group.id), "an admin sees every archived chat");
    const opened = await a.get(`/api/chats/${group.id}`);
    assert.equal(opened.status, 200);
    assert.ok(opened.json.chat.archivedAt);
    assert.equal((await a.get(`/api/chats/${group.id}/messages`)).status, 200, "it still reads");
    const posted = await a.post(`/api/chats/${group.id}/messages`, { body: "hello?" });
    assert.equal(posted.status, 409);
    assert.match(posted.json.error, /archived/);
    assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = ?").get(group.id)!.n, 1, "never deleted");

    const dm = (await a.post("/api/chats", { dmAgent: designer.id })).json.chat;
    const refused = await a.post(`/api/chats/${dm.id}/archive`);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /direct chat/);

    assert.equal((await a.post(`/api/chats/${group.id}/restore`)).status, 200);
    assert.ok((await a.get("/api/chats")).json.chats.some((c: any) => c.id === group.id));
    assert.deepEqual(titles(await a.get("/api/tasks")), ["In the old chat"]);
    assert.equal((await a.post(`/api/chats/${group.id}/messages`, { body: "back" })).status, 200);
  } finally {
    await h.close();
  }
});

test("cancelled: a task status beside done, for people, agents and services", async () => {
  const { h, a, designer, group } = await setup();
  try {
    const task = (await a.post("/api/tasks", { chatId: group.id, title: "Won't happen" })).json.task;
    assert.equal((await a.patch(`/api/tasks/${task.id}`, { status: "cancelled" })).json.task.status, "cancelled");
    assert.equal((await a.patch(`/api/tasks/${task.id}`, { status: "abandoned" })).status, 400);
    const ctx = { agent: h.app.svc.agent(designer.id)!, chatId: group.id, requester: { type: "user" as const, id: "" } };
    assert.equal((await h.app.gateway.call("task_update", { id: task.id, status: "todo" }, ctx)).isError, false);
    const r = await h.app.gateway.call("task_update", { id: task.id, status: "cancelled" }, ctx);
    assert.equal(r.isError, false, r.text);
    assert.equal(h.app.svc.task(task.id).status, "cancelled", "an agent cancels a task too");
  } finally {
    await h.close();
  }
});

test("a service archives and restores the tasks of the agents it drives, and no others", async () => {
  const { h, a, designer, writer, group } = await setup();
  try {
    serviceCommand(h.app.db, "service-create", ["example-service"]);
    serviceCommand(h.app.db, "service-drive", ["example-service", "designer"]);
    const token = serviceCommand(h.app.db, "service-token", ["example-service"]).stdout ?? "";
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(h.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const { ids } = await plan(h, designer, group.id, ["Interview 1 of 1 — A made-up gadget"]);
    const theirs = (await a.post("/api/tasks", { chatId: group.id, title: "The writer's", assigneeType: "agent", assigneeId: writer.id })).json.task;
    const nobody = (await a.post("/api/tasks", { chatId: group.id, title: "Nobody's" })).json.task;

    assert.deepEqual((await call(`/api/service/tasks/${ids[0]}/archive`, {})).json, { ok: true, changed: 1 });
    assert.ok(!(await call(`/api/service/chats/${group.id}/tasks`)).json.tasks.some((t: any) => t.id === ids[0]), "it leaves the service's view too");
    assert.match((h.app.db.prepare("SELECT archived_by FROM tasks WHERE id = ?").get(ids[0]) as any).archived_by, /^service:/);
    assert.equal((await call(`/api/service/tasks/${theirs.id}/archive`, {})).status, 403, "another agent's task");
    assert.equal((await call(`/api/service/tasks/${nobody.id}/archive`, {})).status, 403, "a task with no agent");
    assert.equal((await call("/api/service/tasks/t_none/archive", {})).status, 404);
    assert.deepEqual((await call(`/api/service/tasks/${ids[0]}/restore`, {})).json, { ok: true, changed: 1 });
    assert.equal((await call(`/api/service/tasks/${ids[0]}/archive`, { ignored: true })).status, 200);
    // and cancelled, through the service's task route
    const patched = await fetch(h.url + `/api/service/tasks/${theirs.id}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
    assert.equal((await patched.json()).task.status, "cancelled");
  } finally {
    await h.close();
  }
});

test("a database from before archive: tasks rebuilt once with every row kept, chats gain their columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-archive-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('group','dm','agents')), name TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, title TEXT NOT NULL,
  assignee_type TEXT NOT NULL DEFAULT '', assignee_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','working','needs_you','checking','done')),
  plan_id TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO chats VALUES ('c_1', 'group', 'Old', '', 1);
INSERT INTO tasks VALUES ('t_1', 'c_1', 'Kept', 'agent', 'a_1', 'needs_you', 'p_1', 'u_1', 2, 3);`);
  old.close();
  const db = openDb(path);
  assert.deepEqual({ ...(db.prepare("SELECT id, title, status, plan_id, archived_at FROM tasks").get() as any) }, { id: "t_1", title: "Kept", status: "needs_you", plan_id: "p_1", archived_at: null });
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 't_1'").run();
  assert.equal((db.prepare("SELECT archived_at FROM chats WHERE id = 'c_1'").get() as any).archived_at, null);
  assert.throws(() => db.prepare("UPDATE tasks SET status = 'gone' WHERE id = 't_1'").run(), /CHECK/);
  db.close();
  const again = openDb(path);
  assert.equal((again.prepare("SELECT status FROM tasks").get() as any).status, "cancelled", "opened again: no second rebuild");
  again.close();
});
