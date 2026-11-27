// SPDX-License-Identifier: AGPL-3.0-only
// A plan a service posts for an agent it drives (server/src/serviceplans.ts): the same tasks and plan
// card as the agent's own propose_plan, with the steps the service gives, and no turn for the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, setupOwner, mockAgent, type Harness } from "./helpers.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { parsePlan } from "../server/src/serviceplans.ts";

const svcCall = (h: Harness, t: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(h.url + path, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
};

test("a plan's title and steps: trimmed, 1 to 200 characters each, 1 to 20 steps, nothing cut", () => {
  assert.deepEqual(parsePlan({ title: "  Example plan ", steps: [" Draft the page", "Check it  "] }), { title: "Example plan", steps: ["Draft the page", "Check it"] });
  const twenty = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`);
  assert.deepEqual(parsePlan({ title: "t", steps: twenty }), { title: "t", steps: twenty });
  for (const [b, why] of [
    [{ steps: ["a"] }, /title is missing/],
    [{ title: "   ", steps: ["a"] }, /title is empty/],
    [{ title: "x".repeat(201), steps: ["a"] }, /longer than 200/],
    [{ title: "t" }, /steps is a list/],
    [{ title: "t", steps: [] }, /steps is a list/],
    [{ title: "t", steps: "a" }, /steps is a list/],
    [{ title: "t", steps: [...twenty, "Step 21"] }, /at most 20 steps/],
    [{ title: "t", steps: ["a", " "] }, /step 2 is empty/],
    [{ title: "t", steps: ["a", 7] }, /step 2 is missing/],
    [{ title: "t", steps: ["x".repeat(201)] }, /step 1 is longer than 200/],
  ] as const)
    assert.match((parsePlan(b) as any).error ?? "", why, JSON.stringify(b).slice(0, 80));
});

test("the service posts a plan as its agent: tasks in order, the agent's plan card, and no turn", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    const designer = await mockAgent(owner, "designer");
    const reviewer = await mockAgent(owner, "reviewer");
    const outsider = await mockAgent(owner, "outsider");
    const db = h.app.db;
    serviceCommand(db, "service-create", ["example-service"]);
    serviceCommand(db, "service-drive", ["example-service", "designer"]);
    serviceCommand(db, "service-drive", ["example-service", "outsider"]);
    const call = svcCall(h, serviceCommand(db, "service-token", ["example-service"]).stdout ?? "");
    const chat = (await owner.post("/api/chats", { name: "Group", agents: [designer.id, reviewer.id] })).json.chat;
    const elsewhere = (await owner.post("/api/chats", { name: "Elsewhere", agents: [reviewer.id] })).json.chat;

    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
    const before = { deliveries: count("deliveries"), requests: count("service_requests"), messages: count("messages") };
    const events: any[] = [];
    const listen = (e: any) => events.push(e);
    h.app.bus.on("event", listen);

    const steps = ["Draft the page", "Check the page against acme's rules", "Bundle the results"];
    const r = await call("POST", `/api/service/chats/${chat.id}/plans`, { agent: "@designer", title: " Build example-app's page ", steps });
    h.app.bus.off("event", listen);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const { plan, tasks } = r.json;
    assert.match(plan.id, /^plan_/);
    assert.deepEqual(
      tasks.map((t: any) => [t.title, t.status, t.assigneeType, t.assigneeId, t.createdBy, t.planId, t.chatId]),
      steps.map((title) => [title, "todo", "agent", designer.id, designer.id, plan.id, chat.id]),
      "one task per step, in order, the agent's",
    );
    // the tasks as the tasks route gives them
    const listed = (await call("GET", `/api/service/chats/${chat.id}/tasks`)).json.tasks;
    assert.deepEqual(listed.filter((t: any) => t.planId === plan.id), tasks);

    // the plan card: the agent's plan message, as propose_plan posts it
    const msg = (await owner.get(`/api/chats/${chat.id}/messages`)).json.messages.find((m: any) => m.id === plan.messageId);
    assert.ok(msg, "the plan message is in the chat");
    assert.equal(msg.kind, "plan");
    assert.equal(msg.authorType, "agent");
    assert.equal(msg.authorId, designer.id);
    assert.equal(msg.body, "Build example-app's page");
    assert.equal(msg.meta.planId, plan.id);
    assert.deepEqual(msg.meta.steps.map((s: any) => s.id), tasks.map((t: any) => t.id));
    assert.equal(count("messages"), before.messages + 1, "one message: the plan card");

    // live: a task event per step, then the plan message
    assert.deepEqual(
      events.filter((e) => e.type === "task" || e.type === "message").map((e) => (e.type === "task" ? e.task.title : `message:${e.message.kind}`)),
      [...steps, "message:plan"],
    );

    // the plan card follows its tasks, as for a proposed plan
    await call("PATCH", `/api/service/tasks/${tasks[0].id}`, { status: "working" });
    const card = JSON.parse((db.prepare("SELECT meta FROM messages WHERE id = ?").get(plan.messageId) as any).meta);
    assert.deepEqual(card.steps.map((s: any) => s.status), ["working", "todo", "todo"]);

    // and the board lists the plan by its title
    const board = (await owner.get("/api/board")).json;
    assert.equal(board.plans[plan.id], "Build example-app's page");
    assert.ok(board.options.plans.includes(plan.id));

    // no turn: nothing delivered to the agent or to its service
    assert.equal(count("deliveries"), before.deliveries, "nothing delivered");
    assert.equal(count("service_requests"), before.requests, "no request for the service");
    assert.ok(!events.some((e) => e.type === "delivery" || e.type === "agent_status"), "the agent isn't woken");

    // refusals
    const tasksNow = count("tasks");
    const post = (cid: string, b: unknown) => call("POST", `/api/service/chats/${cid}/plans`, b);
    const ok = { agent: "designer", title: "Example plan", steps: ["a"] };
    assert.equal((await post(elsewhere.id, ok)).status, 404, "a chat none of its agents is in");
    assert.equal((await post("c_none", ok)).status, 404);
    assert.equal((await post(chat.id, { ...ok, agent: "reviewer" })).status, 403, "an agent it doesn't drive");
    assert.equal((await post(chat.id, { ...ok, agent: "" })).status, 403);
    assert.equal((await post(chat.id, { ...ok, agent: "outsider" })).status, 409, "an agent it drives, not in the chat");
    assert.equal(outsider.handle, "outsider");
    assert.equal((await post(chat.id, { ...ok, steps: [] })).status, 400, "no steps");
    assert.equal((await post(chat.id, { ...ok, steps: Array.from({ length: 21 }, (_, i) => `Step ${i + 1}`) })).status, 400, "21 steps");
    assert.equal((await post(chat.id, { ...ok, steps: ["a", "  "] })).status, 400, "an empty step");
    assert.equal((await post(chat.id, { agent: "designer", steps: ["a"] })).status, 400, "no title");
    assert.equal((await post(chat.id, "not json")).status, 400);
    const refused = await post(chat.id, { ...ok, steps: [] });
    assert.match(refused.json.error, /steps/);
    assert.equal(count("tasks"), tasksNow, "a refused plan makes nothing");
    assert.equal(count("messages"), before.messages + 1);
  } finally {
    await h.close();
  }
});
