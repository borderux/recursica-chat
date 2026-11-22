// SPDX-License-Identifier: AGPL-3.0-only
// A task's progress line (server/src/taskprogress.ts, web/src/taskprogress.ts): set by the service
// driving an agent, shown in place on the task and its plan card, never as a chat message. And the
// live "Working" mark: only on a task at "working", never on one that waits its turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startApp, setupOwner, mockAgent, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { MAX_PROGRESS, parseProgress } from "../server/src/taskprogress.ts";
import { progressLine, showsWorking } from "../web/src/taskprogress.ts";

const svcCall = (h: Harness, t: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(h.url + path, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
};

test("a progress line: one line of text, at most 80 characters, trimmed", () => {
  assert.equal(parseProgress("  Step 17 of 43 "), "Step 17 of 43");
  assert.equal(parseProgress(""), "", "empty clears it");
  for (const [v, why] of [
    [17, /progress must be text/],
    ["Step 1\nStep 2", /one line/],
    ["x".repeat(MAX_PROGRESS + 1), /over 80/],
  ] as const)
    assert.throws(() => parseProgress(v), why);
});

test("the service sets a task's progress in place: on the task and its plan card, with no chat message, and empty clears it", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const writer = await mockAgent(owner, "writer");
    const db = h.app.db;
    const svc = h.app.svc;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "writer"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const chat = (await owner.post("/api/chats", { name: "Group", agents: [writer.id] })).json.chat;

    // a plan card with two steps, as propose_plan posts it
    const planId = "plan_example";
    const steps = ["Part 1 of 1", "Bundle the results"].map((title) => svc.createTask({ chatId: chat.id, title, assigneeType: "agent", assigneeId: writer.id, planId, createdBy: writer.id }));
    svc.insertMessage({ chatId: chat.id, authorType: "agent", authorId: writer.id, kind: "plan", body: "Example plan", meta: { planId, steps } });
    const messages = () => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(chat.id) as any).n;
    const before = messages();
    const updatedAt = steps[0].updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const set = await call("PATCH", `/api/service/tasks/${steps[0].id}`, { status: "working", progress: "Step 17 of 43" });
    assert.equal(set.status, 200);
    assert.equal(set.json.task.progress, "Step 17 of 43");
    assert.equal(set.json.task.status, "working");
    assert.ok(set.json.task.updatedAt > updatedAt, "progress is activity: the task's time moves");
    // progress alone, then the API, the task list and the plan card all show it
    assert.equal((await call("PATCH", `/api/service/tasks/${steps[0].id}`, { progress: "Step 18 of 43" })).json.task.progress, "Step 18 of 43");
    assert.equal((await owner.get("/api/tasks")).json.tasks.find((t: any) => t.id === steps[0].id).progress, "Step 18 of 43", "the task list has it");
    const card = JSON.parse((db.prepare("SELECT meta FROM messages WHERE kind = 'plan' AND chat_id = ?").get(chat.id) as any).meta);
    assert.deepEqual(card.steps.map((s: any) => [s.title, s.status, s.progress]), [
      ["Part 1 of 1", "working", "Step 18 of 43"],
      ["Bundle the results", "todo", ""],
    ]);
    assert.equal(messages(), before, "no chat message: the card is updated in place");

    // refusals, and empty clears it
    assert.equal((await call("PATCH", `/api/service/tasks/${steps[0].id}`, { progress: "a\nb" })).status, 400);
    assert.equal((await call("PATCH", `/api/service/tasks/${steps[0].id}`, { progress: "x".repeat(81) })).status, 400);
    assert.equal(svc.task(steps[0].id).progress, "Step 18 of 43", "a refused line changes nothing");
    assert.equal((await call("PATCH", `/api/service/tasks/${steps[0].id}`, { status: "done", progress: "" })).json.task.progress, "");
    assert.equal(svc.task(steps[1].id).progress, "", "a task with none has none");
  } finally {
    await h.close();
  }
});

test("the web app: the progress line shows while a task runs, and the Working mark only on a task at working", () => {
  assert.equal(progressLine({ status: "working", progress: "Step 17 of 43" }), "Step 17 of 43");
  assert.equal(progressLine({ status: "needs_you", progress: "Step 43 of 43" }), "Step 43 of 43");
  assert.equal(progressLine({ status: "done", progress: "Step 43 of 43" }), "", "not once it's done");
  assert.equal(progressLine({ status: "cancelled", progress: "Step 3 of 43" }), "");
  assert.equal(progressLine({ status: "working" }), "");
  // a task that waits its turn, such as a last step after the others, isn't working while its agent works on another
  assert.equal(showsWorking({ status: "todo" }), false);
  assert.equal(showsWorking({ status: "working" }), true);
  for (const status of ["needs_you", "checking", "done", "cancelled"]) assert.equal(showsWorking({ status }), false, status);

  for (const file of ["../web/src/screens/Chats.tsx", "../web/src/screens/Tasks.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /<WorkingMark a=\{agent\(t\.assigneeId\)\} chatId=\{[^}]+\} done=\{!showsWorking\(t\)\} \/>/, file);
    assert.match(src, /\{progressLine\(t\) && <span className="task-progress">\{progressLine\(t\)\}<\/span>\}/, file);
    assert.doesNotMatch(src, /<WorkingMark [^>]*done=\{t\.status === "done"\}/, `${file}: never on a task that only isn't done`);
  }
});
