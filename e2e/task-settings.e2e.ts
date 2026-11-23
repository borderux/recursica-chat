// SPDX-License-Identifier: AGPL-3.0-only
// Per-task settings in the browser (web/src/ui/tasksettings.tsx): each card on the Board and each row
// on the Tasks screen shows its settings; the creator or an admin changes one from its menu, others
// see it read-only; a task moved to a cloud model shows "Cloud since ..."; the history opens from the
// card; and the phone layout. Generic settings and data only.
// Run: npm run build && node --test e2e/task-settings.e2e.ts
// TASK_SETTINGS_SHOTS=<dir> also saves the screenshots for docs/screenshots.
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

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.TASK_SETTINGS_SHOTS ?? "";
const KEY = "example-gateway-key-0123456789abcdef";
let h: Harness, browser: Browser, page: Page, gw: Server, gwUrl: string, keyDir: string;
const ids: Record<string, string> = {};

const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);
const card = (id: string) => `[data-task="${id}"]`;
const shot = async (p: Page, name: string) => {
  if (SHOTS) await p.screenshot({ path: join(SHOTS, `task-settings-${name}.png`) as `${string}.png` });
};
const signIn = async (p: Page, email: string) => {
  await p.goto(h.url, { waitUntil: "networkidle0" });
  await p.waitForSelector("#em");
  await p.type("#em", email);
  await p.type("#pw", "example-password-1");
  await p.click("button.btn.primary.lg");
  await waitText(p, /Chats/, "signed in");
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
  gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  const owner = new Client(h.url);
  assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
  const me = (await owner.get("/api/me")).json.user.id;
  const personB = (await owner.post("/api/users", { email: "person-b@example.com", name: "Person B", password: "example-password-1", role: "member" })).json.user.id;
  const agent = async (name: string, handle: string, style: string, colour: string) =>
    (await owner.post("/api/agents", { name, handle, engine: "mock", sandbox: "local", roleTitle: "Agent", style, colour })).json.agent.id as string;
  const designer = await agent("Designer", "designer", "twin", "mint");
  const writer = await agent("Writer", "writer", "halo", "lilac");
  const svc = h.app.svc;
  const launch = (await owner.post("/api/chats", { name: "acme launch", users: [personB], agents: [designer, writer] })).json.chat.id;
  ids.launch = launch;
  const task = (title: string, by: string, to: [string, string] | null, status = "todo", planId = "") => {
    const t = svc.createTask({ chatId: launch, title, assigneeType: to?.[0] ?? "", assigneeId: to?.[1] ?? "", planId, createdBy: by });
    if (status !== "todo") svc.updateTask(t.id, { status });
    return t.id as string;
  };
  const steps = [
    (ids.draft = task("Draft the landing page", me, ["agent", designer], "working", "plan_launch")),
    (ids.copy = task("Review the copy", me, ["agent", writer], "checking", "plan_launch")),
    (ids.hero = task("Pick the hero image", me, ["agent", designer], "needs_you", "plan_launch")),
    (ids.publish = task("Publish the page", me, ["agent", designer], "todo", "plan_launch")),
  ];
  svc.insertMessage({ chatId: launch, authorType: "agent", authorId: designer, kind: "plan", body: "Launch plan", meta: { planId: "plan_launch", steps: steps.map((s) => svc.task(s)) } });
  svc.setTaskProgress(ids.draft, "Step 3 of 8");
  ids.bTask = task("Book the venue", personB, ["user", personB]);
  task("Set up the repo", me, ["user", me], "done");
  // a few choices away from the default, by the owner
  assert.equal((await owner.put(`/api/tasks/${ids.copy}/settings`, { review: "thorough" })).status, 200);
  assert.equal((await owner.put(`/api/tasks/${ids.draft}/settings`, { speed: "fast" })).status, 200);
  // the gateway moved one task to a cloud model
  const sw = await fetch(`${gwUrl}/gateway/tasks/${ids.draft}/cloud-switch`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ n: 1, reason: "stalled" }) });
  assert.equal(sw.status, 201);
  const at = Date.now();
  (h.app.db.prepare("SELECT id FROM tasks ORDER BY created_at").all() as any[]).forEach((r, i) => h.app.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at - (i * 23 + 2) * 60_000, r.id));

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1440,960"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
  await signIn(page, "person-a@example.com");
});
after(async () => {
  await browser?.close();
  await new Promise<void>((r) => (gw ? gw.close(() => r()) : r()));
  await h?.close();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

test("the board shows each card's settings, and the cloud mark with its text", async () => {
  await page.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
  await page.waitForSelector(`${card(ids.draft)} .ts-cloud`);
  const mark = await page.$eval(`${card(ids.draft)} .ts-cloud`, (e) => ({ text: (e as HTMLElement).innerText, title: e.getAttribute("title") ?? "", label: e.getAttribute("aria-label") ?? "" }));
  assert.match(mark.text, /^Cloud since \d\d:\d\d$/);
  assert.match(mark.title, /^Draft the landing page moved to a cloud model at .+: the local models gave no answer for 15 minutes\.$/);
  assert.ok(mark.label.startsWith(mark.text) && mark.label.includes(mark.title), "the label carries the text");
  assert.equal(await page.$$eval(".ts-cloud", (l) => l.length), 1, "only the task that moved");
  const sel = (id: string, k: string) => page.$eval(`${card(id)} select[aria-label^="${k} of"]`, (e) => (e as HTMLSelectElement).value);
  assert.equal(await sel(ids.draft, "Speed"), "fast");
  assert.equal(await sel(ids.copy, "Review"), "thorough");
  assert.equal(await sel(ids.publish, "Speed"), "slow", "the default");
  // a done task: read-only chips
  const done = await page.$$eval("[data-col=done] .ts-chip:not(.ts-edit)", (l) => l.length);
  assert.ok(done >= 2, "a done task's settings are read-only");
  assert.ok(!(await page.content()).includes("—"), "no em dashes in the UI");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways page scroll");
  await shot(page, "desktop");
});

test("the creator or an admin changes a setting from its menu, without opening the chat; the history lists it", async () => {
  await page.select(`${card(ids.publish)} select[aria-label^="Speed of"]`, "fast");
  await waitFor(() => h.app.svc.task(ids.publish).settings.speed === "fast", "saved");
  assert.ok(page.url().endsWith("/board"), "the menu doesn't open the chat");
  await page.click(`${card(ids.publish)} button[aria-label^="Settings history"]`);
  await page.waitForSelector(".ts-history li");
  await waitText(page, /Speed: Slow to Fast/, "the change in the history");
  assert.match(await text(page), /@\S+, Today \d\d:\d\d/, "who and when");
  assert.ok(page.url().endsWith("/board"), "the history doesn't open the chat");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ts-history", { hidden: true });
  // the cloud task's history shows its cloud text too
  await page.click(`${card(ids.draft)} button[aria-label^="Settings history"]`);
  await waitText(page, /moved to a cloud model/, "the cloud text in the history");
  await shot(page, "history");
  await page.keyboard.press("Escape");
});

test("a refused change goes back", async () => {
  await page.setRequestInterception(true);
  const refuse = (r: any) => (r.method() === "PUT" && r.url().includes("/settings") ? r.respond({ status: 403, contentType: "application/json", body: '{"error":"Only the task\'s creator or an admin can change its settings"}' }) : r.continue());
  page.on("request", refuse);
  try {
    await page.select(`${card(ids.hero)} select[aria-label^="Review of"]`, "thorough");
    await waitText(page, /creator or an admin/, "the error shows");
    await waitFor(async () => (await page.$eval(`${card(ids.hero)} select[aria-label^="Review of"]`, (e) => (e as HTMLSelectElement).value)) === "quick", "back to quick");
    assert.equal(h.app.svc.task(ids.hero).settings.review, "quick");
  } finally {
    page.off("request", refuse);
    await page.setRequestInterception(false);
  }
});

test("another member sees the settings read-only, and their own task's as menus", async () => {
  const ctx = await browser.createBrowserContext();
  try {
    const p = await ctx.newPage();
    await p.setViewport({ width: 1440, height: 960 });
    await signIn(p, "person-b@example.com");
    await p.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
    await p.waitForSelector(`${card(ids.draft)} .ts-chip`);
    assert.equal(await p.$$eval(`${card(ids.draft)} select[aria-label^="Speed of"]`, (l) => l.length), 0, "no menu on the owner's task");
    const chip = await p.$eval(`${card(ids.draft)} .ts-chip`, (e) => ({ text: (e as HTMLElement).innerText, label: e.getAttribute("aria-label") ?? "" }));
    assert.match(chip.text, /Speed\s*Fast/);
    assert.match(chip.label, /creator or an admin/);
    assert.equal(await p.$$eval(`${card(ids.bTask)} select[aria-label^="Speed of"]`, (l) => l.length), 1, "a menu on their own task");
    assert.match((await p.$eval(`${card(ids.draft)} .ts-cloud`, (e) => e.getAttribute("title"))) ?? "", /moved to a cloud model/, "the cloud mark for everyone");
  } finally {
    await ctx.close();
  }
});

test("the Tasks screen's rows show the settings and the cloud mark", async () => {
  await page.goto(`${h.url}/tasks/${ids.launch}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".todo .ts-row");
  await waitText(page, /Cloud since \d\d:\d\d/, "the cloud mark on its row");
  assert.ok((await page.$$("xpath/.//li[contains(., 'Review the copy')]//select[starts-with(@aria-label, 'Review of')]")).length === 1);
  await page.select('.todo select[aria-label="Speed of Pick the hero image"]', "fast");
  await waitFor(() => h.app.svc.task(ids.hero).settings.speed === "fast", "saved from the Tasks screen");
  await shot(page, "tasks");
  // put it back, for the pictures
  await page.select('.todo select[aria-label="Speed of Pick the hero image"]', "slow");
  await waitFor(() => h.app.svc.task(ids.hero).settings.speed === "slow", "back to slow");
});

test("phone: the settings fit the card, with no sideways page scroll", async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${h.url}/board`, { waitUntil: "networkidle0" });
  await page.waitForSelector(`${card(ids.draft)} .ts-cloud`);
  // the In progress column, where the cloud mark is
  await page.evaluate((id) => document.querySelector(`[data-task="${id}"]`)!.closest("[data-col]")!.scrollIntoView({ inline: "start" }), ids.draft);
  await new Promise((r) => setTimeout(r, 300));
  const m = await page.evaluate((id) => {
    const c = document.querySelector(`[data-task="${id}"]`)!.getBoundingClientRect();
    const row = document.querySelector(`[data-task="${id}"] .ts-row`)!.getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, view: window.innerWidth, card: c.right, row: row.right };
  }, ids.draft);
  assert.ok(m.page <= m.view, `no sideways page scroll (${m.page} > ${m.view})`);
  assert.ok(m.row <= m.card + 0.5, "the settings stay inside the card");
  await shot(page, "phone");
});
