import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isQuestion, mentionPeopleOnQuestion, questionAudience } from "../agents/question-mentions.js";

// An agent's question on a task @mentions the people who can answer it: the
// task's assignees who are people, or, with no person assigned, its creator.
// Never an agent. Members: two people and two agents.
const personA = { memberId: "mem_person_a", handle: "person-a" };
const personB = { memberId: "mem_person_b", handle: "person-b" };
const designer = { memberId: "mem_designer", handle: "designer" };
const designerQa = { memberId: "mem_designer_qa", handle: "designer-qa" };
const agents = [designer, designerQa];

describe("what counts as a question", () => {
  it("a question mark in the prose", () => {
    expect(isQuestion("Who is the pricing page for: teams, or single users?")).toBe(true);
    expect(isQuestion("Page attached.")).toBe(false);
  });

  it("not a question mark inside code or a link", () => {
    expect(isQuestion("Run `npm run lint -- --fix?` next.")).toBe(false);
    expect(isQuestion("```js\nconst x = a ? b : c;\n```\nDone.")).toBe(false);
    expect(isQuestion("See [the brief](https://example-app.test/brief?id=1) for details.")).toBe(false);
    expect(isQuestion("Spec at https://example-app.test/spec?v=2")).toBe(false);
  });
});

describe("whom a question mentions", () => {
  it("the task's assignees who are people", () => {
    expect(questionAudience({ people: [personA, personB], creator: { ...personB, isPerson: true } })).toEqual([personA, personB]);
  });

  it("with no person assigned, the task's creator", () => {
    expect(questionAudience({ people: [], creator: { ...personB, isPerson: true } })).toEqual([personB]);
  });

  it("nobody when no person is assigned and an agent created the task", () => {
    expect(questionAudience({ people: [], creator: null })).toEqual([]);
  });
});

describe("the question as posted", () => {
  const q = "Who is the pricing page for: teams, or single users?";

  it("starts with an @mention of each person, and mentions them", () => {
    const r = mentionPeopleOnQuestion(q, [], { audience: [personA, personB], agents });
    expect(r.body).toBe(`@person-a @person-b ${q}`);
    expect(r.mentions).toEqual(["mem_person_a", "mem_person_b"]);
    expect(r.added).toEqual(["person-a", "person-b"]);
  });

  it("adds no second @mention of a person the text already mentions", () => {
    const r = mentionPeopleOnQuestion(`@person-a ${q}`, [], { audience: [personA], agents });
    expect(r.body).toBe(`@person-a ${q}`);
    expect(r.added).toEqual([]);
    expect(r.mentions).toEqual(["mem_person_a"]);
  });

  it("never @mentions an agent: the @ goes, the name stays, and no agent is in the mentions", () => {
    const r = mentionPeopleOnQuestion(`@designer, ${q} cc @designer-qa.`, ["mem_designer", "mem_person_b"], {
      audience: [personA],
      agents,
    });
    expect(r.body).toBe(`@person-a designer, ${q} cc designer-qa.`);
    expect(r.mentions).toEqual(["mem_person_a", "mem_person_b"]);
    expect(r.dropped).toEqual(["designer", "designer-qa"]);
  });

  it("does not take an agent's handle that is part of a longer handle", () => {
    const r = mentionPeopleOnQuestion(`@designer-qa ${q}`, [], { audience: [personA], agents: [designer] });
    expect(r.body).toBe(`@person-a @designer-qa ${q}`);
  });

  it("with nobody to mention, still drops agents' @", () => {
    const r = mentionPeopleOnQuestion(`@designer ${q}`, ["mem_designer"], { audience: [], agents });
    expect(r.body).toBe(`designer ${q}`);
    expect(r.mentions).toEqual([]);
  });

  it("leaves a comment that is not a question as it is", () => {
    const r = mentionPeopleOnQuestion("Page attached. @designer can review it.", ["mem_designer"], { audience: [personA], agents });
    expect(r.body).toBe("Page attached. @designer can review it.");
    expect(r.mentions).toEqual(["mem_designer"]);
  });
});

describe("the executor applies it to every task comment an agent posts", () => {
  const src = readFileSync(resolve(__dirname, "../agents/executor.ts"), "utf8");
  const tc = src.slice(src.indexOf('    case "task_comment": {'), src.indexOf('    case "share_to_task": {'));

  it("posts the rewritten body and mentions, never the agent's own", () => {
    expect(tc).toMatch(/mentionPeopleOnQuestion\(split\.body, Array\.isArray\(a\.mentions\) \? a\.mentions : \[\], await loadQuestionContext\(a\.task_id, ws\)\)/);
    expect(tc).toMatch(/addComment\(\s*a\.task_id,\s*asked\.body,\s*asked\.mentions,/);
  });

  it("which covers a turn's reply on a task, since the bridge posts it as a task_comment", () => {
    const bridge = readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");
    expect(bridge).toMatch(/actions\.push\(\{ type: "task_comment", task_id: taskId, body_md: postBody/);
  });
});
