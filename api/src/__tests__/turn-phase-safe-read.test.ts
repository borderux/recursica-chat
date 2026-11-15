import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The working line's 15-second read of a running turn's Hermes session goes
// through the same reader as the turn's final message (#33): no link followed
// on the way to state.db, only a regular file with one name on the home's own
// file system, inside the agent's own home, opened as a private read-only
// copy that is removed afterwards. An agent can replace its own state.db, so
// a home that fails a check gives no step at all, never another agent's.

type Bridge = { currentTurnPhase: (home: string, sinceSec: number) => Promise<string | null> };
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const STARTED = 1_767_355_200;
const call = (name: string) => JSON.stringify([{ type: "function", function: { name, arguments: "{}" } }]);

let homes: string, home: string;
function writeSession(into: string, toolCalls: string | null, startedAt = STARTED + 6) {
  const db = new DatabaseSync(join(into, "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_calls TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
  db.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run("s1", "tool", startedAt);
  db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)").run("s1", "user", "task", null, startedAt);
  if (toolCalls !== null) {
    db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)").run("s1", "assistant", "", toolCalls, startedAt + 1);
  }
  db.close();
}
// Another agent's home, whose turn is reading skills.
async function otherHome() {
  const other = join(homes, "agent-b");
  await fs.mkdir(other);
  writeSession(other, call("skill_view"));
  return other;
}

beforeEach(async () => {
  homes = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "hermes-homes-")));
  home = join(homes, "agent-a");
  await fs.mkdir(home);
});
afterEach(async () => {
  await fs.rm(homes, { recursive: true, force: true });
});

describe("the 15-second read of the agent's own session", () => {
  it("gives the step of its own turn", async () => {
    writeSession(home, call("terminal"));
    expect(await bridge.currentTurnPhase(home, STARTED)).toBe("running a command");
  });

  it("says thinking before the first call, and starting before the session exists", async () => {
    writeSession(home, null);
    expect(await bridge.currentTurnPhase(home, STARTED)).toBe("thinking");
    await fs.rm(join(home, "state.db"));
    writeSession(home, call("terminal"), STARTED - 600); // an older turn's session
    expect(await bridge.currentTurnPhase(home, STARTED)).toBe("starting");
  });

  it("leaves no copy behind, and never writes the agent's home", async () => {
    writeSession(home, call("read_file"));
    const before = (await fs.readdir(home)).sort();
    const copies = async () => (await fs.readdir(tmpdir())).filter((n) => n.startsWith("cc-state-")).length;
    const copiesBefore = await copies();
    expect(await bridge.currentTurnPhase(home, STARTED)).toBe("reading files");
    expect((await fs.readdir(home)).sort()).toEqual(before);
    expect(await copies()).toBe(copiesBefore);
  });
});

describe("a state.db that is not the agent's own regular file gives no step", () => {
  it("a link to another agent's state.db", async () => {
    const other = await otherHome();
    await fs.symlink(join(other, "state.db"), join(home, "state.db"));
    expect(await bridge.currentTurnPhase(home, STARTED)).toBeNull();
  });

  it("a link to a file outside the homes", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "outside-")));
    try {
      writeSession(outside, call("skill_view"));
      await fs.symlink(join(outside, "state.db"), join(home, "state.db"));
      expect(await bridge.currentTurnPhase(home, STARTED)).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("a hard link to another agent's state.db", async () => {
    const other = await otherHome();
    await fs.link(join(other, "state.db"), join(home, "state.db"));
    expect(await bridge.currentTurnPhase(home, STARTED)).toBeNull();
  });

  it("a folder in its place", async () => {
    await fs.mkdir(join(home, "state.db"));
    expect(await bridge.currentTurnPhase(home, STARTED)).toBeNull();
  });

  it("a write-ahead log that is a link", async () => {
    writeSession(home, call("terminal"));
    const other = await otherHome();
    await fs.writeFile(join(other, "state.db-wal"), "");
    await fs.symlink(join(other, "state.db-wal"), join(home, "state.db-wal"));
    expect(await bridge.currentTurnPhase(home, STARTED)).toBeNull();
  });

  it("a home whose own path holds a link", async () => {
    writeSession(home, call("terminal"));
    const linked = join(homes, "agent-a-link");
    await fs.symlink(home, linked);
    expect(await bridge.currentTurnPhase(linked, STARTED)).toBeNull();
  });

  it("no home at all", async () => {
    expect(await bridge.currentTurnPhase("", STARTED)).toBeNull();
    expect(await bridge.currentTurnPhase(join(homes, "missing"), STARTED)).toBeNull();
  });
});

describe("one reader for both", () => {
  it("the final message and the 15-second read open state.db only through withStateDb", () => {
    const src = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    const body = (name: string) => {
      const at = src.indexOf(`async function ${name}(`);
      return src.slice(at, src.indexOf("\n}\n", at));
    };
    for (const name of ["finalMessageFromSession", "currentTurnPhase"]) {
      expect(body(name)).toMatch(/await withStateDb\(hermesHome, \(db\) => \{/);
      expect(body(name)).not.toMatch(/DatabaseSync|copyHomeFile|openSync/);
    }
    const reader = body("withStateDb");
    expect(reader).toMatch(/realpathSync\(home\) !== home/);
    expect(reader).toMatch(/copyHomeFile\(home, homeStat\.dev, "state\.db", dir\)/);
    expect(reader).toMatch(/\{ readOnly: true \}/);
    expect(reader).toMatch(/rmSync\(dir, \{ recursive: true, force: true \}\)/);
    expect(src.match(/new sqlite\.DatabaseSync\(/g)).toHaveLength(1);
  });
});
