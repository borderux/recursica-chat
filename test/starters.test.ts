// SPDX-License-Identifier: AGPL-3.0-only
// Starters (server/src/starters.ts, web/src/starters.ts): the suggestions an empty chat with an agent
// shows. A managed agent's come from its repository through cli.ts agent-set; the API returns them
// and changes them for no one; an agent with none shows the generic ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startApp, setupOwner, mockAgent } from "./helpers.ts";
import { agentGet, agentSet, manage, parseSettings } from "../server/src/managed.ts";
import { MAX_STARTERS, parseStarters } from "../server/src/starters.ts";
import { GENERIC_STARTERS, allFilled, fillStarter, mentionsAttachment, placeholdersIn, previewParts, startersFor } from "../web/src/starters.ts";

const STARTERS = [
  "Quick test: one short interview about a hobby",
  "One interview about [your subject], based on the attached notes",
  "What can you do?",
];

test("starters from stdin: a list of one-line texts, trimmed, each different, at most eight", () => {
  assert.deepEqual(parseSettings(JSON.stringify({ starters: [" What can you do? "] }), []), { starters: ["What can you do?"] });
  assert.deepEqual(parseSettings(JSON.stringify({ starters: [] }), []), { starters: [] }, "none: the generic ones");
  for (const [v, why] of [
    ["What can you do?", /starters must be a list of text/],
    [[5], /starter 1 must be text/],
    [["  "], /starter 1 must be text/],
    [["a", "line one\nline two"], /starter 2 must be one line/],
    [["x".repeat(201)], /over 200/],
    [["same", "same"], /each starter must differ/],
    [Array.from({ length: MAX_STARTERS + 1 }, (_, k) => `starter ${k}`), /over 8/],
  ] as const)
    assert.throws(() => parseStarters(v), why, JSON.stringify(v));
  assert.throws(() => parseSettings(JSON.stringify({ starter: ["x"] }), []), /starter is not a managed setting \(.*starters\)/);
});

test("agent-set sets a managed agent's starters only when they differ, agent-get prints them, and an empty list removes them", async () => {
  const h = await startApp();
  try {
    const c = await setupOwner(h);
    const a = await mockAgent(c, "writer");
    const db = h.app.db;
    manage(db, "writer", true);
    assert.deepEqual(agentSet(db, "writer", { starters: STARTERS }, { check: true }), ["starters"]);
    assert.deepEqual(agentGet(db, "writer").starters, [], "--check changes nothing");
    assert.deepEqual(agentSet(db, "writer", { autonomy: "ask", starters: STARTERS }), ["autonomy", "starters"]);
    assert.deepEqual(agentSet(db, "writer", { autonomy: "ask", starters: STARTERS }), [], "a second run changes nothing");
    assert.deepEqual(agentGet(db, "writer").starters, STARTERS);
    assert.deepEqual(agentSet(db, "writer", { starters: [...STARTERS].reverse() }), ["starters"], "the order counts");

    // the API returns them with the agent, and a PATCH that names them changes nothing
    const got = (await c.get(`/api/agents/${a.id}`)).json.agent;
    assert.deepEqual(got.starters, [...STARTERS].reverse());
    assert.ok(((await c.get("/api/agents")).json.agents as any[]).find((x) => x.id === a.id).starters.length === 3);
    await c.patch(`/api/agents/${a.id}`, { starters: ["Pasted"] });
    assert.deepEqual((await c.get(`/api/agents/${a.id}`)).json.agent.starters, [...STARTERS].reverse());

    assert.deepEqual(agentSet(db, "writer", { starters: [] }), ["starters"]);
    assert.deepEqual((await c.get(`/api/agents/${a.id}`)).json.agent.starters, []);
    assert.deepEqual(agentSet(db, "writer", { starters: [] }), []);
  } finally {
    await h.close();
  }
});

test("the web app: an agent's own starters, else the generic ones", () => {
  assert.deepEqual(startersFor({ starters: STARTERS }), STARTERS);
  assert.deepEqual(startersFor({ starters: [] }), GENERIC_STARTERS);
  assert.deepEqual(startersFor({}), GENERIC_STARTERS);
  assert.deepEqual(startersFor(undefined), GENERIC_STARTERS);
  assert.equal(GENERIC_STARTERS.length, 4);
});

test("a starter's placeholders: one field each, labeled with its text, a live preview, and the finished message", () => {
  assert.deepEqual(placeholdersIn(STARTERS[1]), ["your subject"]);
  assert.deepEqual(placeholdersIn("Three interviews about [a topic] with [a group], then [a topic] again"), ["a topic", "a group"], "each once, in order");
  for (const t of ["What can you do?", "An empty [] pair", "A [broken\nbracket]", "[  ]"]) assert.deepEqual(placeholdersIn(t), [], t);

  // the preview: each blank stays bracketed until its field has a value
  const s = "One interview about [your subject], based on the attached notes";
  assert.deepEqual(previewParts(s, {}), [{ text: "One interview about " }, { text: "[your subject]", blank: true }, { text: ", based on the attached notes" }]);
  assert.deepEqual(previewParts(s, { "your subject": "  " }).filter((p) => p.blank).length, 1, "spaces alone are no value");
  assert.equal(fillStarter(s, { "your subject": " a hobby " }), "One interview about a hobby, based on the attached notes");
  assert.equal(fillStarter("Two about [x] and [y], then [x]", { x: "cats", y: "dogs" }), "Two about cats and dogs, then cats", "a placeholder used twice gets its value twice");

  // Send waits until every field is filled
  assert.equal(allFilled(["your subject"], {}), false);
  assert.equal(allFilled(["a", "b"], { a: "x", b: " " }), false);
  assert.equal(allFilled(["a", "b"], { a: "x", b: "y" }), true);

  // a starter that mentions an attachment offers Attach
  assert.equal(mentionsAttachment(s), true);
  assert.equal(mentionsAttachment("Summarize the attachment"), true);
  assert.equal(mentionsAttachment("Three interviews about [your subject]"), false);
  assert.equal(mentionsAttachment("An attache case"), false);
});

test("the chat screen: a starter without placeholders sends at once; one with them opens the dialog, which sends only when filled", () => {
  const chats = readFileSync(new URL("../web/src/screens/Chats.tsx", import.meta.url), "utf8");
  assert.match(chats, /if \(placeholdersIn\(idea\)\.length\) return setFilling\(idea\);\n    const body = prefix \+ idea;/, "no placeholders: sent at once");
  assert.match(chats, /startersFor\(lead\)\.map/);
  assert.doesNotMatch(chats, /What can you do for our team\?/, "the generic starters live in web/src/starters.ts alone");
  const dialog = chats.slice(chats.indexOf("function StarterDialog"), chats.indexOf("function Conversation"));
  assert.match(dialog, /const ready = allFilled\(labels, values\) && !busy;/);
  assert.match(dialog, /disabled=\{!ready\} data-testid="starter-send"/, "Send disabled until every field is filled");
  assert.match(dialog, /if \(k < labels\.length - 1\) fields\.current\[k \+ 1\]\?\.focus\(\);\n    else send\(\);/, "Enter moves on, and in the last field sends");
  assert.match(dialog, /<button className="btn ghost" onClick=\{onClose\}>\n\s+Cancel/, "Cancel only closes");
  assert.match(dialog, /\{attach && \(/, "Attach only for a starter that mentions an attachment");
  assert.match(dialog, /api\.upload\(`\/api\/chats\/\$\{chatId\}\/files`, files, body\)/, "attached files go with the message");
  assert.match(dialog, /enterKeyHint=\{k === labels\.length - 1 \? "send" : "next"\}/, "a phone's keyboard says next, then send");
  assert.doesNotMatch(chats, /onFill|setSelectionRange\(at\[0\]/, "the message box is no longer filled");
});
