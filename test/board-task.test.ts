// SPDX-License-Identifier: AGPL-3.0-only
// A task opened from the Board (web/src/screens/BoardTask.tsx): its address, and what the server lets
// the window read. The window finds its task in GET /api/tasks, the board's own rule, so a task from a
// chat the person can't see, an archived one, or one whose chat they left, is "not found", and every
// route the window calls for it says 404 or returns nothing. Generic names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, Client, type Harness } from "./helpers.ts";
import { boardUrl, readQuery, readTask } from "../web/src/board.ts";

test("the open task lives in the board's address, beside the filters", () => {
  const none = readQuery("");
  assert.equal(boardUrl(none), "/board");
  assert.equal(boardUrl(none, "t_1"), "/board?task=t_1");
  const q = readQuery("?chat=c_1&done=all&task=t_1");
  assert.equal(boardUrl(q, "t_2"), "/board?chat=c_1&done=all&task=t_2");
  assert.equal(boardUrl(q), "/board?chat=c_1&done=all", "closing keeps the filters");
  assert.equal(readTask("?chat=c_1&task=t_1"), "t_1");
  assert.equal(readTask("?chat=c_1"), "");
  assert.equal(readTask(`?task=${encodeURIComponent("t 1&x")}`), "t 1&x", "an odd id reads back as it was");
  assert.equal(boardUrl(none, "t 1&x"), "/board?task=t%201%26x");
  assert.ok(!("task" in q), "the task is not a filter: it never reaches GET /api/board");
});

async function signIn(h: Harness, email: string): Promise<Client> {
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email, password: "example-password-1" })).status, 200);
  return c;
}

test("a task the person can't see is in no list the window reads, and its routes say 404", async () => {
  const h = await startApp();
  try {
    const owner = new Client(h.url);
    assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
    const add = async (name: string, email: string) => (await owner.post("/api/users", { email, name, password: "example-password-1", role: "member" })).json.user.id as string;
    const bId = await add("Person B", "person-b@example.com");
    const cId = await add("Person C", "person-c@example.com");
    const b = await signIn(h, "person-b@example.com");
    const c = await signIn(h, "person-c@example.com");
    const designer = (await owner.post("/api/agents", { name: "Designer", handle: "designer", engine: "mock", sandbox: "local", roleTitle: "Agent" })).json.agent.id;
    const shared = (await owner.post("/api/chats", { name: "acme launch", users: [bId, cId], agents: [designer] })).json.chat.id;
    const svc = h.app.svc;
    const open = svc.createTask({ chatId: shared, title: "Draft the landing page", createdBy: designer });
    const later = svc.createTask({ chatId: shared, title: "Publish the page", createdBy: designer });
    // Person C's own chat: neither Person B nor the owner, an admin, is in it
    const own = (await c.post("/api/chats", { name: "person c notes" })).json.chat.id;
    const hidden = svc.createTask({ chatId: own, title: "Person C's private task", createdBy: cId });

    const listed = async (who: Client) => new Set((await who.get("/api/tasks")).json.tasks.map((t: any) => t.id));
    assert.ok((await listed(b)).has(open.id), "a task in a chat they're in");
    assert.ok((await listed(c)).has(hidden.id), "Person C sees their own");
    // the window's list has no admin override, like the board: an admin gets "not found" too
    for (const who of [b, owner]) {
      const text = JSON.stringify((await who.get("/api/tasks")).json);
      assert.ok(!text.includes(hidden.id) && !text.includes("Person C's private task"), "nothing of the hidden task, admin or not");
    }
    assert.equal((await b.get(`/api/tasks/${hidden.id}/settings/history`)).status, 404, "its settings history");
    assert.deepEqual((await b.get(`/api/files?task=${hidden.id}`)).json.files, [], "its files");
    assert.equal((await b.patch(`/api/tasks/${hidden.id}`, { status: "done" })).status, 404, "its status");
    assert.equal(svc.task(hidden.id).status, "todo", "unchanged");
    assert.equal((await b.get(`/api/tasks/${"t_no_such_task"}/settings/history`)).status, 404, "a task that doesn't exist");

    // hidden while open: archived, or the person leaves its chat
    assert.equal((await b.post(`/api/tasks/${open.id}/archive`)).status, 200);
    assert.ok(!(await listed(b)).has(open.id), "an archived task leaves the list");
    assert.ok((await listed(b)).has(later.id));
    assert.equal((await owner.post(`/api/chats/${shared}/members`, { type: "user", id: bId, remove: true })).status, 200);
    assert.ok(!(await listed(b)).has(later.id), "gone once they leave the chat");
    assert.equal((await b.get(`/api/tasks/${later.id}/settings/history`)).status, 404);
    assert.equal((await b.patch(`/api/tasks/${later.id}`, { status: "done" })).status, 404);
  } finally {
    await h.close();
  }
});
