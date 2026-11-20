// SPDX-License-Identifier: AGPL-3.0-only
// Server-side commands for operators and hosting scripts. Writes to stdout.
//   node server/src/cli.ts export   full data export (tar.gz, see hosting.ts)
//   node server/src/cli.ts backup   database snapshot + agent folders (tar.gz), no vault key
//   node server/src/cli.ts state    {"users":n,"agents":n,"workspace":"..."} as JSON
//   node server/src/cli.ts set-password-hash <email>   new scrypt hash on stdin; signs that person out everywhere
//   node server/src/cli.ts session <email> [--minutes N]   root only: a session of at most an hour for a member (clisession.ts)
//   node server/src/cli.ts end-sessions <email>           root only: signs that member out everywhere
//   node server/src/cli.ts set-provider <id> --base-url <url> --models <a,b>   root only: key on stdin (cliprovider.ts)
//   node server/src/cli.ts provider-key-hash <id>         root only: the SHA-256 of the provider's stored key
//   node server/src/cli.ts manage|unmanage <handle>       root only: an agent whose settings come from a repository (managed.ts)
//   node server/src/cli.ts agent-get <handle>             root only: a managed agent's settings as JSON
//   node server/src/cli.ts agent-set <handle> [--check]   root only: settings as JSON on stdin
//   node server/src/cli.ts agent-models                   root only: each agent's handle and model
//   node server/src/cli.ts service-create|service-token|service-revoke <name>, service-list   root only: a program's service account (serviceaccounts.ts)
// Uses CIRCLECHAT_DATA like the server. Safe to run while the server is up (SQLite WAL).
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { App } from "./app.ts";
import { REPO_ROOT } from "./agents/engines.ts";
import { exportWorkspace } from "./hosting.ts";
import { getSetting } from "./db.ts";
import { asDataOwner, sessionArgs, memberSession, endSessions } from "./clisession.ts";
import { providerArgs, setProvider, providerKeyHash } from "./cliprovider.ts";
import { agentGet, agentModels, agentSet, manage, parseSettings } from "./managed.ts";
import { SERVICE_COMMANDS, serviceCommand } from "./serviceaccounts.ts";

const dataDir = resolve(process.env.CIRCLECHAT_DATA ?? join(REPO_ROOT, "data"));
const ROOT_ONLY = new Set(["session", "end-sessions", "set-provider", "provider-key-hash", "manage", "unmanage", "agent-get", "agent-set", "agent-models", ...SERVICE_COMMANDS]);
if (ROOT_ONLY.has(process.argv[2])) {
  const refused = asDataOwner(dataDir);
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
}
const keyFile = join(dataDir, "master.key");
const masterKey = process.env.CIRCLECHAT_MASTER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
if (!masterKey) {
  console.error(`no vault key at ${keyFile}`);
  process.exit(2);
}
const app = new App({ dataDir, masterKey });
const cmd = process.argv[2];

const pipeTo = (stream: NodeJS.ReadableStream) =>
  new Promise<void>((ok, fail) => {
    stream.on("error", fail);
    stream.on("end", ok);
    stream.pipe(process.stdout);
  });

if (cmd === "export") {
  const out = await exportWorkspace(app);
  await pipeTo(Readable.fromWeb(out.stream as any));
} else if (cmd === "backup") {
  const dir = mkdtempSync(join(tmpdir(), "cc-backup-"));
  try {
    const root = join(dir, "backup");
    mkdirSync(root);
    app.db.exec(`VACUUM INTO '${join(root, "circlechat.db").replace(/'/g, "''")}'`);
    const agents = join(dataDir, "agents");
    if (existsSync(agents)) cpSync(agents, join(root, "agents"), { recursive: true });
    const files = join(dataDir, "files"); // the files agents attached (files.ts)
    if (existsSync(files)) cpSync(files, join(root, "files"), { recursive: true });
    const tar = spawn("tar", ["-czf", "-", "-C", root, "."], { stdio: ["ignore", "pipe", "inherit"] });
    await pipeTo(tar.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else if (cmd === "state") {
  const n = (t: string) => (app.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  process.stdout.write(JSON.stringify({ users: n("users"), agents: n("agents"), workspace: getSetting(app.db, "workspace_name") ?? "" }) + "\n");
} else if (cmd === "set-password-hash") {
  const email = String(process.argv[3] ?? "").toLowerCase();
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const hash = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^scrypt\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/.test(hash)) {
    console.error("stdin must be an scrypt hash");
    process.exit(2);
  }
  const u = app.db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
  if (!u) {
    console.error(`no user ${email}`);
    process.exit(3);
  }
  app.db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hash, u.id);
  app.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  process.stdout.write("ok\n");
} else if (cmd === "session" || cmd === "end-sessions") {
  try {
    if (cmd === "session") {
      const { email, minutes } = sessionArgs(process.argv.slice(3));
      const s = memberSession(app.db, email, minutes);
      console.error(`A session for ${email} until ${new Date(s.expiresAt).toISOString()}.`);
      process.stdout.write(s.token + "\n");
    } else {
      const email = String(process.argv[3] ?? "");
      if (!email || process.argv.length > 4) throw new Error("usage: cli.ts end-sessions <email>");
      console.error(`Ended ${endSessions(app.db, email)} session(s) of ${email.toLowerCase()}.`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(3);
  }
} else if (cmd === "set-provider" || cmd === "provider-key-hash") {
  try {
    if (cmd === "set-provider") {
      const p = providerArgs(process.argv.slice(3));
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const done = setProvider(app, p, Buffer.concat(chunks).toString("utf8"));
      console.error(`Provider ${p.id} ${done}.`);
    } else {
      const id = String(process.argv[3] ?? "");
      if (!id || process.argv.length > 4) throw new Error("usage: cli.ts provider-key-hash <id>");
      const h = providerKeyHash(app, id);
      if (h) process.stdout.write(h + "\n");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(3);
  }
} else if (["manage", "unmanage", "agent-get", "agent-set", "agent-models"].includes(cmd)) {
  try {
    const handle = String(process.argv[3] ?? "");
    const extra = process.argv.slice(4);
    if (cmd === "agent-models") {
      const out = agentModels(app.db);
      if (out) process.stdout.write(out + "\n");
    } else if (!handle || (cmd === "agent-set" ? extra.some((x) => x !== "--check") : extra.length)) {
      throw new Error(`usage: cli.ts ${cmd} <handle>${cmd === "agent-set" ? " [--check]" : ""}`);
    } else if (cmd === "manage" || cmd === "unmanage") {
      console.error(`@${handle.replace(/^@/, "")}: ${manage(app.db, handle, cmd === "manage")}.`);
    } else if (cmd === "agent-get") {
      process.stdout.write(JSON.stringify(agentGet(app.db, handle)) + "\n");
    } else {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const settings = parseSettings(Buffer.concat(chunks).toString("utf8"), (app.providers(false) as any[]).map((p) => p.id));
      const check = extra.includes("--check");
      const changed = agentSet(app.db, handle, settings, { check });
      process.stdout.write(changed.length ? `${check ? "would set" : "set"} ${changed.join(", ")}\n` : "up to date\n");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(3);
  }
} else if (SERVICE_COMMANDS.includes(cmd)) {
  try {
    const r = serviceCommand(app.db, cmd, process.argv.slice(3));
    if (r.stderr) console.error(r.stderr);
    if (r.stdout) process.stdout.write(r.stdout + "\n");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(3);
  }
} else {
  console.error("usage: cli.ts export | backup | state | set-password-hash <email> | session <email> [--minutes N] | end-sessions <email> | set-provider <id> --base-url <url> --models <a,b> | provider-key-hash <id> | manage|unmanage|agent-get <handle> | agent-set <handle> [--check] | agent-models | service-create|service-token|service-revoke <name> | service-list");
  process.exit(2);
}
app.db.close();
