// SPDX-License-Identifier: AGPL-3.0-only
// The web app across a server restart (web/src/reconnect.ts, web/src/drafts.ts): the live
// connection comes back by itself with a capped backoff and the app catches up; an unsent draft,
// in the message box or in a starter's blanks, survives the drop and a reload, and goes away only
// when it's sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { App, newMasterKey } from "../server/src/app.ts";
import { createHttpServer } from "../server/src/server.ts";
import { Client, waitFor } from "./helpers.ts";
import { FIRST_DELAY, MAX_DELAY, keepConnected, nextDelay, type SocketLike } from "../web/src/reconnect.ts";
import { DRAFT_TTL, draftKey, isEmptyDraft, readDraft, writeDraft, type DraftStore } from "../web/src/drafts.ts";

const src = (p: string) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- a fake socket and clock
class FakeSocket implements SocketLike {
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  /** the server accepted */
  up() {
    this.onopen?.({});
  }
  /** the server went away, or never answered (a 502 while it restarts) */
  drop() {
    this.close();
  }
}
function fakeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    timers,
    set: (fn: () => void, ms: number) => {
      timers.set(++n, { fn, ms });
      return n;
    },
    clear: (t: unknown) => void timers.delete(t as number),
    /** runs the one pending timer, and says how long it waited */
    fire(): number {
      assert.equal(timers.size, 1, "one retry waiting");
      const [[id, t]] = [...timers];
      timers.delete(id);
      t.fn();
      return t.ms;
    },
  };
}

test("backoff: starts at half a second, doubles, and never waits more than ten", () => {
  const seen = [FIRST_DELAY];
  for (let i = 0; i < 8; i++) seen.push(nextDelay(seen[seen.length - 1]));
  assert.deepEqual(seen, [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000, 10_000]);
  assert.equal(MAX_DELAY, 10_000);
});

test("reconnect: a drop tries again with a growing, capped wait; an open resets it and catches up", () => {
  const sockets: FakeSocket[] = [];
  const clock = fakeClock();
  const log: string[] = [];
  const got: unknown[] = [];
  const stop = keepConnected(
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    { up: () => log.push("up"), down: () => log.push("down"), message: (d) => got.push(d) },
    clock,
  );
  assert.equal(sockets.length, 1);
  sockets[0].up();
  sockets[0].onmessage?.({ data: '{"type":"hello"}' });
  assert.deepEqual(got, ['{"type":"hello"}']);

  // the server restarts: the socket drops, and every try fails until it's back
  sockets[0].drop();
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    waits.push(clock.fire());
    sockets[sockets.length - 1].drop();
  }
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(sockets.length, 8);

  // back: the next try opens, which runs up (the app reloads its lists, and each screen reloads on hello)
  clock.fire();
  sockets[8].up();
  assert.deepEqual(log, ["up", ...Array(8).fill("down"), "up"]);

  // the wait starts over after a good connection
  sockets[8].drop();
  assert.equal(clock.fire(), FIRST_DELAY);

  // leaving the app: no more tries, the socket is closed
  stop();
  assert.equal(sockets[9].closed, true);
  assert.equal(clock.timers.size, 0);
  assert.equal(sockets.length, 10);
});

test("reconnect: stopping while a retry waits cancels it", () => {
  const sockets: FakeSocket[] = [];
  const clock = fakeClock();
  const stop = keepConnected(() => (sockets.push(new FakeSocket()), sockets[sockets.length - 1]), { up() {}, down() {}, message() {} }, clock);
  sockets[0].drop();
  assert.equal(clock.timers.size, 1);
  stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(sockets.length, 1);
});

test("reconnect, for real: the server stops and starts again on the same port; the socket comes back signed in and gets hello", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-test-"));
  const masterKey = newMasterKey();
  let port = 0;
  const boot = async () => {
    const app = new App({ dataDir: dir, masterKey, idleSleepMs: 0, approvalTtlMs: 60_000, turnTimeoutMs: 30_000 });
    const server = createHttpServer(app);
    // a process that stops drops every connection, the live sockets too
    const conns = new Set<Socket>();
    server.on("connection", (s: Socket) => {
      conns.add(s);
      s.on("close", () => conns.delete(s));
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    app.gateway.publicUrl = `http://127.0.0.1:${port}`;
    app.start();
    return {
      async stop() {
        await app.runtime.shutdown();
        await app.gateway.closeAll();
        for (const b of app.bridges.values()) b.stop();
        app.triggers.stop();
        for (const s of conns) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
        app.db.close();
      },
    };
  };
  let live = await boot();
  t.after(async () => {
    await live?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const c = new Client(base);
  const setup = await c.post("/api/setup", { email: "person-a@example.com", name: "Person A", password: "correct horse battery", workspace: "Acme" });
  assert.equal(setup.status, 200);
  const chat = (await c.post("/api/chats", { name: "Room", agents: [] })).json.chat;
  const token = c.cookie.slice(c.cookie.indexOf("=") + 1);

  let ups = 0;
  let downs = 0;
  const hellos: number[] = [];
  const stopSocket = keepConnected(
    () => new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`) as unknown as SocketLike,
    { up: () => ups++, down: () => downs++, message: (d) => JSON.parse(String(d)).type === "hello" && hellos.push(Date.now()) },
  );
  t.after(stopSocket);
  await waitFor(() => hellos.length === 1, "first hello");

  await live.stop();
  await waitFor(() => downs >= 1, "the drop is seen");
  live = await boot();
  // posted after the restart, before the socket is back: the catch-up on hello must find it
  const posted = (await c.post(`/api/chats/${chat.id}/messages`, { body: "while you were away" })).json.message;
  await waitFor(() => hellos.length === 2, "hello again after the restart", 20_000);
  assert.ok(ups >= 2);
  // the same session works: no sign-in again
  const msgs = (await c.get(`/api/chats/${chat.id}/messages?limit=100`)).json.messages as any[];
  assert.ok(msgs.some((m) => m.id === posted.id));
});

test("the app reconnects and catches up: the store uses keepConnected, each open reloads, and screens reload on hello", () => {
  const store = src("store.tsx");
  assert.match(store, /keepConnected\(/);
  assert.match(store, /up: \(\) => \{\s*setUp\(true\);\s*openRef\.current\(\);/);
  assert.match(store, /const online = useSocket\(true, reloadAll\)/);
  for (const f of ["screens/Chats.tsx", "screens/Agent.tsx", "screens/Tasks.tsx", "screens/Needs.tsx", "screens/Memory.tsx", "ui/files.tsx"]) assert.match(src(f), /e\.type === "hello"/, f);
});

test("the app shows it's reconnecting, and a page loaded while the server is down keeps trying", () => {
  const app = src("App.tsx");
  assert.match(app, /<Reconnecting \/>/);
  assert.match(app, /setTries\(\(n\) => n \+ 1\)/);
  assert.match(app, /window\.setTimeout\(load, d\)/);
  const note = src("ui/Reconnecting.tsx");
  assert.match(note, /const \{ online \} = useStore\(\)/);
  assert.match(note, /Reconnecting…/);
});

// ---------------------------------------------------------------- drafts
const memStore = (): DraftStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

test("drafts: one per person and chat, kept across a reload, removed when emptied", () => {
  const s = memStore();
  const a = draftKey("u1", "c1");
  const b = draftKey("u1", "c2");
  const other = draftKey("u2", "c1");
  assert.notEqual(a, b);
  assert.notEqual(a, other);
  writeDraft(a, "half a thought", s);
  writeDraft(b, "another chat", s);
  // a reload reads them back; nothing leaks to another chat or person
  assert.equal(readDraft(a, "", s), "half a thought");
  assert.equal(readDraft(b, "", s), "another chat");
  assert.equal(readDraft(other, "", s), "");
  // sent: the composer sets "" and the draft is gone
  writeDraft(a, "", s);
  assert.equal(s.m.has(a), false);
  writeDraft(b, "   ", s);
  assert.equal(s.m.has(b), false);
});

test("drafts: a starter's blanks are kept as an object, and dropped once all are empty", () => {
  const s = memStore();
  const k = draftKey("u1", "c1", "starter:One interview about [your subject]");
  writeDraft(k, { "your subject": "gardening" }, s);
  assert.deepEqual(readDraft(k, {}, s), { "your subject": "gardening" });
  assert.equal(isEmptyDraft({ "your subject": "" }), true);
  writeDraft(k, { "your subject": "" }, s);
  assert.equal(s.m.has(k), false);
});

test("drafts: an old one is dropped, and no storage (private mode, full) never breaks the box", () => {
  const s = memStore();
  const k = draftKey("u1", "c1");
  writeDraft(k, "old", s, 1000);
  assert.equal(readDraft(k, "", s, 1000 + DRAFT_TTL + 1), "");
  assert.equal(s.m.has(k), false);
  const broken: DraftStore = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => writeDraft(k, "x", broken));
  assert.equal(readDraft(k, "fallback", broken), "fallback");
  assert.equal(readDraft(k, "fallback", null), "fallback");
  s.m.set(k, "not json");
  assert.equal(readDraft(k, "", s), "");
});

test("the composer and the starter dialog keep drafts; a failed send keeps the text, a good one clears it once", () => {
  const chats = src("screens/Chats.tsx");
  assert.match(chats, /const \[text, setText\] = useDraft\(draftKey\(me\.id, chat\.id\), ""\)/);
  assert.match(chats, /useDraft<Record<string, string>>\(draftKey\(me\.id, chatId, `starter:\$\{starter\}`\), \{\}\)/);
  assert.match(chats, /useDraft\(draftKey\(me\.id, chatId, "starter"\), ""\)/);
  // the composer clears only after the post succeeded; a failure lands in catch and keeps the text
  const send = chats.slice(chats.indexOf("  const send = async () => {\n    const body = text.trim();"));
  const body = send.slice(0, send.indexOf("  const onKey"));
  assert.ok(body.indexOf('setText("")') > body.indexOf("await api.post"), "cleared after the post");
  assert.ok(body.indexOf('setText("")') < body.indexOf("catch (e)"), "not cleared on a failure");
  assert.match(body, /if \(\(!body && !files\.length\) \|\| sending\) return;/, "one send at a time");
});
