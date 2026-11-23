// SPDX-License-Identifier: AGPL-3.0-only
// The Board in the browser (web/src/screens/Board.tsx): columns, filters in the address, back and
// forward, drag and drop, the status menu, a refused move going back, live updates, and the phone
// layout with its filter sheet. Run: npm run build && node --test e2e/board.e2e.ts
// BOARD_SHOTS=<dir> also saves the screenshots for docs/screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startApp, Client, waitFor, type Harness } from "../test/helpers.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.BOARD_SHOTS ?? "";
let h: Harness, browser: Browser, page: Page;
const ids: Record<string, string> = {};

const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);
/** The column a task's card is in, or "" when it isn't on the board. */
const columnOf = (p: Page, id: string) => p.evaluate((id) => document.querySelector(`[data-task="${id}"]`)?.closest("[data-col]")?.getAttribute("data-col") ?? "", id);
const waitColumn = (p: Page, id: string, col: string, what: string) => waitFor(async () => (await columnOf(p, id)) === col, what, 10_000, 100);
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `board-${name}.png`) as `${string}.png` });
};

before(async () => {
  h = await startApp();
  const owner = new Client(h.url);
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
  const researcher = await agent("Researcher", "researcher", "curly", "sky");
  const svc = h.app.svc;
  const launch = (await owner.post("/api/chats", { name: "acme launch", users: [people["Person B"]], agents: [designer, writer] })).json.chat.id;
  const app = (await owner.post("/api/chats", { name: "example-app", users: [people["Person C"]], agents: [researcher] })).json.chat.id;
  const pair = svc.agentsChat(designer, writer);
  ids.launch = launch;
  ids.app = app;
  ids.designer = designer;

  const task = (chatId: string, title: string, by: string, to: [string, string] | null, status = "todo", planId = "") => {
    const t = svc.createTask({ chatId, title, assigneeType: to?.[0] ?? "", assigneeId: to?.[1] ?? "", planId, createdBy: by });
    if (status !== "todo") svc.updateTask(t.id, { status });
    return t.id as string;
  };
  const plan = (chatId: string, planId: string, title: string, by: string, steps: string[]) =>
    svc.insertMessage({ chatId, authorType: "agent", authorId: by, kind: "plan", body: title, meta: { planId, steps: steps.map((s) => svc.task(s)) } });
  const lp = [
    (ids.draft = task(launch, "Draft the landing page", designer, ["agent", designer], "working", "plan_launch")),
    task(launch, "Review the copy", designer, ["agent", writer], "checking", "plan_launch"),
    (ids.hero = task(launch, "Pick the hero image", designer, ["agent", designer], "needs_you", "plan_launch")),
    (ids.publish = task(launch, "Publish the page", designer, ["agent", designer], "todo", "plan_launch")),
  ];
  plan(launch, "plan_launch", "Launch plan", designer, lp);
  svc.setTaskProgress(ids.draft, "Step 3 of 8");
  const rp = [
    task(app, "Collect the changes", researcher, ["agent", researcher], "done", "plan_notes"),
    (ids.summary = task(app, "Write the summary", researcher, ["agent", researcher], "working", "plan_notes")),
    task(app, "Send the notes to Person C", researcher, ["user", people["Person C"]], "todo", "plan_notes"),
  ];
  plan(app, "plan_notes", "Release notes", researcher, rp);
  svc.setTaskProgress(ids.summary, "Section 2 of 5");
  ids.budget = task(launch, "Approve the budget", designer, ["user", me], "needs_you");
  task(launch, "Book the venue", people["Person B"], ["user", people["Person B"]], "cancelled");
  task(app, "Check the analytics", me, ["user", people["Person C"]]);
  task(pair, "Agree on the tone of voice", designer, ["agent", writer]);
  task(launch, "Set up the repo", me, ["user", me], "done");
  ids.old = task(app, "Clean up old drafts", me, ["user", me], "done");
  // spread the last updates out, and one done task past the 14-day window
  const at = Date.now();
  const rows = h.app.db.prepare("SELECT id FROM tasks ORDER BY created_at").all() as any[];
  rows.forEach((r, i) => h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at - (i * 37 + 3) * 60_000, r.id));
  h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at - 20 * 86400_000, ids.old);

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
  await h?.close();
});

test("the board shows every chat's tasks in four columns, from the rail", async () => {
  await page.click('a[aria-label="Board"]');
  await page.waitForSelector("[data-col=done] [data-task]");
  await waitText(page, /Launch plan[\s\S]*Release notes|Release notes[\s\S]*Launch plan/, "plan titles on the cards");
  const t = await text(page);
  for (const label of ["Needs you", "To do", "In progress", "Done"]) assert.ok(t.includes(label), label);
  assert.equal(await columnOf(page, ids.hero), "needs_you");
  assert.equal(await columnOf(page, ids.publish), "todo");
  assert.equal(await columnOf(page, ids.draft), "progress");
  assert.match(t, /Step 3 of 8/, "the progress line");
  assert.match(t, /Checking/, "a checking task's mark");
  assert.match(t, /Cancelled/, "a cancelled task's mark");
  assert.match(t, /Agree on the tone of voice/, "an agents-only chat's task");
  assert.equal(await columnOf(page, ids.old), "", "a done task older than 14 days is left out");
  assert.match(t, /Show all \(1 older\)/);
  assert.ok(!(await page.content()).includes("—"), "no em dashes in the UI");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(wide, "no sideways page scroll");
  await shot("desktop");
});

test("filters live in the address: reload and back and forward keep them", async () => {
  await page.select('select[aria-label="Chat"]', ids.app);
  await waitFor(() => page.url().includes(`chat=${ids.app}`), "chat in the address");
  await waitFor(async () => (await columnOf(page, ids.hero)) === "", "other chats' cards leave");
  assert.equal(await columnOf(page, ids.summary), "progress");
  await page.select('select[aria-label="Agent"]', ids.designer);
  await waitFor(() => page.url().includes(`agent=${ids.designer}`), "agent in the address");
  await waitFor(async () => (await columnOf(page, ids.summary)) === "", "no designer tasks in that chat");
  await page.goBack();
  await waitColumn(page, ids.summary, "progress", "back: the chat filter alone");
  assert.ok(!page.url().includes("agent="));
  await page.reload({ waitUntil: "networkidle0" });
  await waitColumn(page, ids.summary, "progress", "after a reload");
  assert.equal(await page.$eval('select[aria-label="Chat"]', (e) => (e as HTMLSelectElement).value), ids.app);
  await page.goForward();
  await waitFor(async () => (await columnOf(page, ids.summary)) === "", "forward: both filters again");
  await page.goto(`${h.url}/board?done=all`, { waitUntil: "networkidle0" });
  await waitColumn(page, ids.old, "done", "done=all shows the older done task");
  const [recent] = await page.$$("xpath/.//button[contains(., 'Last 14 days')]");
  await recent.click();
  await waitFor(() => !page.url().includes("done="), "the default stays out of the address");
});

test("a card moves by drag and drop, and by its status menu", async () => {
  await page.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
  await page.waitForSelector(`[data-task="${ids.publish}"]`);
  const drag = async (id: string, col: string) => {
    await page.evaluate((id) => {
      const dt = new DataTransfer();
      (window as any).__dt = dt;
      document.querySelector(`[data-task="${id}"]`)!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    }, id);
    await new Promise((r) => setTimeout(r, 50));
    await page.evaluate((col) => {
      const dst = document.querySelector(`[data-col="${col}"] .board-cards`)!;
      const dt = (window as any).__dt;
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, col);
  };
  await drag(ids.publish, "progress");
  await waitColumn(page, ids.publish, "progress", "dropped in In progress");
  await waitFor(() => h.app.svc.task(ids.publish).status === "working", "saved as working");
  await page.select(`[data-task="${ids.publish}"] select`, "done");
  await waitColumn(page, ids.publish, "done", "moved to Done by its menu");
  await waitFor(() => h.app.svc.task(ids.publish).status === "done", "saved as done");
  assert.ok(page.url().endsWith("/board"), "the menu doesn't open the chat");
});

test("a move the server refuses goes back", async () => {
  await page.setRequestInterception(true);
  const refuse = (r: any) => (r.method() === "PATCH" && r.url().includes("/api/tasks/") ? r.respond({ status: 404, contentType: "application/json", body: '{"error":"no such task"}' }) : r.continue());
  page.on("request", refuse);
  try {
    await page.select(`[data-task="${ids.budget}"] select`, "done");
    await waitText(page, /No such task/, "the error shows");
    await waitColumn(page, ids.budget, "needs_you", "back in Needs you");
    assert.equal(h.app.svc.task(ids.budget).status, "needs_you");
  } finally {
    page.off("request", refuse);
    await page.setRequestInterception(false);
  }
});

test("live: a change on the server moves the card, and a new task appears", async () => {
  h.app.svc.updateTask(ids.hero, { status: "todo" });
  await waitColumn(page, ids.hero, "todo", "moved live");
  const t = h.app.svc.createTask({ chatId: ids.launch, title: "A task added just now", createdBy: ids.designer });
  await waitColumn(page, t.id, "todo", "new task live");
});

test("clicking a card opens its chat", async () => {
  await page.click(`[data-task="${ids.draft}"] .board-card-t b`);
  await waitFor(() => page.url().endsWith(`/chats/${ids.launch}`), "the chat");
});

test("phone: the columns scroll sideways, and the filters sit in a sheet", async () => {
  // put the board back as it was seeded, for the screenshots
  h.app.svc.updateTask(ids.hero, { status: "needs_you" });
  h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.now() - 63 * 60_000, ids.hero);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-col=needs_you] [data-task]");
  const m = await page.evaluate(() => {
    const cols = document.querySelector(".board-cols")!;
    return { page: document.documentElement.scrollWidth, view: window.innerWidth, inner: cols.scrollWidth, box: cols.clientWidth };
  });
  assert.ok(m.page <= m.view, `no sideways page scroll (${m.page} > ${m.view})`);
  assert.ok(m.inner > m.box, "the board scrolls sideways itself");
  await shot("phone");
  const btn = await page.waitForSelector(".board-filter-btn", { visible: true });
  await btn!.click();
  await page.waitForSelector(".board-sheet select[aria-label=Chat]", { visible: true });
  await page.select(".board-sheet select[aria-label=Chat]", ids.launch);
  await waitFor(() => page.url().includes(`chat=${ids.launch}`), "the sheet's filter in the address");
  await shot("phone-filters");
  const [done] = await page.$$("xpath/.//div[contains(@class,'modal-f')]//button[contains(., 'Done')]");
  await done.click();
  await waitText(page, /Filters \(1\)/, "the button counts the filter");
});
