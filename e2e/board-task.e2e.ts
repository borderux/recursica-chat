// SPDX-License-Identifier: AGPL-3.0-only
// A card's task, open over the Board (web/src/screens/BoardTask.tsx): a click or a key opens it with
// ?task=… in the address; Back, Escape, a click outside and the close button close it; a link opens
// it; the focus stays inside and goes back to the card; a status change moves the card behind it, and
// a refused one goes back; a task an agent runs offers Cancel, an Answer box when it needs you, and
// Reopen once finished (server/src/taskrules.ts); live changes reach it; a task that's gone or hidden
// says "not found"; and on a phone it's a full-screen sheet. Generic names and data only.
// Run: npm run build && node --test e2e/board-task.e2e.ts
// BOARD_TASK_SHOTS=<dir> also saves the screenshots for docs/screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startApp, Client, waitFor, type Harness } from "../test/helpers.ts";
import { parseTaskSettings, useTaskSettings } from "../server/src/tasksettings.ts";
import { startGatewayRoute } from "../server/src/gatewayroute.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.BOARD_TASK_SHOTS ?? "";
const KEY = "example-gateway-key-0123456789abcdef";
let h: Harness, browser: Browser, page: Page, gw: Server, keyDir: string, owner: Client;
const ids: Record<string, string> = {};

const DIALOG = '.overlay [role="dialog"][aria-modal="true"]';
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);
const dialogText = () => page.$eval(DIALOG, (e) => (e as HTMLElement).innerText);
const isOpen = () => page.evaluate((sel) => !!document.querySelector(sel), DIALOG);
const waitOpen = (what: string) => waitFor(isOpen, what, 10_000, 100);
const waitClosed = (what: string) => waitFor(async () => !(await isOpen()), what, 10_000, 100);
const taskInUrl = () => new URL(page.url()).searchParams.get("task") ?? "";
const columnOf = (id: string) => page.evaluate((id) => document.querySelector(`[data-task="${id}"]`)?.closest("[data-col]")?.getAttribute("data-col") ?? "", id);
const waitColumn = (id: string, col: string, what: string) => waitFor(async () => (await columnOf(id)) === col, what, 10_000, 100);
const focusedCard = () => page.evaluate(() => document.activeElement?.getAttribute("data-task") ?? "");
const statusValue = () => page.$eval(`${DIALOG} select[aria-label="Status"]`, (e) => (e as HTMLSelectElement).value);
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `board-task-${name}.png`) as `${string}.png` });
};
const openCard = async (id: string) => {
  await page.click(`[data-task="${id}"] .board-card-t b`);
  await waitOpen("the task opens");
  await waitFor(async () => taskInUrl() === id, "the task in the address", 5000, 50);
};

before(async () => {
  h = await startApp();
  useTaskSettings(
    h.app.db,
    parseTaskSettings({
      settings: [
        { key: "speed", label: "Speed", default: "slow", choices: [{ value: "fast", label: "Fast" }, { value: "slow", label: "Slow" }] },
        { key: "review", label: "Review", default: "quick", choices: [{ value: "quick", label: "Quick" }, { value: "thorough", label: "Thorough" }] },
      ],
      stall_minutes: 15,
    }),
  );
  keyDir = mkdtempSync(join(tmpdir(), "cc-gw-e2e-"));
  writeFileSync(join(keyDir, "gateway.key"), KEY, { mode: 0o600 });
  gw = startGatewayRoute(h.app, { CIRCLECHAT_GATEWAY_PORT: "0", CIRCLECHAT_GATEWAY_KEY_FILE: join(keyDir, "gateway.key") }, () => {})!;
  if (!gw.listening) await once(gw, "listening");
  const gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  owner = new Client(h.url);
  assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
  const me = (await owner.get("/api/me")).json.user.id;
  const people: Record<string, string> = {};
  for (const [name, email] of [
    ["Person B", "person-b@example.com"],
    ["Person C", "person-c@example.com"],
  ])
    people[name] = (await owner.post("/api/users", { email, name, password: "example-password-1", role: "member" })).json.user.id;
  const agent = async (name: string, handle: string, style: string, colour: string) =>
    (await owner.post("/api/agents", { name, handle, engine: "mock", sandbox: "local", roleTitle: "Agent", style, colour })).json.agent.id as string;
  const designer = await agent("Designer", "designer", "twin", "mint");
  const writer = await agent("Writer", "writer", "halo", "lilac");
  const svc = h.app.svc;
  const researcher = await agent("Researcher", "researcher", "curly", "sky");
  // a program drives the researcher, and hasn't said it can redo work
  serviceCommand(h.app.db, "service-create", ["example-service"]);
  serviceCommand(h.app.db, "service-drive", ["example-service", "researcher"]);
  const launch = (await owner.post("/api/chats", { name: "acme launch", users: [people["Person B"]], agents: [designer, writer, researcher] })).json.chat.id;
  const app = (await owner.post("/api/chats", { name: "example-app", users: [people["Person C"]], agents: [writer] })).json.chat.id;
  ids.launch = launch;
  ids.me = me;
  const task = (chatId: string, title: string, by: string, to: [string, string] | null, status = "todo", planId = "") => {
    const t = svc.createTask({ chatId, title, assigneeType: to?.[0] ?? "", assigneeId: to?.[1] ?? "", planId, createdBy: by });
    if (status !== "todo") svc.updateTask(t.id, { status });
    return t.id as string;
  };
  const steps = [
    (ids.draft = task(launch, "Draft the landing page", me, ["agent", designer], "working", "plan_launch")),
    task(launch, "Review the copy", me, ["agent", writer], "checking", "plan_launch"),
    (ids.hero = task(launch, "Pick the hero image", me, ["agent", designer], "needs_you", "plan_launch")),
    (ids.publish = task(launch, "Publish the page", me, ["agent", designer], "todo", "plan_launch")),
  ];
  svc.insertMessage({ chatId: launch, authorType: "agent", authorId: designer, kind: "plan", body: "Launch plan", meta: { planId: "plan_launch", steps: steps.map((s) => svc.task(s)) } });
  svc.setTaskProgress(ids.draft, "Step 3 of 8");
  ids.budget = task(launch, "Approve the budget", designer, ["user", me], "needs_you");
  ids.venue = task(launch, "Book the venue", me, ["user", me]);
  ids.email = task(launch, "Write the launch email", me, ["agent", writer], "done");
  ids.research = task(launch, "Collect the interviews", me, ["agent", researcher], "done");
  ids.notes = task(app, "Write the release notes", writer, ["user", people["Person C"]]);
  task(app, "Set up the repo", me, ["user", me], "done");
  // Person C's own chat: the owner, an admin, isn't in it, and the board has no admin override
  const c = new Client(h.url);
  assert.equal((await c.post("/api/login", { email: "person-c@example.com", password: "example-password-1" })).status, 200);
  const cOwn = (await c.post("/api/chats", { name: "person c notes" })).json.chat.id;
  ids.hidden = task(cOwn, "Person C's private task", people["Person C"], null);
  // a setting changed, a move to a cloud model, and a file on the task that opens
  assert.equal((await owner.put(`/api/tasks/${ids.draft}/settings`, { speed: "fast" })).status, 200);
  const sw = await fetch(`${gwUrl}/gateway/tasks/${ids.draft}/cloud-switch`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ n: 1, reason: "stalled" }) });
  assert.equal(sw.status, 201);
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode("# Brief\n\nThe landing page for Acme.\n")]), "brief.md");
  const up = await fetch(`${h.url}/api/tasks/${ids.draft}/files`, { method: "POST", headers: { origin: h.url, cookie: owner.cookie }, body: form });
  assert.equal(up.status, 200);
  const at = Date.now();
  (h.app.db.prepare("SELECT id FROM tasks ORDER BY created_at").all() as any[]).forEach((r, i) => h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at - (i * 23 + 2) * 60_000, r.id));

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1440,960"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
  await page.goto(h.url, { waitUntil: "networkidle0" });
  await page.waitForSelector("#em");
  await page.type("#em", "person-a@example.com");
  await page.type("#pw", "example-password-1");
  await page.click("button.btn.primary.lg");
  await waitText(page, /Chats/, "signed in");
});
after(async () => {
  await browser?.close();
  await new Promise<void>((r) => (gw ? gw.close(() => r()) : r()));
  await h?.close();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

test("clicking a card opens its task over the board, with the task's fields and the task in the address", async () => {
  await page.click('a[aria-label="Board"]');
  await page.waitForSelector(`[data-task="${ids.draft}"] .ts-cloud`);
  await openCard(ids.draft);
  assert.ok(page.url().includes("/board?task="), "still the board");
  assert.ok(await page.$(`[data-task="${ids.draft}"]`), "the board stays behind it");
  const label = await page.$eval(DIALOG, (e) => document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent ?? "");
  assert.equal(label, "Draft the landing page", "labelled by the task's title");
  await waitText(page, /brief\.md/, "the task's file");
  const t = await dialogText();
  for (const want of [/Step 3 of 8/, /Assignee\s*Designer/, /Agent\s*Designer/, /Chat\s*(PB\s*)?acme launch/, /Plan\s*Launch plan/, /Updated\s*\d+ min ago, Today \d\d:\d\d/, /Speed\s*Fast/, /Review\s*Quick/, /Cloud since \d\d:\d\d/, /Files/, /Attach/, /Open in chat/])
    assert.match(t, want);
  assert.match(t, /Comments\s*No comments yet\./, "the comments (e2e/task-comments.e2e.ts)");
  assert.equal(await statusValue(), "working");
  assert.deepEqual(await page.$$eval(`${DIALOG} select[aria-label="Status"] option`, (l) => l.map((o) => o.textContent)), ["In progress", "Cancel"], "an agent's task: Cancel only");
  assert.equal(await page.$eval(`${DIALOG} a.btn[href]`, (e) => e.getAttribute("href")), `/chats/${ids.launch}`);
  assert.ok(await page.$(`${DIALOG} button[aria-label^="Settings history"]`), "the settings history");
  assert.ok(!(await page.content()).includes("—"), "no em dashes in the UI");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways page scroll");
  await shot("desktop");
});

test("the focus stays inside, Back closes it, and the focus goes back to the card", async () => {
  assert.ok(await page.evaluate((sel) => document.querySelector(sel)!.contains(document.activeElement), DIALOG), "the focus starts inside");
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate((sel) => document.querySelector(sel)!.contains(document.activeElement), DIALOG), `Tab ${i + 1} stays inside`);
  }
  await page.keyboard.down("Shift");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  assert.ok(await page.evaluate((sel) => document.querySelector(sel)!.contains(document.activeElement), DIALOG), "Shift+Tab stays inside");
  await page.goBack();
  await waitClosed("Back closes it");
  assert.equal(taskInUrl(), "");
  assert.ok(page.url().endsWith("/board"));
  await waitFor(async () => (await focusedCard()) === ids.draft, "the focus is back on the card", 5000, 50);
  await page.goForward();
  await waitOpen("Forward opens it again");
});

test("Escape, a click outside and the close button close it, as a step back", async () => {
  await page.keyboard.press("Escape");
  await waitClosed("Escape");
  assert.equal(taskInUrl(), "");
  await page.goForward();
  await waitOpen("Forward after Escape opens it again: Escape was a step back");
  await page.keyboard.press("Escape");
  await waitClosed("Escape again");

  await openCard(ids.hero);
  await page.mouse.click(8, 480); // the overlay, left of the window
  await waitClosed("a click outside");
  assert.equal(taskInUrl(), "");
  assert.equal(await focusedCard(), ids.hero, "the focus goes back to the card");

  // the keyboard opens it too, and the close button closes it
  await page.focus(`[data-task="${ids.hero}"]`);
  await page.keyboard.press("Enter");
  await waitOpen("Enter on a card");
  assert.equal(taskInUrl(), ids.hero);
  await page.click(`${DIALOG} .modal-h button[aria-label="Close"]`);
  await waitClosed("the close button");
  assert.equal(taskInUrl(), "");
  await page.focus(`[data-task="${ids.hero}"]`);
  await page.keyboard.press(" ");
  await waitOpen("Space on a card");
  // Escape in the settings history closes that alone
  await page.click(`${DIALOG} button[aria-label^="Settings history"]`);
  await page.waitForSelector(".ts-history");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ts-history", { hidden: true });
  assert.ok(await isOpen(), "the task stays open");
  assert.equal(taskInUrl(), ids.hero);
  await page.keyboard.press("Escape");
  await waitClosed("then Escape closes the task");
});

test("a link with ?task= opens it, and closing leaves the board with its filters", async () => {
  await page.goto(`${h.url}/board?chat=${ids.launch}&task=${ids.publish}`, { waitUntil: "networkidle0" });
  await waitOpen("the link opens the task");
  assert.match(await dialogText(), /Publish the page/);
  await page.keyboard.press("Escape");
  await waitClosed("closed");
  assert.ok(page.url().endsWith(`/board?chat=${ids.launch}`), "the filters stay");
  // a done task older than the board's Done window still opens from a link
  const old = h.app.svc.createTask({ chatId: ids.launch, title: "An old finished task", createdBy: ids.me });
  h.app.svc.updateTask(old.id, { status: "done" });
  h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.now() - 30 * 86400_000, old.id);
  await page.goto(`${h.url}/board?task=${old.id}`, { waitUntil: "networkidle0" });
  await waitOpen("an old task's link");
  await waitFor(async () => /An old finished task/.test(await dialogText()), "the old task", 5000, 100);
  assert.equal(await columnOf(old.id), "", "not on the board itself");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("Open in chat goes to the task's chat, and Back comes back to the open task", async () => {
  await page.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
  await page.waitForSelector(`[data-task="${ids.draft}"]`);
  await openCard(ids.draft);
  await page.click(`${DIALOG} a.btn[href="/chats/${ids.launch}"]`);
  await waitFor(() => page.url().endsWith(`/chats/${ids.launch}`), "the chat", 5000, 50);
  await page.goBack();
  await waitOpen("back on the board, the task open");
  assert.equal(taskInUrl(), ids.draft);
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("a status change in the window moves the card behind it, and a refused one goes back", async () => {
  await openCard(ids.venue);
  assert.equal(await columnOf(ids.venue), "todo");
  assert.equal(await page.$$eval(`${DIALOG} select[aria-label="Status"] option`, (l) => l.length), 6, "a person's task: all six statuses");
  await page.select(`${DIALOG} select[aria-label="Status"]`, "working");
  await waitColumn(ids.venue, "progress", "the card moves behind the window");
  assert.ok(await isOpen(), "the window stays open");
  await waitFor(() => h.app.svc.task(ids.venue).status === "working", "saved", 5000, 50);

  await page.setRequestInterception(true);
  const refuse = (r: any) => (r.method() === "PATCH" && r.url().includes("/api/tasks/") ? r.respond({ status: 404, contentType: "application/json", body: '{"error":"no such task"}' }) : r.continue());
  page.on("request", refuse);
  try {
    await page.select(`${DIALOG} select[aria-label="Status"]`, "done");
    await waitText(page, /No such task/, "the error shows");
    await waitFor(async () => (await statusValue()) === "working", "the window's status goes back", 10_000, 100);
    await waitColumn(ids.venue, "progress", "the card goes back");
    assert.equal(h.app.svc.task(ids.venue).status, "working");
  } finally {
    page.off("request", refuse);
    await page.setRequestInterception(false);
  }
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

const lastMessage = (chatId: string) => h.app.db.prepare("SELECT author_type, author_id, body FROM messages WHERE chat_id = ? AND kind = 'text' AND author_type = 'user' ORDER BY ts DESC LIMIT 1").get(chatId) as any;

test("a task an agent runs: Cancel only, an Answer box when it needs you, Reopen once finished", async () => {
  // needs you: the answer goes to the chat, to the agent; the status stays the agent's
  await openCard(ids.hero);
  assert.deepEqual(await page.$$eval(`${DIALOG} select[aria-label="Status"] option`, (l) => l.map((o) => o.textContent)), ["Needs you", "Cancel"]);
  assert.match(await dialogText(), /Designer runs this task: answer it below, or cancel it[.]/);
  await page.type(`${DIALOG} .bt-answer textarea`, "Use the photo with the blue sky.");
  await waitFor(async () => !(await page.$(".toast")), "the last test's toast fades", 10_000, 200);
  await shot("answer");
  await page.click(`${DIALOG} .bt-answer button`);
  await waitFor(() => lastMessage(ids.launch)?.body === "@designer Use the photo with the blue sky.", "the answer in the chat", 10_000, 100);
  assert.equal(lastMessage(ids.launch).author_id, ids.me, "from the person");
  await waitFor(async () => /Sent to the chat[.]/.test(await dialogText()), "it says so", 5000, 100);
  assert.equal(h.app.svc.task(ids.hero).status, "needs_you", "the person didn't move it");
  await page.keyboard.press("Escape");
  await waitClosed("closed");

  // finished: no status menu, Reopen in its place, and the agent is asked to redo it
  await openCard(ids.email);
  assert.equal(await page.$$(`${DIALOG} select[aria-label="Status"]`).then((l) => l.length), 0, "no status menu");
  assert.equal(await page.$$(`[data-task="${ids.email}"] select.board-status`).then((l) => l.length), 0, "none on the card either");
  await page.click(`${DIALOG} button[aria-label^="Reopen"]`);
  await waitFor(() => h.app.svc.task(ids.email).status === "todo", "back to To do", 10_000, 100);
  await waitFor(() => lastMessage(ids.launch)?.body === '@writer Reopened by Person A: please redo "Write the launch email".', "the message to the agent", 10_000, 100);
  await waitColumn(ids.email, "todo", "the card moves behind the window");
  await waitFor(async () => (await statusValue().catch(() => "")) === "todo", "the window shows the menu again", 10_000, 100);
  await page.keyboard.press("Escape");
  await waitClosed("closed");

  // an agent a program drives, whose program can't redo work: said plainly, nothing changes
  await openCard(ids.research);
  await page.click(`${DIALOG} button[aria-label^="Reopen"]`);
  await waitFor(async () => /Researcher can't redo a finished task[.] Ask in the chat for a new run[.]/.test(await dialogText()), "the plain sentence", 10_000, 100);
  assert.equal(h.app.svc.task(ids.research).status, "done");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("live: a change on the server reaches the open task, and an archived one says not found", async () => {
  await openCard(ids.publish);
  h.app.svc.setTaskProgress(ids.publish, "Step 1 of 4");
  await waitFor(async () => /Step 1 of 4/.test(await dialogText()), "the progress line, live", 10_000, 100);
  h.app.svc.updateTask(ids.publish, { status: "needs_you" });
  await waitFor(async () => (await statusValue()) === "needs_you", "the status, live", 10_000, 100);
  await waitColumn(ids.publish, "needs_you", "the card moves too");
  assert.equal((await owner.post(`/api/tasks/${ids.publish}/archive`)).status, 200);
  await waitFor(async () => /Task not found/.test(await dialogText()), "archived: not found", 10_000, 100);
  assert.ok(!/Publish the page/.test(await dialogText()), "nothing of the task");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("a task id that doesn't exist, or a task in a chat the person can't see, says not found", async () => {
  for (const id of ["t_no_such_task", ids.hidden]) {
    await page.goto(`${h.url}/board?task=${id}`, { waitUntil: "networkidle0" });
    await waitOpen("the window opens");
    await waitFor(async () => /Task not found/.test(await dialogText()), `not found for ${id}`, 10_000, 100);
    const t = await text(page);
    assert.ok(!/Person C's private task|person c notes/.test(t), "nothing of the hidden task or its chat");
    assert.equal(await page.$$(`${DIALOG} select[aria-label="Status"]`).then((l) => l.length), 0, "no status menu");
    const [back] = await page.$$(`xpath/.//div[contains(@class,'modal-f')]//button[contains(., 'Back to the board')]`);
    await back.click();
    await waitClosed("closed");
    assert.equal(taskInUrl(), "");
  }
});

test("phone: the task is a full-screen sheet, with no sideways page scroll", async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${h.url}/board?task=${ids.draft}`, { waitUntil: "networkidle0" });
  await waitOpen("open on a phone");
  await waitFor(async () => /brief\.md/.test(await dialogText()), "loaded", 10_000, 100);
  await new Promise((r) => setTimeout(r, 200));
  const m = await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, page: document.documentElement.scrollWidth };
  }, DIALOG);
  assert.equal(m.x, 0);
  assert.equal(m.y, 0);
  assert.equal(Math.round(m.w), m.vw, "the full width");
  assert.equal(Math.round(m.h), m.vh, "the full height");
  assert.ok(m.page <= m.vw, `no sideways page scroll (${m.page} > ${m.vw})`);
  const wide = await page.$$eval(`${DIALOG} *`, (l) => l.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  assert.equal(wide, 0, "nothing inside runs past the screen");
  await shot("phone");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});
