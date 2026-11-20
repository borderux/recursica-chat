// SPDX-License-Identifier: AGPL-3.0-only
// People's uploads (server/src/uploads.ts): PDF, .txt and .md files on messages and tasks, checked
// by their bytes, stored like attach_files's, read by agents with read_file and by services, a PDF's
// text read in a separate container, deleted by the uploader or an admin. A stand-in reader takes
// the container's place here; the container's flags are checked on their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startApp, setupOwner, mockAgent, waitFor, Client, type Harness } from "./helpers.ts";
import { dockerArgs, readOutput, sniff, UPLOAD, Uploads, type RunResult } from "../server/src/uploads.ts";
import { serviceCommand } from "../server/src/serviceaccounts.ts";
import { setSetting } from "../server/src/db.ts";

const PASSWORD = "example-password-1";

/** A small PDF-shaped file: the stand-in reader reads its marker, the server checks only its first and last bytes. */
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << >> endobj\n%%EOF\n`);
const out = (pages: number, text: string, info = "", codes: [number, number] = [0, 0]) =>
  `Title: x\nPages:          ${pages}\n${info}==INFO-END ${codes[0]}\n${text}\n==TEXT-END ${codes[1]}\n`;
/** The stand-in reader: what each marker gives, as the container's output would. */
const fake = async (b: Buffer): Promise<RunResult> => {
  const m = /% (\S+)/.exec(b.toString("latin1"))?.[1] ?? "";
  if (m === "slow") return { code: null, stdout: "", timedOut: true };
  if (m === "nodocker") return { code: null, stdout: "", timedOut: false, failed: "spawn docker ENOENT" };
  if (m === "locked") return { code: 0, stdout: out(3, "", "Encrypted:      yes (print:no)\n", [0, 1]), timedOut: false };
  if (m === "broken") return { code: 0, stdout: "Syntax Error: Couldn't read xref table\n==INFO-END 1\n==TEXT-END 1\n", timedOut: false };
  if (m === "scan") return { code: 0, stdout: out(4, "\f\f\f"), timedOut: false };
  if (m === "long") return { code: 0, stdout: out(412, "Page one of a long report.\fPage two."), timedOut: false };
  return { code: 0, stdout: out(2, "The brief says the study covers Sundays.\fPersona: a busy parent who plans on the train."), timedOut: false };
};

async function setup() {
  const h = await startApp();
  h.app.uploads.runner = fake;
  const owner = await setupOwner(h);
  for (const [email, role] of [
    ["person-a@example.com", "member"],
    ["person-b@example.com", "member"],
  ])
    assert.equal((await owner.post("/api/users", { email, name: email.split("@")[0], password: PASSWORD, role })).status, 200);
  const signIn = async (email: string) => {
    const c = new Client(h.url);
    assert.equal((await c.post("/api/login", { email, password: PASSWORD })).status, 200);
    return c;
  };
  const a = await signIn("person-a@example.com");
  const b = await signIn("person-b@example.com");
  const designer = await mockAgent(owner, "designer");
  // a service drives the agent: a message becomes a request, as for a program that drives it, and no agent turn
  // runs on after a test
  serviceCommand(h.app.db, "service-create", ["example-service"]);
  serviceCommand(h.app.db, "service-drive", ["example-service", "designer"]);
  const token = serviceCommand(h.app.db, "service-token", ["example-service"]).stdout ?? "";
  const group = (await a.post("/api/chats", { name: "Group", agents: [designer.id] })).json.chat;
  return { h, owner, a, b, designer, group, token };
}
/** Uploads files with a multipart body, as a browser does. */
const upload = async (h: Harness, c: Client, path: string, files: { name: string; data: Buffer }[], body?: string) => {
  const form = new FormData();
  if (body !== undefined) form.append("body", body);
  for (const f of files) form.append("file", new Blob([new Uint8Array(f.data)]), f.name);
  const r = await fetch(h.url + path, { method: "POST", headers: { origin: h.url, cookie: c.cookie }, body: form });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
};

test("a file is what its bytes say, never its name", () => {
  assert.equal(sniff("brief.pdf", pdf("ok")), "pdf");
  assert.equal(sniff("notes.md", Buffer.from("# Notes\nÜmlauts are fine.\n")), "text");
  assert.equal(sniff("notes.txt", Buffer.from("plain")), "text");
  assert.throws(() => sniff("brief.pdf", Buffer.from("just text")), /brief\.pdf isn't a PDF/);
  assert.throws(() => sniff("brief.pdf", Buffer.from("%PDF-1.4 cut off")), /isn't a PDF/, "no %%EOF");
  assert.throws(() => sniff("notes.txt", pdf("ok").subarray(0, 8).fill(0, 5)), /isn't text: it has a NUL byte/);
  assert.throws(() => sniff("notes.txt", Buffer.from([0xc3, 0x28])), /isn't UTF-8 text/);
  assert.throws(() => sniff("notes.txt", Buffer.alloc(0)), /is empty/);
  assert.throws(() => sniff("tool.exe", Buffer.from("MZ")), /people upload PDF, \.txt and \.md files only/);
  assert.throws(() => sniff("page.html", Buffer.from("<script>")), /PDF, \.txt and \.md files only/);
});

test("the reader's output: the text, or one reason there is none", () => {
  const ok = readOutput({ code: 0, stdout: out(2, "Line one.  \f\fLine two."), timedOut: false });
  assert.deepEqual(ok, { state: "ok", reason: "", pages: 2, pagesRead: 2, text: "Line one.\n\nLine two." });
  assert.deepEqual(readOutput({ code: 0, stdout: out(412, "x"), timedOut: false }).reason, "the first 300 of 412 pages");
  assert.equal(readOutput({ code: 0, stdout: out(412, "x"), timedOut: false }).pagesRead, 300);
  const big = readOutput({ code: 0, stdout: out(1, "é".repeat(UPLOAD.textBytes)), timedOut: false });
  assert.ok(Buffer.byteLength(big.text) <= UPLOAD.textBytes && big.reason === "its first 2 MB of text");
  for (const [r, why] of [
    [{ code: null, stdout: "", timedOut: true }, "it took longer than 30 seconds to read"],
    [{ code: null, stdout: "", timedOut: false, failed: "spawn docker ENOENT" }, "the text reader isn't available"],
    [{ code: 0, stdout: out(3, "", "Encrypted:      yes (print:no)\n", [0, 1]), timedOut: false }, "it is encrypted"],
    [{ code: 0, stdout: "Syntax Error\n==INFO-END 1\n==TEXT-END 1\n", timedOut: false }, "it is damaged, or not a PDF the reader understands"],
    [{ code: 0, stdout: "garbage", timedOut: false }, "it is damaged, or not a PDF the reader understands"],
    [{ code: 0, stdout: out(4, " \f \f"), timedOut: false }, "it has no text in it, such as a scan"],
  ] as const)
    assert.deepEqual([readOutput(r as RunResult).state, readOutput(r as RunResult).reason], ["failed", why]);
});

test("the reader's container: no network, limited memory, CPU and processes, read-only, no capabilities, nobody", () => {
  const args = dockerArgs("cc-pdftext-x", "sha256:" + "a".repeat(64));
  const flag = (f: string) => args[args.indexOf(f) + 1];
  assert.deepEqual(args.slice(0, 5), ["run", "--rm", "-i", "--name", "cc-pdftext-x"]);
  assert.equal(flag("--network"), "none");
  assert.equal(flag("--memory"), "256m");
  assert.equal(flag("--memory-swap"), "256m", "no swap beyond the memory");
  assert.equal(flag("--cpus"), "1");
  assert.equal(flag("--pids-limit"), "64");
  assert.ok(args.includes("--read-only"));
  assert.equal(flag("--cap-drop"), "ALL");
  assert.equal(flag("--security-opt"), "no-new-privileges");
  assert.equal(flag("--user"), "65534:65534");
  assert.equal(flag("--entrypoint"), "/bin/sh");
  assert.ok(args.includes("sha256:" + "a".repeat(64)), "the image named, such as by its recorded ID");
  assert.match(args.at(-1)!, /pdftotext -l 300 -enc UTF-8/);
  const dockerfile = readFileSync(join(import.meta.dirname, "..", "images", "pdftext", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM alpine:[\d.]+@sha256:[0-9a-f]{64}$/m, "the official Alpine image, pinned by digest");
  assert.match(dockerfile, /^RUN apk add --no-cache poppler-utils && pdftotext -v && pdfinfo -v$/m, "poppler-utils only, from Alpine");
  assert.equal(dockerfile.match(/^(FROM|RUN|COPY|ADD)\b/gm)!.length, 2, "nothing else added");
});

test("a person uploads to a message: checked, stored like attach_files, the agents told, a PDF's text read in the container", async () => {
  const { h, a, designer, group } = await setup();
  try {
    const r = await upload(
      h,
      a,
      `/api/chats/${group.id}/files`,
      [
        { name: "brief.pdf", data: pdf("ok") },
        { name: "personas.md", data: Buffer.from("# Personas\n\nA busy parent who plans on the train.\n") },
      ],
      "The brief and personas for the study.",
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const m = r.json.message;
    assert.equal(m.body, "The brief and personas for the study.");
    assert.deepEqual(
      m.meta.files.map((f: any) => [f.name, f.text]),
      [
        ["brief.pdf", "pending"],
        ["personas.md", "ok"],
      ],
    );
    const ids = r.json.files.map((f: any) => f.id);
    const db = h.app.db;
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(ids[0]) as any;
    assert.equal(row.user_id, (await a.get("/api/me")).json.user.id, "the uploader");
    assert.equal(row.message_id, m.id);
    assert.ok(existsSync(join(h.dir, "files", ids[0])), "the bytes in data/files, as attach_files's");
    // what the agent gets names the files; the visible message doesn't carry those lines
    const d = db.prepare("SELECT text FROM service_requests WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").get(designer.id) as any;
    assert.match(
      d.text,
      /^The brief and personas for the study\.\n\nAttached:\n- brief\.pdf \(f_[\w-]+\), a PDF: its text is being read; read it with read_file\n- personas\.md \(f_[\w-]+\), text: read it with read_file$/,
    );

    await h.app.uploads.idle();
    const text = (await a.get(`/api/files/${ids[0]}/text`)).json;
    assert.deepEqual(
      [text.state, text.pages, text.text],
      ["ok", 2, "The brief says the study covers Sundays.\n\nPersona: a busy parent who plans on the train."],
    );
    const after = (await a.get(`/api/chats/${group.id}/messages`)).json.messages.find((x: any) => x.id === m.id);
    assert.equal(after.meta.files[0].text, "ok", "the message shows the text is read");
    const listed = (await a.get(`/api/files?chat=${group.id}`)).json.files;
    assert.deepEqual(
      listed.map((f: any) => [f.name, f.text.state]),
      [
        ["brief.pdf", "ok"],
        ["personas.md", "ok"],
      ],
    );
    const dl = await fetch(`${h.url}/api/files/${ids[0]}`, { headers: { cookie: a.cookie } });
    assert.equal(dl.headers.get("content-type"), "application/octet-stream");
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="brief\.pdf"/, "always a download");
  } finally {
    await h.close();
  }
});

test("a PDF the reader can't read keeps its file, with the reason; agents are told to ask for a text version", async () => {
  const { h, a, designer, group } = await setup();
  try {
    const cases = [
      ["slow.pdf", "slow", "it took longer than 30 seconds to read"],
      ["locked.pdf", "locked", "it is encrypted"],
      ["broken.pdf", "broken", "it is damaged, or not a PDF the reader understands"],
      ["scan.pdf", "scan", "it has no text in it, such as a scan"],
      ["away.pdf", "nodocker", "the text reader isn't available"],
    ];
    const r = await upload(
      h,
      a,
      `/api/chats/${group.id}/files`,
      cases.map(([name, marker]) => ({ name, data: pdf(marker) })),
    );
    await h.app.uploads.idle();
    const ctx = { agent: h.app.svc.agent(designer.id)!, chatId: group.id, requester: { type: "user" as const, id: "" } };
    for (const [k, f] of r.json.files.entries()) {
      const t = (await a.get(`/api/files/${f.id}/text`)).json;
      assert.deepEqual([t.state, t.reason], ["failed", cases[k][2]], f.name);
      assert.equal((await fetch(`${h.url}/api/files/${f.id}`, { headers: { cookie: a.cookie } })).status, 200, "the file stays");
      const said = await h.app.gateway.call("read_file", { id: f.id }, ctx);
      assert.equal(said.text, `${f.name}: no text could be read: ${cases[k][2]}. Ask the person who attached it for a text version, as a .txt or .md file.`);
    }
    const long = await upload(h, a, `/api/chats/${group.id}/files`, [{ name: "long.pdf", data: pdf("long") }]);
    await h.app.uploads.idle();
    assert.equal((await a.get(`/api/files/${long.json.files[0].id}/text`)).json.reason, "the first 300 of 412 pages");
  } finally {
    await h.close();
  }
});

test("read_file: an agent reads a file's text in chunks, waits for a PDF being read, and only in its own chats", async () => {
  const { h, a, owner, designer, group } = await setup();
  try {
    const writer = await mockAgent(owner, "writer");
    const notes = "x".repeat(UPLOAD.readChars + 50);
    const r = await upload(h, a, `/api/chats/${group.id}/files`, [
      { name: "notes.txt", data: Buffer.from(notes) },
      { name: "brief.pdf", data: pdf("ok") },
    ]);
    const [txt, brief] = r.json.files.map((f: any) => f.id);
    const ctx = (ag: any) => ({ agent: h.app.svc.agent(ag.id)!, chatId: group.id, requester: { type: "user" as const, id: "" } });
    const first = (await h.app.gateway.call("read_file", { id: txt }, ctx(designer))).text;
    assert.match(first, /^notes\.txt, characters 0–100000 of 100050\n\nx+\n\n\(more: read_file with from 100000\)$/);
    assert.match(
      (await h.app.gateway.call("read_file", { id: txt, from: 100000 }, ctx(designer))).text,
      /^notes\.txt, characters 100000–100050 of 100050\n\nx{50}$/,
    );
    // a PDF still being read: the tool waits for it
    assert.match((await h.app.gateway.call("read_file", { id: brief }, ctx(designer))).text, /^brief\.pdf, 2 pages, characters 0–\d+ of \d+\n\nThe brief says/);
    const outside = await h.app.gateway.call("read_file", { id: txt }, ctx(writer));
    assert.equal(outside.isError, true);
    assert.match(outside.text, /no file .* in a chat you are in/);
  } finally {
    await h.close();
  }
});

test("who uploads: a person in the chat, never in an archived chat; limits on size, count, task and space", async () => {
  const { h, a, b, owner, group } = await setup();
  try {
    const one = [{ name: "n.txt", data: Buffer.from("hi") }];
    assert.equal((await upload(h, b, `/api/chats/${group.id}/files`, one)).status, 403, "not in the chat");
    assert.equal((await upload(h, a, `/api/chats/c_none/files`, one)).status, 404);
    const lie = await upload(h, a, `/api/chats/${group.id}/files`, [{ name: "brief.pdf", data: Buffer.from("not a pdf") }]);
    assert.equal(lie.status, 400);
    assert.match(lie.json.error, /brief\.pdf isn't a PDF/);
    assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM files").get()!.n, 0, "nothing stored from a refused upload");
    const many = Array.from({ length: UPLOAD.messageFiles + 1 }, (_, k) => ({ name: `n${k}.txt`, data: Buffer.from("x") }));
    assert.match((await upload(h, a, `/api/chats/${group.id}/files`, many)).json.error, /at most 10 files at a time/);
    const big = await upload(h, a, `/api/chats/${group.id}/files`, [{ name: "big.txt", data: Buffer.alloc(UPLOAD.fileBytes + 1, 97) }]);
    assert.match(big.json.error, /big\.txt is over 10 MB/);
    const huge = await upload(
      h,
      a,
      `/api/chats/${group.id}/files`,
      [0, 1, 2].map((k) => ({ name: `h${k}.txt`, data: Buffer.alloc(9 * 1024 * 1024, 97) })),
    );
    assert.equal(huge.status, 413, "more than 25 MB, refused before it is read");

    const task = (await a.post("/api/tasks", { chatId: group.id, title: "Interview 1 of 1 — A made-up gadget" })).json.task;
    for (let k = 0; k < 5; k++)
      assert.equal(
        (
          await upload(
            h,
            a,
            `/api/tasks/${task.id}/files`,
            Array.from({ length: 10 }, (_, j) => ({ name: `t${k}-${j}.txt`, data: Buffer.from("x") })),
          )
        ).status,
        200,
      );
    assert.match((await upload(h, a, `/api/tasks/${task.id}/files`, one)).json.error, /a task holds at most 50 uploads/);
    const onTask = (await a.get(`/api/files?task=${task.id}`)).json.files;
    assert.equal(onTask.length, 50);
    assert.ok(
      onTask.every((f: any) => f.messageId === null && f.userId),
      "on the task alone, as the person's",
    );

    setSetting(h.app.db, "files_max_bytes", "10");
    assert.match(
      (await upload(h, a, `/api/chats/${group.id}/files`, [{ name: "more.txt", data: Buffer.from("more than ten bytes") }])).json.error,
      /file space is full/,
    );
    setSetting(h.app.db, "files_max_bytes", "0");

    await owner.post(`/api/chats/${group.id}/archive`, {});
    const archived = await upload(h, a, `/api/chats/${group.id}/files`, one);
    assert.equal(archived.status, 409);
    assert.match(archived.json.error, /archived/);
  } finally {
    await h.close();
  }
});

test("delete: the uploader their own, an admin any upload; nobody an agent's file, and the message drops it", async () => {
  const { h, a, b, owner, designer, group } = await setup();
  try {
    assert.equal((await a.post(`/api/chats/${group.id}/members`, { type: "user", id: (await b.get("/api/me")).json.user.id })).status, 200);
    const r = await upload(h, a, `/api/chats/${group.id}/files`, [
      { name: "one.txt", data: Buffer.from("1") },
      { name: "two.txt", data: Buffer.from("2") },
    ]);
    const [one, two] = r.json.files.map((f: any) => f.id);
    assert.equal((await b.del(`/api/files/${one}`)).status, 403, "another person's upload");
    const gone = await a.del(`/api/files/${one}`);
    assert.equal(gone.status, 200);
    assert.ok(!existsSync(join(h.dir, "files", one)), "its bytes too");
    assert.equal(h.app.db.prepare("SELECT COUNT(*) AS n FROM file_texts WHERE file_id = ?").get(one)!.n, 0, "and its text");
    const msg = (await a.get(`/api/chats/${group.id}/messages`)).json.messages.find((x: any) => x.id === r.json.message.id);
    assert.deepEqual(
      msg.meta.files.map((f: any) => f.name),
      ["two.txt"],
      "the message drops it",
    );
    assert.equal((await owner.del(`/api/files/${two}`)).status, 200, "an admin, any upload");
    const agents = await h.app.gateway.call(
      "attach_files",
      { files: [{ name: "a.txt", text: "x" }] },
      { agent: h.app.svc.agent(designer.id)!, chatId: group.id, requester: { type: "user", id: "" } },
    );
    const agentFile = /\((f_[\w-]+)\)/.exec(agents.text)![1];
    assert.equal((await owner.del(`/api/files/${agentFile}`)).status, 403, "an agent's file isn't an upload");
  } finally {
    await h.close();
  }
});

test("services: a request lists its message's files, and a file's text is read in the service's chats", async () => {
  const { h, a, designer, group, token } = await setup();
  try {
    const get = async (path: string) => (await fetch(h.url + path, { headers: { authorization: `Bearer ${token}` } })).json() as any;
    const r = await upload(
      h,
      a,
      `/api/chats/${group.id}/files`,
      [
        { name: "personas.md", data: Buffer.from("# Personas\n") },
        { name: "brief.pdf", data: pdf("ok") },
      ],
      "@designer two interviews, from these",
    );
    await h.app.uploads.idle();
    const req = (await get("/api/service/requests?state=pending,taken")).requests.at(-1);
    assert.equal(req.messageId, r.json.message.id);
    assert.deepEqual(
      req.files.map((f: any) => [f.name, f.text.state]),
      [
        ["personas.md", "ok"],
        ["brief.pdf", "ok"],
      ],
    );
    const t = await get(`/api/service/files/${r.json.files[1].id}/text`);
    assert.equal(t.text, "The brief says the study covers Sundays.\n\nPersona: a busy parent who plans on the train.");
    assert.deepEqual(await get("/api/service/files/f_none/text"), { error: "no such file" });
    assert.ok(designer.id);
  } finally {
    await h.close();
  }
});

test("a service's live request lists the files a person sent with the message: a .md, a .txt and a PDF", async () => {
  // The request reaches the service's socket while the message is posted. Each file must already be
  // on the message then: a service that reads the request at once must never see it without its files.
  const { h, a, group, token } = await setup();
  const ws = new WebSocket(h.url.replace("http", "ws") + "/ws/service", { headers: { authorization: `Bearer ${token}` } });
  const events: any[] = [];
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  try {
    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    await waitFor(() => events.find((e) => e.type === "hello"), "the service's hello");
    const cases = [
      { name: "notes.md", data: Buffer.from("# Notes\n\nA busy parent who plans on the train.\n"), text: "ok" },
      { name: "brief.txt", data: Buffer.from("The study covers Sundays.\n"), text: "ok" },
      { name: "paper.pdf", data: pdf("ok"), text: "pending" },
    ];
    for (const f of cases) {
      const r = await upload(h, a, `/api/chats/${group.id}/files`, [{ name: f.name, data: f.data }], `@designer one interview, from ${f.name}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const req = await waitFor(() => events.find((e) => e.type === "service_request" && e.request.messageId === r.json.message.id)?.request, `the request for ${f.name}`);
      assert.deepEqual(
        req.files.map((x: any) => [x.id, x.name, x.text.state]),
        [[r.json.files[0].id, f.name, f.text]],
        `${f.name}: the live request lists the file`,
      );
    }
    // the request a service lists later says the same, with the PDF's text read by now
    await h.app.uploads.idle();
    const listed = (await (await fetch(h.url + "/api/service/requests?state=pending,taken", { headers: { authorization: `Bearer ${token}` } })).json()) as any;
    assert.deepEqual(
      listed.requests.slice(-3).map((q: any) => q.files.map((x: any) => [x.name, x.text.state])),
      [[["notes.md", "ok"]], [["brief.txt", "ok"]], [["paper.pdf", "ok"]]],
    );
  } finally {
    ws.terminate();
    await h.close();
  }
});

test("a PDF left pending by a stop is read when the server starts again", async () => {
  const { h, a, designer, group } = await setup();
  try {
    let release!: () => void;
    h.app.uploads.runner = () => new Promise(() => (release = () => {}));
    const r = await upload(h, a, `/api/chats/${group.id}/files`, [{ name: "brief.pdf", data: pdf("ok") }]);
    const id = r.json.files[0].id;
    assert.equal((await a.get(`/api/files/${id}/text`)).json.state, "pending");
    // a new reader, as at the next start
    const again = new Uploads({ db: h.app.db, svc: h.app.svc, dataDir: h.dir });
    again.runner = fake;
    again.resume();
    await again.idle();
    assert.equal(again.text(id).state, "ok");
    assert.ok(release);
  } finally {
    await h.close();
  }
});
