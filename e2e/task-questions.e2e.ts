// SPDX-License-Identifier: AGPL-3.0-only
// A question on a task in its window over the Board (web/src/ui/taskquestions.tsx; the server:
// server/src/taskcomments.ts): the card shows a Question mark while one waits; the window shows one
// real button per choice; a click (or Enter) answers at once, the buttons turn off under "Answered by",
// and the card's mark goes; someone else's question and answer arrive live; an answer that lost the race
// shows the server's reason and the list reloads; and on a phone the buttons wrap and stay 44px tall.
// Generic names and data only.
// Run: npm run build && node --test e2e/task-questions.e2e.ts
// TASK_QUESTIONS_SHOTS=<dir> also saves the screenshots for docs/screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startApp, Client, waitFor, type Harness } from "../test/helpers.ts";
import { addComment } from "../server/src/taskcomments.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.TASK_QUESTIONS_SHOTS ?? "";
let h: Harness, browser: Browser, page: Page, owner: Client;
const ids: Record<string, string> = {};

const DIALOG = '.overlay [role="dialog"][aria-modal="true"]';
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);
const isOpen = () => page.evaluate((sel) => !!document.querySelector(sel), DIALOG);
const waitOpen = (what: string) => waitFor(isOpen, what, 10_000, 100);
const waitClosed = (what: string) => waitFor(async () => !(await isOpen()), what, 10_000, 100);
const mark = (id: string) => page.evaluate((id) => document.querySelector(`[data-task="${id}"] .tq-mark`)?.textContent ?? "", id);
const Q = (qid: string) => `${DIALOG} [data-question="${qid}"]`;
const buttons = (qid: string) =>
  page.$$eval(`${Q(qid)} button`, (l) => l.map((b) => ({ text: (b as HTMLElement).innerText.trim(), disabled: (b as HTMLButtonElement).disabled, pressed: b.getAttribute("aria-pressed") })));
const state = (qid: string) => page.$eval(`${Q(qid)} .tq-state`, (e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim());
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `task-questions-${name}.png`) as `${string}.png` });
};
const ask = (tid: string, body: string, choices: { value: string; label: string }[], at = Date.now()) => addComment(h.app, tid, { type: "agent", id: ids.designer }, body, at, choices).id;
const NEXT = [
  { value: "write-again", label: "Write it again" },
  { value: "leave-out", label: "Leave it out" },
  { value: "stop-set", label: "Stop the set" },
];

before(async () => {
  h = await startApp();
  owner = new Client(h.url);
  assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
  const me = (await owner.get("/api/me")).json.user.id;
  const b = (await owner.post("/api/users", { email: "person-b@example.com", name: "Person B", password: "example-password-1", role: "member" })).json.user.id;
  const c = (await owner.post("/api/users", { email: "person-c@example.com", name: "Person C", password: "example-password-1", role: "member" })).json.user.id;
  const designer = (await owner.post("/api/agents", { name: "Designer", handle: "designer", engine: "mock", sandbox: "local", roleTitle: "Agent", style: "twin", colour: "mint" })).json.agent.id as string;
  const launch = (await owner.post("/api/chats", { name: "acme launch", users: [b, c], agents: [designer] })).json.chat.id;
  const svc = h.app.svc;
  Object.assign(ids, { me, b, c, designer });
  ids.draft = svc.createTask({ chatId: launch, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer, createdBy: me }).id;
  svc.updateTask(ids.draft, { status: "needs_you" });
  ids.venue = svc.createTask({ chatId: launch, title: "Book the venue", assigneeType: "user", assigneeId: b, createdBy: b }).id;
  const at = Date.now();
  addComment(h.app, ids.draft, { type: "agent", id: designer }, "The first two sections are done. The third one, **pricing**, failed its check twice.", at - 9 * 60_000);
  ids.q1 = ask(ids.draft, "What should I do with the pricing section?", NEXT, at - 8 * 60_000);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1440,960"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
  await page.goto(h.url, { waitUntil: "networkidle0" });
  await page.waitForSelector("#em");
  await page.type("#em", "person-b@example.com");
  await page.type("#pw", "example-password-1");
  await page.click("button.btn.primary.lg");
  await waitText(page, /Chats/, "signed in");
});
after(async () => {
  await browser?.close();
  await h?.close();
});

test("the card shows a Question mark, and the window one real button per choice", async () => {
  await page.click('a[aria-label="Board"]');
  await page.waitForSelector(`[data-task="${ids.draft}"]`);
  assert.equal(await mark(ids.draft), "Question", "the card's mark");
  assert.equal(await page.$eval(`[data-task="${ids.draft}"] .tq-mark`, (e) => e.getAttribute("aria-label")), "A question waits for an answer");
  assert.equal(await mark(ids.venue), "", "no mark with no question");
  await page.click(`[data-task="${ids.draft}"] .board-card-t b`);
  await waitOpen("the task opens");
  await page.waitForSelector(Q(ids.q1));
  assert.match(await page.$eval(`${DIALOG} [data-comment="${ids.q1}"]`, (e) => (e as HTMLElement).innerText), /What should I do with the pricing section\?/);
  assert.deepEqual(await buttons(ids.q1), [
    { text: "Write it again", disabled: false, pressed: null },
    { text: "Leave it out", disabled: false, pressed: null },
    { text: "Stop the set", disabled: false, pressed: null },
  ]);
  assert.equal(await page.$eval(`${Q(ids.q1)} [role="group"]`, (e) => e.getAttribute("aria-label")), "Choices");
  assert.equal(await page.$$eval(`${Q(ids.q1)} button`, (l) => l.filter((b) => b.tagName === "BUTTON" && (b as HTMLButtonElement).tabIndex === 0).length), 3, "real buttons, in tab order");
  assert.ok(!(await page.content()).includes("—"), "no em dashes in the UI");
});

test("the keyboard answers: Tab to a choice and Enter; then Answered by, the buttons off, the card's mark gone", async () => {
  await page.focus(`${Q(ids.q1)} button[data-choice="write-again"]`);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.choice), "leave-out", "Tab moves to the next choice");
  await page.keyboard.press("Enter");
  await waitFor(async () => /^Answered by/.test(await state(ids.q1)), "answered", 10_000, 100);
  assert.equal(await state(ids.q1), "Answered by @person-b: Leave it out");
  assert.deepEqual(await buttons(ids.q1), [
    { text: "Write it again", disabled: true, pressed: "false" },
    { text: "Leave it out", disabled: true, pressed: "true" },
    { text: "Stop the set", disabled: true, pressed: "false" },
  ]);
  const row = h.app.db.prepare("SELECT author_type, author_id, body, answer_to, choice FROM task_comments WHERE answer_to = ?").get(ids.q1) as any;
  assert.deepEqual({ ...row }, { author_type: "user", author_id: ids.b, body: "Leave it out", answer_to: ids.q1, choice: "leave-out" }, "stored once, as Person B's");
  await waitFor(async () => (await page.$$(`${DIALOG} .tc-item`)).length === 3, "the answer in the list", 10_000, 100);
  assert.equal(h.app.svc.task(ids.draft).status, "needs_you", "the task's status stays");
  await waitFor(async () => (await mark(ids.draft)) === "", "the card's mark goes, behind the window", 10_000, 100);
});

test("someone else's question and answer arrive live", async () => {
  ids.q2 = ask(ids.draft, "Should the headline stay short?", [
    { value: "short", label: "Keep it short" },
    { value: "long", label: "Use the long one" },
  ]);
  await page.waitForSelector(Q(ids.q2), { timeout: 10_000 });
  assert.deepEqual((await buttons(ids.q2)).map((b) => b.disabled), [false, false]);
  await waitFor(async () => (await mark(ids.draft)) === "Question", "the mark is back", 10_000, 100);
  await waitFor(async () => !(await page.$(".toast")), "no toast", 10_000, 200);
  await page.$eval(Q(ids.q2), (e) => e.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 200));
  await shot("desktop");
  assert.equal((await owner.post(`/api/tasks/${ids.draft}/comments/${ids.q2}/answer`, { choice: "short" })).status, 201);
  await waitFor(async () => (await state(ids.q2)) === "Answered by @person-a: Keep it short", "answered, live", 10_000, 100);
  assert.deepEqual((await buttons(ids.q2)).map((b) => b.disabled), [true, true]);
});

test("too late: the server's reason shows, and the list reloads", async () => {
  ids.q3 = ask(ids.draft, "Send it for review now?", [
    { value: "yes", label: "Yes" },
    { value: "no", label: "Not yet" },
  ]);
  await page.waitForSelector(Q(ids.q3), { timeout: 10_000 });
  // Person C answers with no event, as if it crossed with this click
  h.app.db.prepare("INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at, answer_to, choice) VALUES('tcm_race', ?, 'user', ?, 'Not yet', ?, ?, 'no')").run(ids.draft, ids.c, Date.now(), ids.q3);
  await page.click(`${Q(ids.q3)} button[data-choice="yes"]`);
  await waitFor(async () => /This question was answered already by Person C/.test((await page.$eval(".toast", (e) => (e as HTMLElement).innerText).catch(() => "")) as string), "the reason", 10_000, 100);
  await waitFor(async () => (await state(ids.q3)) === "Answered by @person-c: Not yet", "reloaded", 10_000, 100);
  assert.equal((h.app.db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE answer_to = ?").get(ids.q3) as any).n, 1, "still one answer");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("phone: the buttons wrap, stay at least 44px tall, and nothing runs past the screen", async () => {
  ids.q4 = ask(ids.venue, "The venue for 80 people has two dates. Which one?", [
    { value: "first-date", label: "Take the first date, the Friday afternoon" },
    { value: "second-date", label: "Take the second date" },
    { value: "ask-later", label: "Ask me again next week" },
  ]);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${h.url}/board?task=${ids.venue}`, { waitUntil: "networkidle0" });
  await waitOpen("open on a phone");
  await page.waitForSelector(Q(ids.q4), { timeout: 10_000 });
  await page.$eval(`${DIALOG} .tc`, (e) => e.scrollIntoView({ block: "start" }));
  await new Promise((r) => setTimeout(r, 200));
  const m = await page.$$eval(`${Q(ids.q4)} button`, (l) => l.map((b) => b.getBoundingClientRect()).map((r) => ({ h: r.height, top: r.top, right: r.right })));
  assert.ok(m.every((r) => r.h >= 44), `44px tall (${m.map((r) => r.h).join(", ")})`);
  assert.ok(new Set(m.map((r) => Math.round(r.top))).size > 1, "they wrap onto more than one line");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways page scroll");
  const wide = await page.$$eval(`${DIALOG} *`, (l) => l.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  assert.equal(wide, 0, "nothing inside runs past the screen");
  await shot("phone");
  await page.tap(`${Q(ids.q4)} button[data-choice="second-date"]`);
  await waitFor(async () => (await state(ids.q4)) === "Answered by @person-b: Take the second date", "answered on a phone", 10_000, 100);
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});
