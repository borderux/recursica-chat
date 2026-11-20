// SPDX-License-Identifier: AGPL-3.0-only
// People's uploads: PDF, .txt and .md files on a message or a task, and the text agents and services
// read from them.
//
// - Who: a person in the chat, as with posting; never in an archived chat. Everyone who sees the
//   chat sees the files. The uploader deletes their own uploads, and an admin any upload.
// - Limits: 10 MB a file, 10 files and 25 MB a message, 50 uploads a task, and the workspace's file
//   space (files_max_bytes). A PDF is read to its first 300 pages; the text kept is at most 2 MB.
// - A file is what its bytes say, never its name: a .pdf starts with %PDF- and ends with %%EOF; a
//   .txt or .md is UTF-8 with no NUL byte. A name that doesn't match its bytes is refused.
// - Storage is attach_files's: the bytes in data/files/<id>, mode 600, with their SHA-256, and a
//   files row with the uploader. The text is in the file_texts table. Backups and the export carry
//   both. A download is always an attachment, as for every file (files.ts).
// - The text: a .txt or .md is its own text. A PDF's text is read after the upload, one PDF at a
//   time, in a separate process: a container with no network, 256 MB of memory, one CPU, a read-only
//   file system, no capabilities, an unprivileged user, and 30 seconds. The server never parses a PDF.
//   The image is images/pdftext: Alpine's poppler-utils on the official Alpine image pinned by digest,
//   run by the image ID recorded when it was built (CIRCLECHAT_PDF_IMAGE). A PDF that can't be read keeps its file, with the reason: too
//   slow, encrypted, damaged, no text in it (a scan, say), or the reader unavailable. Agents are told
//   to ask for a text version. No OCR.
// - Agents read the text with the read_file tool, in chunks; a message with files tells them which
//   are attached. A service reads it at GET /api/service/files/:id/text (drivenagents.ts).
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import type { Services } from "./services.ts";
import type { CallContext, ToolDef } from "./gateway.ts";
import { fileTables, filesDir, FileRefusal, safeName, storeBlob, ensureSpace, type StoredFile } from "./files.ts";

export const UPLOAD = {
  fileBytes: 10 * 1024 * 1024,
  messageFiles: 10,
  messageBytes: 25 * 1024 * 1024,
  taskFiles: 50,
  pdfPages: 300,
  textBytes: 2 * 1024 * 1024,
  extractSeconds: 30,
  readChars: 100_000,
};

/**
 * The reader's image: images/pdftext, poppler-utils on the official Alpine image pinned by digest.
 * CIRCLECHAT_PDF_IMAGE names it, best by the image ID recorded when it was built; the tag otherwise.
 */
export const PDF_IMAGE = process.env.CIRCLECHAT_PDF_IMAGE || "circlechat/pdftext:latest";

export class UploadRefusal extends FileRefusal {}
const refuse = (msg: string): never => {
  throw new UploadRefusal(msg);
};

const ready = new WeakSet<object>();
export function uploadTables(db: DB): void {
  if (ready.has(db)) return;
  fileTables(db);
  const cols = (db.prepare("SELECT name FROM pragma_table_info('files')").all() as any[]).map((c) => c.name);
  if (!cols.includes("user_id")) db.exec("ALTER TABLE files ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS file_texts (
  file_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('pending','ok','failed')), reason TEXT NOT NULL DEFAULT '',
  pages INTEGER, pages_read INTEGER, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);`);
  ready.add(db);
}

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

/** What the bytes are, checked against the name: "pdf" or "text". Throws UploadRefusal with the reason. */
export function sniff(name: string, data: Buffer): "pdf" | "text" {
  const e = ext(name);
  if (!["pdf", "txt", "md"].includes(e)) refuse(`${name}: people upload PDF, .txt and .md files only`);
  if (!data.length) refuse(`${name} is empty`);
  if (e === "pdf") {
    const head = data.subarray(0, 1024).toString("latin1");
    const tail = data.subarray(Math.max(0, data.length - 1024)).toString("latin1");
    if (!head.startsWith("%PDF-") || !tail.includes("%%EOF")) refuse(`${name} isn't a PDF: its bytes don't start and end as a PDF's do`);
    return "pdf";
  }
  if (data.includes(0)) refuse(`${name} isn't text: it has a NUL byte, as a binary file does`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    refuse(`${name} isn't UTF-8 text`);
  }
  return "text";
}

// ---------------------------------------------------------------- reading a PDF's text
export interface RunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  /** The process couldn't start, such as no docker. */
  failed?: string;
}
export type Runner = (pdf: Buffer) => Promise<RunResult>;

const SCRIPT = `cat > /tmp/in.pdf && pdfinfo /tmp/in.pdf; echo "==INFO-END $?"; pdftotext -l ${UPLOAD.pdfPages} -enc UTF-8 -q /tmp/in.pdf - ; echo "==TEXT-END $?"`;

/** The container that reads a PDF: no network, 256 MB, one CPU, read-only, no capabilities, nobody, its own name. */
export function dockerArgs(name: string, image = PDF_IMAGE): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    SCRIPT,
  ];
}

/** Runs the reader in its container, with a time limit, and no more output than the text may hold. */
export function dockerRunner(image = PDF_IMAGE, docker = "docker"): Runner {
  return (pdf) =>
    new Promise((resolve) => {
      const name = `cc-pdftext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let out = "";
      let done = false;
      const p = spawn(docker, dockerArgs(name, image), { stdio: ["pipe", "pipe", "ignore"] });
      const finish = (r: RunResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const stop = () => {
        p.kill("SIGKILL");
        spawn(docker, ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
      };
      const timer = setTimeout(() => {
        stop();
        finish({ code: null, stdout: out, timedOut: true });
      }, UPLOAD.extractSeconds * 1000);
      p.on("error", (e) => finish({ code: null, stdout: "", timedOut: false, failed: e.message }));
      p.stdout.on("data", (d) => {
        out += d.toString("utf8");
        if (out.length > UPLOAD.textBytes * 2) stop();
      });
      p.on("close", (code) => finish({ code, stdout: out, timedOut: false }));
      p.stdin.on("error", () => {});
      p.stdin.end(pdf);
    });
}

/** The reader's output, as the text to keep, or the reason there is none. */
export function readOutput(r: RunResult): { state: "ok" | "failed"; reason: string; pages: number | null; pagesRead: number | null; text: string } {
  const fail = (reason: string) => ({ state: "failed" as const, reason, pages: null, pagesRead: null, text: "" });
  if (r.failed) return fail("the text reader isn't available");
  if (r.timedOut) return fail(`it took longer than ${UPLOAD.extractSeconds} seconds to read`);
  const info = /^([\s\S]*?)==INFO-END (\d+)\n([\s\S]*?)==TEXT-END (\d+)\s*$/.exec(r.stdout);
  if (!info) return fail("it is damaged, or not a PDF the reader understands");
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info[1])?.[1] ?? NaN);
  if (/^Encrypted:\s+yes/m.test(info[1])) return fail("it is encrypted");
  if (info[2] !== "0" || info[4] !== "0" || !Number.isFinite(pages)) return fail("it is damaged, or not a PDF the reader understands");
  let text = info[3]
    .replace(/\f/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text.replace(/\s/g, "")) return fail("it has no text in it, such as a scan");
  const notes: string[] = [];
  if (pages > UPLOAD.pdfPages) notes.push(`the first ${UPLOAD.pdfPages} of ${pages} pages`);
  if (Buffer.byteLength(text) > UPLOAD.textBytes) {
    text = Buffer.from(text).subarray(0, UPLOAD.textBytes).toString("utf8").replace(/�$/, "");
    notes.push(`its first ${UPLOAD.textBytes / 1024 / 1024} MB of text`);
  }
  return { state: "ok", reason: notes.join("; "), pages, pagesRead: Math.min(pages, UPLOAD.pdfPages), text };
}

// ---------------------------------------------------------------- the uploads
export interface UploadDeps {
  db: DB;
  svc: Services;
  dataDir: string;
}

export class Uploads {
  readonly deps: UploadDeps;
  /** The process that reads a PDF's text; a test puts a stand-in here. */
  runner: Runner = dockerRunner();
  #queue: string[] = [];
  #busy = false;
  #idle: (() => void)[] = [];

  constructor(deps: UploadDeps) {
    this.deps = deps;
    uploadTables(deps.db);
  }

  /** PDFs left pending by a stop are read again. */
  resume(): void {
    for (const r of this.deps.db.prepare("SELECT file_id FROM file_texts WHERE state = 'pending' ORDER BY updated_at").all() as any[]) this.#enqueue(r.file_id);
  }

  /**
   * Stores people's files: on a new message in the chat with `body`, or on a task alone. Checks every
   * file before storing any. Returns the files stored, and the message for a chat upload.
   */
  store(a: { chatId: string; userId: string; files: { name: string; data: Buffer }[]; taskId?: string; body?: string }): {
    stored: StoredFile[];
    message?: any;
  } {
    const { db, svc } = this.deps;
    const files = a.files.map((f) => ({ name: safeName(f.name), data: f.data }));
    if (!files.length) refuse("no file to upload");
    if (files.length > UPLOAD.messageFiles) refuse(`at most ${UPLOAD.messageFiles} files at a time`);
    for (const f of files) if (f.data.length > UPLOAD.fileBytes) refuse(`${f.name} is over ${UPLOAD.fileBytes / 1024 / 1024} MB`);
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > UPLOAD.messageBytes) refuse(`the files come to more than ${UPLOAD.messageBytes / 1024 / 1024} MB`);
    if (a.taskId) {
      const have = Number((db.prepare("SELECT COUNT(*) AS n FROM files WHERE task_id = ? AND user_id != ''").get(a.taskId) as any).n);
      if (have + files.length > UPLOAD.taskFiles) refuse(`a task holds at most ${UPLOAD.taskFiles} uploads`);
    }
    const kinds = files.map((f) => sniff(f.name, f.data));
    ensureSpace(db, total);
    const blobs = files.map((f) => ({ ...f, ...storeBlob(this.deps.dataDir, f.data) }));
    const stored: StoredFile[] = blobs.map((b) => ({ id: b.id, name: b.name, size: b.data.length }));
    let message: any;
    if (!a.taskId) {
      const body = String(a.body ?? "").slice(0, 20000);
      message = svc.post({
        chatId: a.chatId,
        authorType: "user",
        authorId: a.userId,
        body,
        meta: { files: stored.map((s, k) => ({ ...s, userId: a.userId, text: kinds[k] === "pdf" ? "pending" : "ok" })) },
        agentText: (body ? body + "\n\n" : "") + attachedLines(stored, kinds),
      });
    }
    const ins = db.prepare(
      "INSERT INTO files(id, chat_id, message_id, task_id, agent_id, name, size, sha256, created_at, user_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    const text = db.prepare("INSERT INTO file_texts(file_id, state, reason, pages, pages_read, text, updated_at) VALUES(?,?,?,?,?,?,?)");
    blobs.forEach((b, k) => {
      ins.run(b.id, a.chatId, message?.id ?? null, a.taskId ?? "", "", b.name, b.data.length, b.sha256, now(), a.userId);
      if (kinds[k] === "pdf") text.run(b.id, "pending", "", null, null, "", now());
      else {
        let t = b.data.toString("utf8");
        const cut = Buffer.byteLength(t) > UPLOAD.textBytes;
        if (cut) t = b.data.subarray(0, UPLOAD.textBytes).toString("utf8").replace(/�$/, "");
        text.run(b.id, "ok", cut ? `its first ${UPLOAD.textBytes / 1024 / 1024} MB of text` : "", null, null, t, now());
      }
    });
    if (a.taskId) svc.updateTask(a.taskId, {});
    blobs.forEach((b, k) => kinds[k] === "pdf" && this.#enqueue(b.id));
    return { stored, message };
  }

  /** Deletes an upload: the row, the bytes, the text, and the file from its message or task. */
  remove(fileId: string): StoredFile {
    const { db, svc } = this.deps;
    const r = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as any;
    if (!r) refuse("no such file");
    db.prepare("DELETE FROM file_texts WHERE file_id = ?").run(r.id);
    db.prepare("DELETE FROM files WHERE id = ?").run(r.id);
    rmSync(join(filesDir(this.deps.dataDir), r.id), { force: true });
    if (r.message_id) {
      const m = svc.message(r.message_id);
      if (m) svc.updateMessageMeta(m.id, { files: (m.meta?.files ?? []).filter((f: any) => f.id !== r.id) });
    }
    if (r.task_id) svc.updateTask(r.task_id, {});
    return { id: r.id, name: r.name, size: r.size };
  }

  /** A file's text, its state, and why there is none. */
  text(fileId: string): { state: "pending" | "ok" | "failed" | "none"; reason: string; pages: number | null; pagesRead: number | null; text: string } {
    const t = this.deps.db.prepare("SELECT * FROM file_texts WHERE file_id = ?").get(fileId) as any;
    if (t) return { state: t.state, reason: t.reason, pages: t.pages, pagesRead: t.pages_read, text: t.text };
    // an agent's own text file: its bytes
    const r = this.deps.db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as any;
    if (r && ["txt", "md", "csv", "json"].includes(ext(r.name))) {
      try {
        return { state: "ok", reason: "", pages: null, pagesRead: null, text: readFileSync(join(filesDir(this.deps.dataDir), r.id), "utf8") };
      } catch {}
    }
    return { state: "none", reason: "it isn't a text file or a PDF people uploaded", pages: null, pagesRead: null, text: "" };
  }

  /** Resolves when no PDF is waiting: for the tests. */
  idle(): Promise<void> {
    return this.#busy || this.#queue.length ? new Promise((r) => this.#idle.push(r)) : Promise.resolve();
  }

  #enqueue(fileId: string): void {
    if (!this.#queue.includes(fileId)) this.#queue.push(fileId);
    void this.#next();
  }

  async #next(): Promise<void> {
    if (this.#busy) return;
    const id = this.#queue.shift();
    if (!id) {
      for (const r of this.#idle.splice(0)) r();
      return;
    }
    this.#busy = true;
    try {
      const { db, svc } = this.deps;
      const r = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as any;
      if (r) {
        let out: ReturnType<typeof readOutput>;
        try {
          out = readOutput(await this.runner(readFileSync(join(filesDir(this.deps.dataDir), r.id))));
        } catch {
          out = readOutput({ code: null, stdout: "", timedOut: false, failed: "no reader" });
        }
        db.prepare("UPDATE file_texts SET state = ?, reason = ?, pages = ?, pages_read = ?, text = ?, updated_at = ? WHERE file_id = ?").run(
          out.state,
          out.reason,
          out.pages,
          out.pagesRead,
          out.text,
          now(),
          id,
        );
        if (r.message_id) {
          const m = svc.message(r.message_id);
          if (m)
            svc.updateMessageMeta(m.id, {
              files: (m.meta?.files ?? []).map((f: any) => (f.id === id ? { ...f, text: out.state, reason: out.reason, pages: out.pages } : f)),
            });
        }
        if (r.task_id) svc.updateTask(r.task_id, {});
      }
    } finally {
      this.#busy = false;
      void this.#next();
    }
  }
}

/** The lines an agent gets with a message's files: each file, its id and whether its text is ready. */
export function attachedLines(files: StoredFile[], kinds: ("pdf" | "text")[]): string {
  return (
    "Attached:\n" +
    files
      .map((f, k) => `- ${f.name} (${f.id}), ${kinds[k] === "pdf" ? "a PDF: its text is being read; read it with read_file" : "text: read it with read_file"}`)
      .join("\n")
  );
}

// ---------------------------------------------------------------- the agent's tool
export function readFileTool(uploads: Uploads): ToolDef {
  const { db, svc } = uploads.deps;
  return {
    name: "read_file",
    category: "core",
    description:
      "Read a file's text: a PDF, .txt or .md a person attached, or a text file an agent attached, in a chat you are in. " +
      `Returns up to ${UPLOAD.readChars} characters from "from" (0 to start). A PDF that couldn't be read says why: then ask the person for a text version.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the file's id, such as f_…" },
        from: { type: "number", description: "the character to start at; 0 by default" },
      },
      required: ["id"],
    },
    run: async (a: any, ctx: CallContext) => {
      const r = db.prepare("SELECT * FROM files WHERE id = ?").get(String(a.id ?? "")) as any;
      if (!r || !svc.isMember(r.chat_id, "agent", ctx.agent.id)) throw new Error(`there is no file ${String(a.id)} in a chat you are in`);
      let t = uploads.text(r.id);
      for (let i = 0; t.state === "pending" && i < 40; i++) {
        await new Promise((x) => setTimeout(x, 500));
        t = uploads.text(r.id);
      }
      if (t.state === "pending") return `${r.name}: its text is still being read. Try again in a minute.`;
      if (t.state === "failed")
        return `${r.name}: no text could be read: ${t.reason}. Ask the person who attached it for a text version, as a .txt or .md file.`;
      if (t.state === "none") return `${r.name}: no text to read: ${t.reason}.`;
      const from = Math.max(0, Math.floor(Number(a.from ?? 0)) || 0);
      const part = t.text.slice(from, from + UPLOAD.readChars);
      const head = [
        `${r.name}`,
        t.pages ? `${t.pages} pages` : "",
        t.reason ? `read: ${t.reason}` : "",
        `characters ${from}–${from + part.length} of ${t.text.length}`,
      ]
        .filter(Boolean)
        .join(", ");
      const more = from + part.length < t.text.length ? `\n\n(more: read_file with from ${from + part.length})` : "";
      return `${head}\n\n${part}${more}`;
    },
  };
}

// ---------------------------------------------------------------- people's routes
export function registerUploads(api: Hono<any>, uploads: Uploads, h: { isAdmin: (u: any) => boolean; seesChat: (u: any, chatId: string) => boolean }): void {
  const { db, svc } = uploads.deps;
  const err = (c: any, status: number, error: string) => c.json({ error }, status);
  const handled = (fn: (c: any) => any) => async (c: any) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof FileRefusal) return err(c, 400, e.message);
      throw e;
    }
  };
  /** The files of a multipart body, after checking its size from the header. */
  const formFiles = async (c: any): Promise<{ files: { name: string; data: Buffer }[]; body: string } | Response> => {
    const len = Number(c.req.header("content-length") ?? NaN);
    if (!Number.isFinite(len)) return err(c, 411, "the upload needs its length");
    if (len > UPLOAD.messageBytes + 1024 * 1024) return err(c, 413, `the files come to more than ${UPLOAD.messageBytes / 1024 / 1024} MB`);
    const form = await c.req.parseBody({ all: true });
    const list = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in (f as any));
    const files = await Promise.all(list.map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) })));
    return { files, body: typeof form.body === "string" ? form.body : "" };
  };
  /** A person in the chat, and the chat open: who may upload there. */
  const mayUpload = (c: any, chatId: string): Response | undefined => {
    const u = c.get("user");
    const chat = svc.chat(chatId);
    if (!chat) return err(c, 404, "no such chat");
    if (chat.archivedAt) return err(c, 409, "This chat is archived. Restore it to add files.");
    if (!(svc.isMember(chat.id, "user", u.id) || chat.kind === "agents")) return err(c, 403, "You're not in that chat");
    return undefined;
  };

  // files on a new message in a chat: a multipart body with "file" fields and an optional "body"
  api.post(
    "/api/chats/:id/files",
    handled(async (c) => {
      const chatId = c.req.param("id");
      const no = mayUpload(c, chatId);
      if (no) return no;
      const f = await formFiles(c);
      if (f instanceof Response) return f;
      const u = c.get("user");
      if (svc.chat(chatId)!.kind === "agents" && !svc.isMember(chatId, "user", u.id)) svc.addMember(chatId, "user", u.id); // stepping in
      const { stored, message } = uploads.store({ chatId, userId: u.id, files: f.files, body: f.body });
      svc.markRead(chatId, u.id);
      return c.json({ message, files: stored });
    }),
  );
  // files on a task alone
  api.post(
    "/api/tasks/:id/files",
    handled(async (c) => {
      const t = svc.task(c.req.param("id"));
      if (!t || !h.seesChat(c.get("user"), t.chatId)) return err(c, 404, "no such task");
      const no = mayUpload(c, t.chatId);
      if (no) return no;
      const f = await formFiles(c);
      if (f instanceof Response) return f;
      return c.json({ files: uploads.store({ chatId: t.chatId, userId: c.get("user").id, files: f.files, taskId: t.id }).stored });
    }),
  );
  // the uploader deletes their own upload; an admin, any upload. Never an agent's file.
  api.delete(
    "/api/files/:id",
    handled((c) => {
      const u = c.get("user");
      const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
      if (!r || !h.seesChat(u, r.chat_id)) return err(c, 404, "no such file");
      if (!r.user_id) return err(c, 403, "only people's uploads can be deleted here");
      if (r.user_id !== u.id && !h.isAdmin(u)) return err(c, 403, "only the person who uploaded it, or an admin, may delete it");
      return c.json({ deleted: uploads.remove(r.id) });
    }),
  );
  // a file's text, and why there is none
  api.get("/api/files/:id/text", (c) => {
    const r = db.prepare("SELECT * FROM files WHERE id = ?").get(c.req.param("id")) as any;
    if (!r || !h.seesChat(c.get("user"), r.chat_id)) return err(c, 404, "no such file");
    return c.json(uploads.text(r.id));
  });
}
