// SPDX-License-Identifier: AGPL-3.0-only
// Files an agent attaches to a chat message, and to a task: the attach_files tool, the server's copy
// of each file, and the download route.
//
// - The agent passes a file's text, or a path in its own work folder. The server copies the bytes
//   into data/files/<id> (mode 600): later changes in the agent's folder never reach the copy.
// - A path stays inside the agent's work folder. No link is followed: a link anywhere on the path,
//   or a file with more than one hard link, is refused.
// - Limits: 10 MB a file, 20 files and 25 MB a message, and a total for the workspace (the
//   files_max_bytes setting, 1 GB by default). Only the types in TYPES; never a type a browser runs.
// - A zip from the agent's folder is read, never unpacked: its table of contents must list allowed
//   types only, with no links, no folders above, no encryption, and no zip bomb.
// - `zip` packs a call's files into one zip, and can bundle files the same agent attached earlier
//   by id (`include`): in the same task, or in another task of the same plan, such as a plan's last
//   step that bundles the set. Never another agent's, and never from outside the plan.
// - `join` makes one text file from text files, in order: the included files first, then the given
//   ones. Each part loses the blank lines at either end, and the parts are joined with one blank
//   line between them, and one newline at the end. With `markdown`, a .txt join also gets a .md copy. So a long document can be
//   written in parts, each part checked, and joined without being written out again.
// - `task_only` attaches the files to the task alone, with no message in the chat: the parts of a
//   document, say, that would crowd the chat. Such a file's message id is empty.
// - attachTaskText does the same for a service that drives the agent: one text file, and its .md
//   copy, on a task alone, as the agent's own, with the same checks. zipTaskFiles packs the agent's
//   files of a plan into one zip on a task, the same way. deleteTaskFile removes such a
//   file, on a task alone, for that service: a draft, say, once the finished file is there.
// - `markdown` on a .txt file also saves a .md copy with light formatting the server adds: the first
//   paragraph as a heading, and each speaker line's name in bold.
// - A download needs a session and a person who can see the chat. It is always served as an
//   attachment, as application/octet-stream, so a browser saves the file and never shows or runs it.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { Hono } from "hono";
import type { DB } from "./db.ts";
import { getSetting, now } from "./db.ts";
import { id } from "./crypto.ts";
import type { Services } from "./services.ts";
import type { CallContext, ToolDef } from "./gateway.ts";

export const LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  messageBytes: 25 * 1024 * 1024,
  messageFiles: 20,
  zipEntries: 50,
  zipUnpackedBytes: 50 * 1024 * 1024,
  zipRatio: 100,
  workspaceBytes: 1024 * 1024 * 1024,
};
/** The types a file may have, by extension. Never .html, .svg, .js or another type a browser runs. */
export const TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  vtt: "text/vtt",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  zip: "application/zip",
};
const TEXT_TYPES = new Set(["txt", "md", "csv", "json", "vtt"]);

const ready = new WeakSet<object>();
/** Creates the table once per database. */
export function fileTables(db: DB): void {
  if (ready.has(db)) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, task_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_task ON files(task_id);
CREATE INDEX IF NOT EXISTS files_chat ON files(chat_id);`);
  // A task-only file has no message. A table from before task_only has message_id NOT NULL:
  // rebuilt once, with every row kept.
  const col = (db.prepare("PRAGMA table_info(files)").all() as any[]).find((c) => c.name === "message_id");
  if (col?.notnull) {
    // SQLite's way to change a column: foreign keys off around the rebuild, then on again
    const fk = (db.prepare("PRAGMA foreign_keys").get() as any)?.foreign_keys;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec(`BEGIN;
CREATE TABLE files_new (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, task_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO files_new(id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at)
  SELECT id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX IF NOT EXISTS files_task ON files(task_id);
CREATE INDEX IF NOT EXISTS files_chat ON files(chat_id);
COMMIT;`);
    } finally {
      if (fk) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  ready.add(db);
}

/** A file refused for what it is: its name, type, size, or the space left. The message says why. */
export class FileRefusal extends Error {}
const fail = (msg: string): never => {
  throw new FileRefusal(msg);
};
const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

/** A file name that is safe to store and to offer: a base name of allowed characters with an allowed type. */
export function safeName(raw: unknown): string {
  const base = String(raw ?? "")
    .split(/[/\\]/)
    .pop()!
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim();
  const e = ext(base);
  if (!base || base.startsWith(".") || !e || !TYPES[e])
    fail(
      `"${String(raw ?? "").slice(0, 80)}" needs a name ending in ${Object.keys(TYPES)
        .map((t) => "." + t)
        .join(", ")}`,
    );
  if (base.length <= 100) return base;
  return base.slice(0, 100 - e.length - 1).trimEnd() + "." + e;
}

/**
 * Reads a file from the agent's work folder, following no link. `rel` is relative to the work
 * folder, or starts with the folder as the agent sees it in Docker (/home/agent/work/) or on the
 * server.
 */
export function readFromWork(work: string, rel: unknown): Buffer {
  let p = String(rel ?? "");
  if (!p || p.includes("\0")) fail("path is empty");
  for (const prefix of ["/home/agent/work/", work.replace(/\/?$/, "/")]) if (p.startsWith(prefix)) p = p.slice(prefix.length);
  if (p.startsWith("/")) fail(`${String(rel)} is outside your work folder`);
  const parts = posix
    .normalize(p)
    .split("/")
    .filter((s) => s && s !== ".");
  if (!parts.length || parts.includes("..")) fail(`${String(rel)} is outside your work folder`);
  // every folder on the way, the work folder included, is a real folder and never a link
  let at = work;
  for (const seg of ["", ...parts.slice(0, -1)]) {
    at = seg ? join(at, seg) : at;
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) fail(`${String(rel)} does not exist`);
    if (st!.isSymbolicLink() || !st!.isDirectory()) fail(`${String(rel)} goes through a link or a file, so it is refused`);
  }
  const file = join(at, parts[parts.length - 1]);
  const lst = lstatSync(file, { throwIfNoEntry: false });
  if (!lst) fail(`${String(rel)} does not exist`);
  if (lst!.isSymbolicLink()) fail(`${String(rel)} is a link, so it is refused`);
  if (!lst!.isFile()) fail(`${String(rel)} is not a file`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== lst!.ino || st.dev !== lst!.dev) fail(`${String(rel)} changed while it was read`);
    if (st.nlink !== 1) fail(`${String(rel)} has more than one hard link, so it is refused`);
    if (st.size > LIMITS.fileBytes) fail(`${String(rel)} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- zip
/** A zip of the files, stored without compression. */
export function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) fail(`two files are named ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt32LE(0, 10); // time and date
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(e.data.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain file, rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, end]);
}

/** Checks a zip's table of contents without unpacking anything. Returns the entry names, or throws. */
export function checkZip(buf: Buffer): string[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) ((eocd = i), (i = -1));
  if (eocd < 0) fail("the zip has no table of contents");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) fail("the zip is a ZIP64 archive, which is refused");
  if (count > LIMITS.zipEntries) fail(`the zip holds more than ${LIMITS.zipEntries} entries`);
  if (cdOff + cdSize > eocd) fail("the zip's table of contents is broken");
  const names: string[] = [];
  let unpacked = 0;
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail("the zip's table of contents is broken");
    const flags = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o170000;
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (flags & 1) fail(`${name} in the zip is encrypted`);
    if (mode === 0o120000) fail(`${name} in the zip is a link`);
    if (size === 0xffffffff) fail("the zip is a ZIP64 archive, which is refused");
    if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes(".."))
      fail(`${name} in the zip points outside the zip`);
    if (!name.endsWith("/")) {
      const e = ext(name);
      if (!TYPES[e] || e === "zip") fail(`${name} in the zip is not an allowed type`);
    }
    unpacked += size;
    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (unpacked > LIMITS.zipUnpackedBytes) fail(`the zip unpacks to more than ${LIMITS.zipUnpackedBytes / 1024 / 1024} MB`);
  if (unpacked > buf.length * LIMITS.zipRatio) fail("the zip unpacks to over 100 times its size");
  return names;
}

// ---------------------------------------------------------------- the .md copy
const SPEAKER = /^\s*(\S.*?)\s{2,}((?:\d{1,2}:)?[0-5]?\d:[0-5]\d)\s*$/;
const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, "\\$1");
/** A Markdown copy of a plain-text transcript: the first paragraph as a heading, speakers in bold. */
export function transcriptMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blank = lines.findIndex((l) => !l.trim());
  const head = lines.slice(0, blank < 0 ? lines.length : blank).filter((l) => l.trim());
  const out: string[] = [];
  if (head.length) {
    out.push(`# ${escapeMd(head[0].trim())}`);
    for (const l of head.slice(1)) out.push("", `**${escapeMd(l.trim())}**`);
    out.push("");
  }
  for (const l of lines.slice(blank < 0 ? lines.length : blank)) {
    const m = SPEAKER.exec(l);
    // two spaces end the line in Markdown, so the turn's text starts on the next line
    out.push(m ? `**${escapeMd(m[1])}** ${m[2]}  ` : escapeMd(l));
  }
  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

// ---------------------------------------------------------------- storage
export const filesDir = (dataDir: string) => join(dataDir, "files");

export function storeBlob(dataDir: string, data: Buffer): { id: string; sha256: string } {
  const dir = filesDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fid = id("f_");
  writeFileSync(join(dir, fid), data, { mode: 0o600, flag: "wx" });
  return { id: fid, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Removes stored files whose row is gone, such as those of a deleted chat. */
export function sweepFiles(db: DB, dataDir: string): number {
  fileTables(db);
  const dir = filesDir(dataDir);
  if (!existsSync(dir)) return 0;
  const known = new Set((db.prepare("SELECT id FROM files").all() as any[]).map((r) => r.id));
  let n = 0;
  for (const f of readdirSync(dir)) if (/^f_/.test(f) && !known.has(f)) (rmSync(join(dir, f), { force: true }), n++);
  return n;
}

export interface StoredFile {
  id: string;
  name: string;
  size: number;
}

/**
 * Joins text parts: each part without blank lines at either end, one blank line between parts, and
 * one newline at the end. Line ends become \n. A part with no text is left out.
 */
export function joinText(parts: string[]): string {
  const trimmed = parts.map((p) => {
    const lines = p.split(/\r?\n/);
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  });
  return trimmed.filter(Boolean).join("\n\n") + "\n";
}

// ---------------------------------------------------------------- the tool
interface Item {
  name: string;
  data: Buffer;
}

/** The attach_files tool, a core tool: it reads only the calling agent's own folder and files. */
export function attachFilesTool(deps: { db: DB; svc: Services; dataDir: string; workOf: (agentId: string) => string }): ToolDef {
  const { db, svc, dataDir } = deps;
  return {
    name: "attach_files",
    category: "core",
    description:
      "Attach files to a message in this chat, and to a task. Give each file's text with a name, or a path in your work folder. " +
      "markdown: true on a .txt file also attaches a .md copy. zip: a name packs every file into one zip. " +
      "join: a .txt or .md name makes one text file from the included files, then the given ones, in order; markdown: true with it also attaches a .md copy. " +
      "include: ids of files you attached earlier in this task or another task of the same plan, for the zip or the join. " +
      "task_only: true attaches to the task alone, with no message in the chat. Returns each file's id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", description: "file name with its type, such as notes.txt" },
              text: { type: "string", description: "the file's text" },
              path: { type: "string", description: "a file in your work folder, instead of text" },
              markdown: { type: "boolean", description: "with a .txt file: also attach a .md copy" },
            },
          },
        },
        include: { type: "array", items: { type: "string" }, description: "ids of files you attached earlier in this task or in another task of the same plan, for the zip or the join" },
        zip: { type: "string", description: "a name such as transcripts.zip: attach one zip holding every file" },
        join: { type: "string", description: "a name such as notes.txt: attach one text file joining the included files, then the given ones, in order" },
        markdown: { type: "boolean", description: "with join and a .txt name: also attach a .md copy of the joined file" },
        task_only: { type: "boolean", description: "with task: attach to the task alone, with no message in the chat" },
        task: { type: "string", description: "a task id in this chat, to attach the files to the task too" },
        note: { type: "string", description: "a short line to go with the files" },
      },
    },
    run: async (a: any, ctx: CallContext) => {
      fileTables(db);
      const files: any[] = Array.isArray(a.files) ? a.files : [];
      const include: string[] = Array.isArray(a.include) ? a.include.map(String) : [];
      if (!files.length && !include.length) fail("give files, or include with zip");
      let taskId = "";
      let planId = "";
      if (a.task) {
        const t = db.prepare("SELECT id, chat_id, plan_id FROM tasks WHERE id = ?").get(String(a.task)) as any;
        if (!t || t.chat_id !== ctx.chatId) fail(`there is no task ${String(a.task)} in this chat`);
        taskId = t.id;
        planId = t.plan_id ?? "";
      }
      if (a.zip && a.join) fail("give zip or join, not both");
      if (include.length && (!taskId || !(a.zip || a.join))) fail("include needs task, and zip or join: it bundles files you attached earlier in that task or its plan");
      if (a.task_only && !taskId) fail("task_only needs task");
      if (a.markdown && !a.join) fail("markdown on its own goes with join; for one file, set markdown on the file");
      if (a.join && files.some((f) => f?.markdown)) fail("with join, set markdown once, next to join");
      const items: Item[] = [];
      for (const f of files) {
        const hasText = typeof f?.text === "string";
        const hasPath = typeof f?.path === "string";
        if (hasText === hasPath) fail("each file needs either text or path");
        if (hasText) {
          const name = safeName(f.name);
          if (!TEXT_TYPES.has(ext(name))) fail(`${name}: text goes in a .txt, .md, .csv, .json or .vtt file`);
          const data = Buffer.from(f.text, "utf8");
          if (data.length > LIMITS.fileBytes) fail(`${name} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
          items.push({ name, data });
          if (f.markdown) {
            if (ext(name) !== "txt") fail(`${name}: markdown makes a copy of a .txt file only`);
            items.push({ name: name.replace(/\.txt$/i, ".md"), data: Buffer.from(transcriptMarkdown(f.text), "utf8") });
          }
        } else {
          if (f.markdown) fail("markdown works with text, not with a path");
          const data = readFromWork(deps.workOf(ctx.agent.id), f.path);
          const name = safeName(f.name ?? f.path);
          if (ext(name) === "zip") checkZip(data);
          items.push({ name, data });
        }
      }
      // the included files come first, in the order given, then the given ones
      const included: Item[] = [];
      const inPlan = (tid: string) => !!planId && (db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(tid) as any)?.plan_id === planId;
      for (const fid of include) {
        const r = db.prepare("SELECT id, name, agent_id, task_id, chat_id FROM files WHERE id = ?").get(fid) as any;
        if (!r || r.agent_id !== ctx.agent.id || r.chat_id !== ctx.chatId || !(r.task_id === taskId || inPlan(r.task_id)))
          fail(`${fid} is not a file you attached in this task or its plan`);
        included.push({ name: r.name, data: readFileSync(join(filesDir(dataDir), r.id)) });
      }
      items.unshift(...included);
      let out: Item[] = items;
      if (a.join) {
        const name = safeName(a.join);
        if (!["txt", "md"].includes(ext(name))) fail(`${name}: join makes a .txt or .md file`);
        if (!items.length) fail("join needs files to join");
        for (const it of items) if (!TEXT_TYPES.has(ext(it.name))) fail(`${it.name}: join takes text files only`);
        const text = joinText(items.map((it) => it.data.toString("utf8")));
        out = [{ name, data: Buffer.from(text, "utf8") }];
        if (a.markdown) {
          if (ext(name) !== "txt") fail(`${name}: markdown makes a copy of a .txt file only`);
          out.push({ name: name.replace(/\.txt$/i, ".md"), data: Buffer.from(transcriptMarkdown(text), "utf8") });
        }
      }
      if (a.zip) {
        const name = safeName(a.zip);
        if (ext(name) !== "zip") fail(`${name}: zip needs a name ending in .zip`);
        const used = new Map<string, number>();
        const unique = items.map((it) => {
          const n = used.get(it.name) ?? 0;
          used.set(it.name, n + 1);
          return { name: n ? it.name.replace(/(\.[^.]+)$/, ` (${n + 1})$1`) : it.name, data: it.data };
        });
        out = [{ name, data: makeZip(unique) }];
      }
      if (out.length > LIMITS.messageFiles) fail(`a message holds at most ${LIMITS.messageFiles} files`);
      const total = out.reduce((n, it) => n + it.data.length, 0);
      if (out.some((it) => it.data.length > LIMITS.fileBytes)) fail(`a file is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
      if (total > LIMITS.messageBytes) fail(`the files come to more than ${LIMITS.messageBytes / 1024 / 1024} MB`);
      ensureSpace(db, total);
      // unique names within the message
      const names = new Set<string>();
      for (const it of out) {
        let n = it.name;
        for (let i = 2; names.has(n); i++) n = it.name.replace(/(\.[^.]+)$/, ` (${i})$1`);
        names.add(n);
        it.name = n;
      }
      const blobs = out.map((it) => ({ ...it, ...storeBlob(dataDir, it.data) }));
      const stored: StoredFile[] = blobs.map((b) => ({ id: b.id, name: b.name, size: b.data.length }));
      const note = String(a.note ?? "")
        .trim()
        .slice(0, 500);
      const ins = db.prepare("INSERT INTO files(id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at) VALUES(?,?,?,?,?,?,?,?,?)");
      if (a.task_only) {
        for (const b of blobs) ins.run(b.id, ctx.chatId, null, taskId, ctx.agent.id, b.name, b.data.length, b.sha256, now());
        svc.updateTask(taskId, {}); // the task changed: views showing its files refresh
        return `Attached ${stored.map((f) => `${f.name} (${f.id})`).join(", ")} to the task only.`;
      }
      const msg = svc.insertMessage({
        chatId: ctx.chatId,
        authorType: "agent",
        authorId: ctx.agent.id,
        kind: "text",
        body: note || (stored.length === 1 ? `Attached ${stored[0].name}.` : `Attached ${stored.length} files.`),
        meta: { files: stored, ...(taskId ? { taskId } : {}) },
      });
      for (const b of blobs) ins.run(b.id, ctx.chatId, msg.id, taskId, ctx.agent.id, b.name, b.data.length, b.sha256, now());
      return `Attached ${stored.map((f) => `${f.name} (${f.id})`).join(", ")}${taskId ? ` to the message and the task` : ""}.`;
    },
  };
}

/** Refuses files that would take the workspace past its file space (the files_max_bytes setting). */
export function ensureSpace(db: DB, bytes: number): void {
  const cap = Number(getSetting(db, "files_max_bytes")) || LIMITS.workspaceBytes;
  const used = (db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files").get() as any).n as number;
  if (used + bytes > cap) fail("the workspace's file space is full. Ask an admin.");
}

/**
 * Attaches a text file to a task alone, with no message, as an agent's own, as attach_files does with
 * task_only: the same names, text types and limits, and with `markdown`, a .md copy of a .txt file.
 * For a service that drives the agent (drivenagents.ts). The caller checks the task and the agent.
 * Throws FileRefusal for a file that can't be attached.
 */
export function attachTaskText(deps: { db: DB; svc: Services; dataDir: string }, a: { chatId: string; taskId: string; agentId: string; name: unknown; text: string; markdown?: boolean }): StoredFile[] {
  const { db, svc, dataDir } = deps;
  fileTables(db);
  const name = safeName(a.name);
  if (!TEXT_TYPES.has(ext(name))) fail(`${name}: text goes in a .txt, .md, .csv, .json or .vtt file`);
  const items: Item[] = [{ name, data: Buffer.from(a.text, "utf8") }];
  if (a.markdown) {
    if (ext(name) !== "txt") fail(`${name}: markdown makes a copy of a .txt file only`);
    items.push({ name: name.replace(/\.txt$/i, ".md"), data: Buffer.from(transcriptMarkdown(a.text), "utf8") });
  }
  if (items.some((it) => it.data.length > LIMITS.fileBytes)) fail(`${name} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
  const total = items.reduce((n, it) => n + it.data.length, 0);
  if (total > LIMITS.messageBytes) fail(`the files come to more than ${LIMITS.messageBytes / 1024 / 1024} MB`);
  ensureSpace(db, total);
  const ins = db.prepare("INSERT INTO files(id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  const stored = items.map((it) => {
    const b = storeBlob(dataDir, it.data);
    ins.run(b.id, a.chatId, null, a.taskId, a.agentId, it.name, it.data.length, b.sha256, now());
    return { id: b.id, name: it.name, size: it.data.length };
  });
  svc.updateTask(a.taskId, {}); // the task changed: views showing its files refresh
  return stored;
}

/**
 * Packs files into one zip on a task alone, as an agent's own, as attach_files's zip does: for a
 * service that drives the agent, bundling the agent's files of the task's plan, such as the finished
 * transcripts of a set. Each file must be the agent's, in the task's chat, on the task or another task
 * of its plan; the caller checks the task and the agent. Same names and limits as attach_files.
 * Throws FileRefusal for a zip that can't be made.
 */
export function zipTaskFiles(deps: { db: DB; svc: Services; dataDir: string }, a: { chatId: string; taskId: string; agentId: string; name: unknown; include: unknown[] }): StoredFile {
  const { db, svc, dataDir } = deps;
  fileTables(db);
  const name = safeName(a.name);
  if (ext(name) !== "zip") fail(`${name}: a zip needs a name ending in .zip`);
  const ids = (Array.isArray(a.include) ? a.include : []).map(String);
  if (!ids.length) fail("include: the ids of the files to zip");
  if (ids.length > LIMITS.zipEntries) fail(`a zip holds at most ${LIMITS.zipEntries} files`);
  const planId = (db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(a.taskId) as any)?.plan_id ?? "";
  const inPlan = (tid: string) => tid === a.taskId || (!!planId && (db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(tid) as any)?.plan_id === planId);
  const items = ids.map((fid) => {
    const r = db.prepare("SELECT id, name, agent_id, task_id, chat_id FROM files WHERE id = ?").get(fid) as any;
    if (!r || r.agent_id !== a.agentId || r.chat_id !== a.chatId || !inPlan(r.task_id)) fail(`${fid} is not a file of the agent's in this task or its plan`);
    return { name: r.name as string, data: readFileSync(join(filesDir(dataDir), r.id)) };
  });
  const used = new Map<string, number>();
  const unique = items.map((it) => {
    const n = used.get(it.name) ?? 0;
    used.set(it.name, n + 1);
    return { name: n ? it.name.replace(/(\.[^.]+)$/, ` (${n + 1})$1`) : it.name, data: it.data };
  });
  const data = makeZip(unique);
  if (data.length > LIMITS.fileBytes) fail(`${name} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
  ensureSpace(db, data.length);
  const b = storeBlob(dataDir, data);
  db.prepare("INSERT INTO files(id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(b.id, a.chatId, null, a.taskId, a.agentId, name, data.length, b.sha256, now());
  svc.updateTask(a.taskId, {}); // the task changed: views showing its files refresh
  return { id: b.id, name, size: data.length };
}

/**
 * Deletes a file that sits on a task alone (no message), and its stored copy: a service tidying up
 * drafts its driven agent attached (drivenagents.ts). The caller checks whose file it is. A file on a
 * message is never deleted here: the message shows it.
 */
export function deleteTaskFile(deps: { db: DB; svc: Services; dataDir: string }, fileId: string): StoredFile {
  const { db, svc, dataDir } = deps;
  fileTables(db);
  const r = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as any;
  if (!r) fail(`no file ${fileId}`);
  if (r.message_id || !r.task_id) fail(`${r.name} is on a message, not on a task alone, so it stays`);
  db.prepare("DELETE FROM files WHERE id = ?").run(r.id);
  rmSync(join(filesDir(dataDir), r.id), { force: true });
  svc.updateTask(r.task_id, {}); // the task changed: views showing its files refresh
  return { id: r.id, name: r.name, size: r.size };
}

// ---------------------------------------------------------------- routes
/** The download and list routes. Register them after the session check. */
/** A file's record as the API returns it. */
export function fileJson(r: any) {
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    chatId: r.chat_id,
    messageId: r.message_id,
    taskId: r.task_id,
    agentId: r.agent_id,
    createdAt: r.created_at,
    // a person's upload, and its text's state (uploads.ts), when there is one
    userId: r.user_id ?? "",
    ...(r.text_state ? { text: { state: r.text_state, reason: r.text_reason ?? "", pages: r.text_pages ?? null } } : {}),
  };
}

/** The response that downloads a file the caller may see. */
export function fileDownload(c: any, dataDir: string, r: any) {
  const path = join(filesDir(dataDir), r.id);
  if (!existsSync(path)) return c.json({ error: "the file is missing from the server" }, 410);
  const ascii = r.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return c.body(readFileSync(path), 200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
  });
}

export function registerFiles(api: Hono<any>, db: DB, dataDir: string, sees: (user: any, chatId: string) => boolean): void {
  fileTables(db);
  sweepFiles(db, dataDir);
  const visible = (c: any, rows: any[]) => rows.filter((r) => sees(c.get("user"), r.chat_id));
  const out = fileJson;

  // the files on tasks the person can see, or on one task, or in one chat
  api.get("/api/files", (c) => {
    const task = c.req.query("task");
    const chat = c.req.query("chat");
    // with each upload's text state (uploads.ts)
    const sql = (where: string) =>
      `SELECT f.*, t.state AS text_state, t.reason AS text_reason, t.pages AS text_pages FROM files f LEFT JOIN file_texts t ON t.file_id = f.id WHERE ${where} ORDER BY f.created_at`;
    const rows = task ? db.prepare(sql("f.task_id = ?")).all(task) : chat ? db.prepare(sql("f.chat_id = ?")).all(chat) : db.prepare(sql("f.task_id != ''")).all();
    return c.json({ files: visible(c, rows as any[]).map(out) });
  });

  api.get("/api/files/:id", (c) => {
    const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
    if (!r || !sees(c.get("user"), r.chat_id)) return c.json({ error: "no such file" }, 404);
    return fileDownload(c, dataDir, r);
  });
}
