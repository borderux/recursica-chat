// SPDX-License-Identifier: AGPL-3.0-only
// attach_files and the download route (server/src/files.ts): a safe copy from the agent's own work
// folder, the limits, zips in and out, files on a task, bundling an agent's own earlier files, the
// .md copy, downloads that are always attachments, and backups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, setupOwner, mockAgent, type Harness, type Client } from "./helpers.ts";
import { checkZip, makeZip, safeName, sweepFiles, transcriptMarkdown, LIMITS } from "../server/src/files.ts";
import { memberSession } from "../server/src/clisession.ts";
import { agentDirs } from "../server/src/agents/engines.ts";
import { setSetting } from "../server/src/db.ts";

const TRANSCRIPT =
  "SYNTHETIC: made up for a test.\nNo real person said any of this.\nA made-up gadget, interview 1 of 2, Researcher and Pat Example, 15 min\n\nResearcher  00:00:05\nHow do you use it *today*?\n\nPat Example  00:00:12\nMostly on Tuesdays.\n";

async function setup(): Promise<{
  h: Harness;
  c: Client;
  agent: any;
  chat: any;
  call: (args: any, agent?: any, chatId?: string) => Promise<{ text: string; isError: boolean }>;
  work: string;
}> {
  const h = await startApp();
  const c = await setupOwner(h);
  const agent = await mockAgent(c, "writer");
  const chat = (await c.post("/api/chats", { dmAgent: agent.id })).json.chat;
  const call = (args: any, a = agent, chatId = chat.id) =>
    h.app.gateway.call("attach_files", args, { agent: h.app.svc.agent(a.id)!, chatId, requester: { type: "user", id: "" } });
  return { h, c, agent, chat, call, work: agentDirs(h.dir, agent.id).work };
}
const lastFiles = async (c: Client, chatId: string) => {
  const msgs = (await c.get(`/api/chats/${chatId}/messages`)).json.messages as any[];
  return msgs.filter((m) => m.meta?.files).at(-1);
};
const download = (h: Harness, c: Client | null, fid: string, bearer?: string) =>
  fetch(`${h.url}/api/files/${fid}`, { headers: { ...(c?.cookie ? { cookie: c.cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });

test("names: a safe base name with an allowed type, never a type a browser runs", () => {
  assert.equal(safeName("../../etc/notes.txt"), "notes.txt");
  assert.equal(safeName("A made-up gadget — interview 1 of 2.txt"), "A made-up gadget - interview 1 of 2.txt");
  for (const bad of ["page.html", "logo.svg", "run.js", ".hidden.txt", "noext", ""]) assert.throws(() => safeName(bad), /needs a name ending in/, bad);
  assert.equal(safeName("x".repeat(150) + ".txt").length, 100);
});

test("the .md copy: the first paragraph as a heading, speakers in bold, the rest escaped", () => {
  const md = transcriptMarkdown(TRANSCRIPT);
  assert.match(md, /^# SYNTHETIC: made up for a test\.\n\n\*\*No real person said any of this\.\*\*\n\n\*\*A made-up gadget, interview 1 of 2/);
  assert.match(md, /\*\*Researcher\*\* 00:00:05  \nHow do you use it \\\*today\\\*\?/);
  assert.match(md, /\*\*Pat Example\*\* 00:00:12  \nMostly on Tuesdays\./);
});

test("text: the .txt exactly as written and a .md copy, on one message, downloaded only as attachments", async () => {
  const { h, c, chat, call } = await setup();
  try {
    const r = await call({ files: [{ name: "gadget-interview-1-of-2.txt", text: TRANSCRIPT, markdown: true }], note: "1 synthetic transcript." });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /gadget-interview-1-of-2\.txt \(f_\w+\), gadget-interview-1-of-2\.md \(f_\w+\)/);
    const m = await lastFiles(c, chat.id);
    assert.equal(m.body, "1 synthetic transcript.");
    assert.deepEqual(
      m.meta.files.map((f: any) => f.name),
      ["gadget-interview-1-of-2.txt", "gadget-interview-1-of-2.md"],
    );

    const txt = await download(h, c, m.meta.files[0].id);
    assert.equal(txt.status, 200);
    assert.equal(await txt.text(), TRANSCRIPT, "the .txt holds the text exactly as written");
    assert.equal(txt.headers.get("content-type"), "application/octet-stream");
    assert.match(
      txt.headers.get("content-disposition")!,
      /^attachment; filename="gadget-interview-1-of-2\.txt"; filename\*=UTF-8''gadget-interview-1-of-2\.txt$/,
    );
    assert.equal(txt.headers.get("x-content-type-options"), "nosniff");
    assert.equal(txt.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(txt.headers.get("cache-control"), "private, no-store");
    const md = await (await download(h, c, m.meta.files[1].id)).text();
    assert.equal(md, transcriptMarkdown(TRANSCRIPT));
  } finally {
    await h.close();
  }
});

test("downloads need a session and a person who can see the chat", async () => {
  const { h, c, chat, call } = await setup();
  try {
    await call({ files: [{ name: "a.txt", text: "hello" }] });
    const fid = (await lastFiles(c, chat.id)).meta.files[0].id;
    assert.equal((await download(h, null, fid)).status, 401);
    assert.equal((await c.post("/api/users", { email: "person-a@example.com", name: "Person A", role: "member" })).status, 200);
    const outsider = memberSession(h.app.db, "person-a@example.com", 5).token;
    assert.equal((await download(h, null, fid, outsider)).status, 404, "not in the chat: no such file");
    assert.equal((await fetch(`${h.url}/api/files`, { headers: { authorization: `Bearer ${outsider}` } }).then((r) => r.json())).files.length, 0);
    assert.equal((await download(h, c, "f_nothing")).status, 404);
  } finally {
    await h.close();
  }
});

test("a path: only a real file in the agent's own work folder, with no link on the way", async () => {
  const { h, c, chat, call, work } = await setup();
  try {
    mkdirSync(join(work, "out"), { recursive: true });
    writeFileSync(join(work, "out", "notes.txt"), "from the work folder\n");
    for (const path of ["out/notes.txt", "/home/agent/work/out/notes.txt", join(work, "out/notes.txt")]) {
      const r = await call({ files: [{ path }] });
      assert.equal(r.isError, false, `${path}: ${r.text}`);
    }
    const fid = (await lastFiles(c, chat.id)).meta.files[0].id;
    assert.equal(await (await download(h, c, fid)).text(), "from the work folder\n");
    writeFileSync(join(work, "out", "notes.txt"), "changed later\n");
    assert.equal(await (await download(h, c, fid)).text(), "from the work folder\n", "the server keeps its own copy");

    writeFileSync(join(h.dir, "secret.txt"), "server file");
    symlinkSync(join(h.dir, "secret.txt"), join(work, "link.txt"));
    symlinkSync(h.dir, join(work, "linkdir"));
    linkSync(join(h.dir, "secret.txt"), join(work, "hard.txt"));
    writeFileSync(join(work, "page.html"), "<script>1</script>");
    writeFileSync(join(work, "big.txt"), Buffer.alloc(LIMITS.fileBytes + 1));
    for (const [path, why] of [
      ["link.txt", /is a link/],
      ["linkdir/secret.txt", /goes through a link/],
      ["hard.txt", /more than one hard link/],
      ["../secret.txt", /outside your work folder/],
      ["out/../../secret.txt", /outside your work folder/],
      [join(h.dir, "secret.txt"), /outside your work folder/],
      ["/etc/hosts", /outside your work folder/],
      ["page.html", /needs a name ending in/],
      ["big.txt", /over 10 MB/],
      ["missing.txt", /does not exist/],
    ] as const) {
      const r = await call({ files: [{ path }] });
      assert.equal(r.isError, true, path);
      assert.match(r.text, why, path);
    }
  } finally {
    await h.close();
  }
});

test("zips: one made by the server, one from the work folder read and never unpacked, and the bad ones refused", async () => {
  const { h, c, chat, call, work } = await setup();
  try {
    const r = await call({
      files: [
        { name: "one.txt", text: "1" },
        { name: "two.txt", text: "2", markdown: true },
      ],
      zip: "set.zip",
    });
    assert.equal(r.isError, false, r.text);
    const m = await lastFiles(c, chat.id);
    assert.deepEqual(
      m.meta.files.map((f: any) => f.name),
      ["set.zip"],
    );
    const zip = Buffer.from(await (await download(h, c, m.meta.files[0].id)).arrayBuffer());
    assert.deepEqual(checkZip(zip), ["one.txt", "two.txt", "two.md"]);

    writeFileSync(join(work, "good.zip"), makeZip([{ name: "a.txt", data: Buffer.from("a") }]));
    assert.equal((await call({ files: [{ path: "good.zip" }] })).isError, false);

    const patched = (fn: (b: Buffer) => void, entries = [{ name: "a.txt", data: Buffer.from("a") }]) => {
      const b = makeZip(entries);
      fn(b);
      return b;
    };
    const cd = (b: Buffer) => b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const bad: [string, Buffer, RegExp][] = [
      ["encrypted", patched((b) => b.writeUInt16LE(0x0801, cd(b) + 8)), /encrypted/],
      ["a link", patched((b) => b.writeUInt32LE((0o120777 << 16) >>> 0, cd(b) + 38)), /is a link/],
      ["outside", makeZip([{ name: "../x.txt", data: Buffer.from("x") }]), /points outside/],
      ["a type", makeZip([{ name: "x.html", data: Buffer.from("x") }]), /not an allowed type/],
      ["nested", makeZip([{ name: "x.zip", data: Buffer.from("x") }]), /not an allowed type/],
      ["a bomb", patched((b) => b.writeUInt32LE(LIMITS.zipUnpackedBytes + 1, cd(b) + 24)), /unpacks to more than/],
      ["a ratio", patched((b) => b.writeUInt32LE(1_000_000, cd(b) + 24)), /over 100 times/],
      ["too many", makeZip(Array.from({ length: LIMITS.zipEntries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") }))), /more than 50 entries/],
      ["not a zip", Buffer.from("plain text"), /no table of contents/],
    ];
    for (const [what, buf, why] of bad) {
      writeFileSync(join(work, "bad.zip"), buf);
      const res = await call({ files: [{ path: "bad.zip" }] });
      assert.equal(res.isError, true, what);
      assert.match(res.text, why, what);
    }
  } finally {
    await h.close();
  }
});

test("a set on a task: one transcript per call, then a zip of the agent's own earlier files by id, never anyone else's", async () => {
  const { h, c, chat, call, agent } = await setup();
  try {
    const task = (await c.post("/api/tasks", { chatId: chat.id, title: "Two transcripts" })).json.task;
    const other = (await c.post("/api/tasks", { chatId: chat.id, title: "Another task" })).json.task;
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const r = await call({ files: [{ name: `gadget-interview-${n}-of-2.txt`, text: TRANSCRIPT, markdown: true }], task: task.id });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /to the message and the task/);
      ids.push(...[...r.text.matchAll(/\((f_\w+)\)/g)].map((x) => x[1]));
    }
    const listed = (await c.get(`/api/files?task=${task.id}`)).json.files;
    assert.equal(listed.length, 4);

    const history = await h.app.gateway.call(
      "chat_history",
      { limit: 10 },
      { agent: h.app.svc.agent(agent.id)!, chatId: chat.id, requester: { type: "user", id: "" } },
    );
    assert.match(history.text, new RegExp(`\\[files: gadget-interview-1-of-2\\.txt \\(${ids[0]}\\)`), "the agent can find its files' ids");

    const zipped = await call({ include: ids, zip: "gadget-transcripts.zip", task: task.id, note: "2 synthetic transcripts." });
    assert.equal(zipped.isError, false, zipped.text);
    const m = await lastFiles(c, chat.id);
    const zip = Buffer.from(await (await download(h, c, m.meta.files[0].id)).arrayBuffer());
    assert.deepEqual(checkZip(zip).sort(), [
      "gadget-interview-1-of-2.md",
      "gadget-interview-1-of-2.txt",
      "gadget-interview-2-of-2.md",
      "gadget-interview-2-of-2.txt",
    ]);
    assert.equal((await c.get(`/api/files?task=${task.id}`)).json.files.length, 5);

    // never another agent's file, another task's, or without a task and a zip
    const helper = await mockAgent(c, "helper");
    await c.post(`/api/chats/${chat.id}/members`, { type: "agent", id: helper.id });
    const theirs = await call({ files: [{ name: "theirs.txt", text: "x" }], task: task.id }, helper);
    const theirId = /\((f_\w+)\)/.exec(theirs.text)?.[1];
    const otherTask = await call({ files: [{ name: "else.txt", text: "x" }], task: other.id });
    const elseId = /\((f_\w+)\)/.exec(otherTask.text)?.[1];
    for (const [args, why] of [
      [{ include: [theirId], zip: "z.zip", task: task.id }, /not a file you attached in this task/],
      [{ include: [elseId], zip: "z.zip", task: task.id }, /not a file you attached in this task/],
      [{ include: [ids[0]], zip: "z.zip" }, /include needs task and zip/],
      [{ include: [ids[0]], task: task.id }, /include needs task and zip/],
      [{ files: [{ name: "a.txt", text: "x" }], task: "t_nothere" }, /no task t_nothere in this chat/],
    ] as const) {
      const r = await call(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, why);
    }
  } finally {
    await h.close();
  }
});

test("the limits: files and bytes a message, the workspace's space, and text types for text", async () => {
  const { h, call } = await setup();
  try {
    const many = Array.from({ length: LIMITS.messageFiles + 1 }, (_, i) => ({ name: `f${i}.txt`, text: "x" }));
    assert.match((await call({ files: many })).text, /at most 20 files/);
    const big = "x".repeat(9 * 1024 * 1024);
    assert.match(
      (
        await call({
          files: [
            { name: "a.txt", text: big },
            { name: "b.txt", text: big },
            { name: "c.txt", text: big },
          ],
        })
      ).text,
      /more than 25 MB/,
    );
    assert.match((await call({ files: [{ name: "a.pdf", text: "x" }] })).text, /text goes in a \.txt/);
    assert.match((await call({ files: [{ name: "a.md", text: "x", markdown: true }] })).text, /copy of a \.txt file only/);
    assert.match((await call({ files: [{ name: "a.txt", text: "x", path: "a.txt" }] })).text, /either text or path/);
    setSetting(h.app.db, "files_max_bytes", "10");
    assert.match((await call({ files: [{ name: "a.txt", text: "more than ten bytes" }] })).text, /file space is full/);
  } finally {
    await h.close();
  }
});

test("backups hold the attached files, and a stored file whose row is gone is swept", async () => {
  const { h, c, chat, call } = await setup();
  try {
    await call({ files: [{ name: "a.txt", text: "kept in the backup" }] });
    const fid = (await lastFiles(c, chat.id)).meta.files[0].id;
    const cli = join(import.meta.dirname, "..", "server", "src", "cli.ts");
    const env = { ...process.env, CIRCLECHAT_DATA: h.dir, CIRCLECHAT_MASTER_KEY: (h.app.cfg as any).masterKey };
    const backup = spawnSync("node", [cli, "backup"], { env, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(backup.status, 0, String(backup.stderr));
    const list = spawnSync("tar", ["-tzf", "-"], { input: backup.stdout, encoding: "utf8" });
    assert.match(list.stdout, new RegExp(`files/${fid}`));

    writeFileSync(join(h.dir, "files", "f_orphan"), "no row");
    assert.equal(sweepFiles(h.app.db, h.dir), 1);
    assert.ok(!existsSync(join(h.dir, "files", "f_orphan")));
    assert.ok(readdirSync(join(h.dir, "files")).includes(fid));
  } finally {
    await h.close();
  }
});
