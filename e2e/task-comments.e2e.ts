// SPDX-License-Identifier: AGPL-3.0-only
// A task's comments in its window over the Board (web/src/ui/taskcomments.tsx; the server:
// server/src/taskcomments.ts): the card shows a count; the window lists the comments oldest first, a
// person's as plain text and an agent's as Markdown, never as HTML; a new one posts and the card's
// count follows; one from someone else, and a delete, arrive live; only the author (or an admin)
// sees Delete, which asks once more; and on a phone it all fits the full-screen sheet. Generic names
// and data only.
// Run: npm run build && node --test e2e/task-comments.e2e.ts
// TASK_COMMENTS_SHOTS=<dir> also saves the screenshots for docs/screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startApp, Client, waitFor, type Harness } from "../test/helpers.ts";
import { addComment } from "../server/src/taskcomments.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.TASK_COMMENTS_SHOTS ?? "";
let h: Harness, browser: Browser, page: Page, owner: Client;
const ids: Record<string, string> = {};

const DIALOG = '.overlay [role="dialog"][aria-modal="true"]';
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, re: RegExp, what: string, ms = 20_000) => waitFor(async () => re.test(await text(p)), what, ms, 150);
const dialogText = () => page.$eval(DIALOG, (e) => (e as HTMLElement).innerText);
const isOpen = () => page.evaluate((sel) => !!document.querySelector(sel), DIALOG);
const waitOpen = (what: string) => waitFor(isOpen, what, 10_000, 100);
const waitClosed = (what: string) => waitFor(async () => !(await isOpen()), what, 10_000, 100);
const comments = () => page.$$eval(`${DIALOG} .tc-item .tc-main`, (l) => l.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
const cardCount = (id: string) => page.evaluate((id) => document.querySelector(`[data-task="${id}"] .tc-count`)?.textContent ?? "", id);
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `task-comments-${name}.png`) as `${string}.png` });
};
const openCard = async (id: string) => {
  await page.click(`[data-task="${id}"] .board-card-t b`);
  await waitOpen("the task opens");
};

before(async () => {
  h = await startApp();
  owner = new Client(h.url);
  assert.equal((await owner.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "example-password-1", workspace: "Acme" })).status, 200);
  const me = (await owner.get("/api/me")).json.user.id;
  const b = (await owner.post("/api/users", { email: "person-b@example.com", name: "Person B", password: "example-password-1", role: "member" })).json.user.id;
  const c = (await owner.post("/api/users", { email: "person-c@example.com", name: "Person C", password: "example-password-1", role: "member" })).json.user.id;
  const agent = async (name: string, handle: string, style: string, colour: string) =>
    (await owner.post("/api/agents", { name, handle, engine: "mock", sandbox: "local", roleTitle: "Agent", style, colour })).json.agent.id as string;
  const designer = await agent("Designer", "designer", "twin", "mint");
  const launch = (await owner.post("/api/chats", { name: "acme launch", users: [b, c], agents: [designer] })).json.chat.id;
  const svc = h.app.svc;
  ids.me = me;
  ids.b = b;
  ids.draft = svc.createTask({ chatId: launch, title: "Draft the landing page", assigneeType: "agent", assigneeId: designer, createdBy: me }).id;
  svc.updateTask(ids.draft, { status: "working" });
  ids.venue = svc.createTask({ chatId: launch, title: "Book the venue", assigneeType: "user", assigneeId: b, createdBy: b }).id;
  const at = Date.now();
  addComment(h.app, ids.draft, { type: "user", id: me }, "Use the blue palette from the brief, and keep the hero short.", at - 42 * 60_000);
  addComment(h.app, ids.draft, { type: "agent", id: designer }, "**First draft** is ready: three sections, with `brief.md` as the source.", at - 31 * 60_000);
  addComment(h.app, ids.draft, { type: "user", id: c }, "Looks good. <b>Not bold</b>, as typed.", at - 12 * 60_000);
  ids.cDraft = (h.app.db.prepare("SELECT id FROM task_comments WHERE author_id = ?").get(c) as any).id;

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--window-size=1440,960"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
  await page.goto(h.url, { waitUntil: "networkidle0" });
  await page.waitForSelector("#em");
  // Person B, a member: not an admin, so Delete shows only on their own comments
  await page.type("#em", "person-b@example.com");
  await page.type("#pw", "example-password-1");
  await page.click("button.btn.primary.lg");
  await waitText(page, /Chats/, "signed in");
});
after(async () => {
  await browser?.close();
  await h?.close();
});

test("the card shows the count, and the window lists the comments, oldest first, as text", async () => {
  await page.click('a[aria-label="Board"]');
  await page.waitForSelector(`[data-task="${ids.draft}"]`);
  assert.equal(await cardCount(ids.draft), "3", "the card's count");
  assert.equal(await page.$eval(`[data-task="${ids.draft}"] .tc-count`, (e) => e.getAttribute("aria-label")), "3 comments");
  assert.equal(await cardCount(ids.venue), "", "no count with no comments");
  await openCard(ids.draft);
  await waitFor(async () => (await comments()).length === 3, "three comments", 10_000, 100);
  const list = await comments();
  assert.match(list[0], /^@person-a 42 min ago Use the blue palette from the brief, and keep the hero short\.$/);
  assert.match(list[1], /^Designer 31 min ago First draft is ready: three sections, with brief\.md as the source\.$/);
  assert.match(list[2], /^@person-c 12 min ago Looks good\. <b>Not bold<\/b>, as typed\.$/);
  assert.equal(await page.$eval(`${DIALOG} [data-comment] .tc-body strong`, (e) => e.textContent), "First draft", "an agent's Markdown");
  assert.equal(await page.$$eval(`${DIALOG} .tc-body b`, (l) => l.length), 0, "no HTML from a person's text");
  assert.match(await dialogText(), /Comments 3/);
  assert.equal(await page.$$eval(`${DIALOG} .tc-del`, (l) => l.length), 0, "a member deletes only their own: none here");
  assert.ok(await page.$(`${DIALOG} textarea[aria-label="Add a comment"]`));
  assert.ok(!(await page.content()).includes("—"), "no em dashes in the UI");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways page scroll");
});

test("a new comment posts, and the card's count follows", async () => {
  await page.type(`${DIALOG} textarea[aria-label="Add a comment"]`, "The venue holds 80, so the page can say so.");
  await page.click(`${DIALOG} .tc-box button`);
  await waitFor(async () => (await comments()).length === 4, "the new comment", 10_000, 100);
  assert.match((await comments())[3], /just now The venue holds 80, so the page can say so\.$/);
  assert.equal(await page.$eval(`${DIALOG} textarea[aria-label="Add a comment"]`, (e) => (e as HTMLTextAreaElement).value), "", "the box empties");
  const row = h.app.db.prepare("SELECT author_type, author_id, body FROM task_comments ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.deepEqual({ ...row }, { author_type: "user", author_id: ids.b, body: "The venue holds 80, so the page can say so." });
  await waitFor(async () => (await cardCount(ids.draft)) === "4", "the card's count, behind the window", 10_000, 100);
  assert.equal(await page.$$eval(`${DIALOG} .tc-del`, (l) => l.length), 1, "Delete on their own");
  // Ctrl+Enter posts too; an empty box doesn't
  assert.equal(await page.$eval(`${DIALOG} .tc-box button`, (e) => (e as HTMLButtonElement).disabled), true, "empty: off");
  await page.type(`${DIALOG} textarea[aria-label="Add a comment"]`, "One more note.");
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await waitFor(async () => (await comments()).length === 5, "Ctrl+Enter", 10_000, 100);
  assert.equal((await owner.get(`/api/tasks/${ids.draft}/comments`)).json.comments.length, 5, "in the API");
});

test("someone else's comment and delete arrive live", async () => {
  assert.equal((await owner.post(`/api/tasks/${ids.draft}/comments`, { body: "Thanks, both." })).status, 201);
  await waitFor(async () => (await comments()).some((c) => /Thanks, both\.$/.test(c)), "the new comment, live", 10_000, 100);
  assert.equal((await owner.del(`/api/tasks/${ids.draft}/comments/${ids.cDraft}`)).status, 204, "an admin deletes Person C's");
  await waitFor(async () => (await comments())[2]?.endsWith("Comment deleted"), "deleted, live", 10_000, 100);
  assert.ok(!/Not bold/.test(await dialogText()), "nothing of its body");
  await waitFor(async () => (await cardCount(ids.draft)) === "5", "the card's count: 6 less the deleted one", 10_000, 100);
  await waitFor(async () => !(await page.$(".toast")), "no toast", 10_000, 200);
  await page.$eval(`${DIALOG} .tc-box`, (e) => e.scrollIntoView({ block: "end" }));
  await new Promise((r) => setTimeout(r, 200));
  await shot("desktop");
});

test("Delete asks once more, then the comment says Comment deleted", async () => {
  const mine = await page.$$eval(`${DIALOG} .tc-item`, (l) => l.filter((e) => e.querySelector(".tc-del")).map((e) => e.getAttribute("data-comment")));
  assert.equal(mine.length, 2, "their two comments");
  await page.click(`${DIALOG} [data-comment="${mine[1]}"] .tc-del`);
  await page.waitForSelector(`${DIALOG} [data-comment="${mine[1]}"] .tc-ask`);
  const [keep] = await page.$$(`xpath/.//li[@data-comment="${mine[1]}"]//button[contains(., 'Keep')]`);
  await keep.click();
  await page.waitForSelector(`${DIALOG} [data-comment="${mine[1]}"] .tc-ask`, { hidden: true });
  assert.equal((h.app.db.prepare("SELECT deleted_at FROM task_comments WHERE id = ?").get(mine[1]) as any).deleted_at, null, "Keep keeps it");
  await page.click(`${DIALOG} [data-comment="${mine[1]}"] .tc-del`);
  const [del] = await page.$$(`xpath/.//li[@data-comment="${mine[1]}"]//button[contains(., 'Delete')]`);
  await del.click();
  await waitFor(async () => /Comment deleted$/.test(await page.$eval(`${DIALOG} [data-comment="${mine[1]}"]`, (e) => (e as HTMLElement).innerText.trim())), "deleted", 10_000, 100);
  const row = h.app.db.prepare("SELECT body, deleted_by FROM task_comments WHERE id = ?").get(mine[1]) as any;
  assert.deepEqual({ ...row }, { body: "", deleted_by: ids.b }, "the body is gone from the table");
  await waitFor(async () => (await cardCount(ids.draft)) === "4", "the count drops", 10_000, 100);
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});

test("phone: the comments fit the full-screen sheet, with no sideways page scroll", async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${h.url}/board?task=${ids.draft}`, { waitUntil: "networkidle0" });
  await waitOpen("open on a phone");
  await waitFor(async () => (await comments()).length === 6, "loaded", 10_000, 100);
  await page.$eval(`${DIALOG} .tc`, (e) => e.scrollIntoView({ block: "start" }));
  await new Promise((r) => setTimeout(r, 200));
  const m = await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { w: r.width, vw: window.innerWidth, page: document.documentElement.scrollWidth };
  }, DIALOG);
  assert.equal(Math.round(m.w), m.vw, "the full width");
  assert.ok(m.page <= m.vw, `no sideways page scroll (${m.page} > ${m.vw})`);
  const wide = await page.$$eval(`${DIALOG} *`, (l) => l.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  assert.equal(wide, 0, "nothing inside runs past the screen");
  await shot("phone");
  await page.keyboard.press("Escape");
  await waitClosed("closed");
});
