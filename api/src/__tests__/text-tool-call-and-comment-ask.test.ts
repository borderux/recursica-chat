import { describe, it, expect, beforeAll } from "vitest";

// Observed: a designer agent's comment turn on a prototype task ended with a
// reply of this shape. Its model wrote an MCP tool call as text, in the
// parameter form, inside an <actions> block, and stopped before closing it. The
// bridge dropped the tool's name as an unknown CircleChat action, did not rerun
// the turn, and the line before it was refused as the
// agent's own reasoning. Nothing was posted. The comment that started the turn
// was "Go ahead with this one.", and the comment turn's instruction said only to
// answer it, so the agent never asked the question its persona asks first.

type Turn = { exitError?: string; rawText: string; runtimeFound: string[] };
type Bridge = {
  extractActions: (text: string) => { body: string; actions: Array<{ type: string }>; dropped: string[] };
  isTextToolCall: (raw: string) => boolean;
  toolsInActions: (raw: string) => string[];
  isMcpToolName: (name: string) => boolean;
  hasUnclosedFunctionBlock: (raw: string) => boolean;
  droppedActionErrors: (dropped: string[], unreadable?: string[]) => string[];
  turnForWaitingPerson: (
    runOnce: (prompt: string) => Promise<Turn>,
    prompt: string,
    opts: { waiting: boolean; timeoutMs: number; now?: () => number },
  ) => Promise<Turn & { reran: boolean; silent: boolean; toolCallAsText: boolean }>;
  TOOL_CALL_REMINDER: string;
  ASK_FIRST_ON_COMMENT: string;
  agentAskedOnTask: (packet: unknown) => boolean;
  buildPrompt: (entry: unknown, packet: unknown) => string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

// The reply's exact shape, as the agent's session saved it, with generic names.
const REPLY =
  "Now I'll examine the components available for building this pricing page.\n\n<actions>\n<function=mcp__example_docs__lookup>\n<parameter=slugs>\n[\"example-skill-table\", \"example-skill-button\", \"example-skill-badge\", \"example-skill-card\", \"example-skill-container\", \"example-skill-title\", \"example-skill-text\", \"example-skill-group\"]\n</parameter>\n<parameter=detail>\ncontract\n</parameter>";

const QUESTION = "Who picks a plan on this page: a new visitor, or a signed-in customer changing plans?";

const turns = (...replies: string[]) => {
  const prompts: string[] = [];
  const runOnce = async (prompt: string): Promise<Turn> => {
    prompts.push(prompt);
    return { rawText: replies[prompts.length - 1] ?? "", runtimeFound: [] };
  };
  return { runOnce, prompts };
};

describe("an MCP tool call written as text is a tool written as text", () => {
  it("finds the agent's MCP tool in the exact reply, and the unclosed block", () => {
    expect(bridge.extractActions(REPLY).dropped).toEqual(["mcp__example_docs__lookup"]);
    expect(bridge.toolsInActions(REPLY)).toEqual(["mcp__example_docs__lookup"]);
    expect(bridge.hasUnclosedFunctionBlock(REPLY)).toBe(true);
    expect(bridge.isTextToolCall(REPLY)).toBe(true);
  });

  it("counts any mcp__ name as a tool, and nothing else", () => {
    expect(bridge.isMcpToolName("mcp__example_docs__lookup")).toBe(true);
    expect(bridge.isMcpToolName("mcp__circlechat__update_task")).toBe(true);
    expect(bridge.isMcpToolName("update_task")).toBe(false);
    expect(bridge.isMcpToolName("mcp_")).toBe(false);
    expect(bridge.toolsInActions('<actions>[{"type":"mcp__circlechat__list_tasks"}]</actions>')).toEqual(["mcp__circlechat__list_tasks"]);
  });

  it("counts an unclosed <function=…> block whatever the name, and not a closed CircleChat action", () => {
    expect(bridge.hasUnclosedFunctionBlock("Moving it.\n<actions>\n<function=update_task>\n<parameter=status>\nreview\n</parameter>")).toBe(true);
    const closed = "Moving it to review.\n<actions>\n<function=update_task>\n<parameter=task_id>\ntask_demo\n</parameter>\n<parameter=status>\nreview\n</parameter>\n</function>\n</actions>";
    expect(bridge.hasUnclosedFunctionBlock(closed)).toBe(false);
    expect(bridge.isTextToolCall(closed)).toBe(false);
    expect(bridge.isTextToolCall(QUESTION)).toBe(false);
  });

  it("tells the agent the MCP name is a tool, not an unknown action", () => {
    expect(bridge.droppedActionErrors(["mcp__example_docs__lookup"])[0]).toMatch(
      /^tool_in_actions: mcp__example_docs__lookup is a tool, not an action\./,
    );
  });

  it("reruns the turn once with the reminder, which names MCP tools, and posts the rerun's reply", async () => {
    expect(bridge.TOOL_CALL_REMINDER).toContain("or an mcp__ tool such as a docs lookup");
    const t = turns(REPLY, QUESTION);
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: false, timeoutMs: 480_000 });
    expect(t.prompts).toEqual(["PROMPT", `PROMPT\n\n${bridge.TOOL_CALL_REMINDER}`]);
    expect(r).toMatchObject({ rawText: QUESTION, reran: true, silent: false, toolCallAsText: false });
  });

  it("reruns only once: the same reply again is silent, never posted", async () => {
    const t = turns(REPLY, REPLY, QUESTION);
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: false, timeoutMs: 480_000 });
    expect(t.prompts).toHaveLength(2);
    expect(r).toMatchObject({ reran: true, silent: true, toolCallAsText: true });
  });
});

describe("a comment turn puts asking first on a task where the agent has not asked yet", () => {
  const entry = { handle: "designer", name: "Designer", hermesHome: "/opt/hermes-homes/.hermes-designer" };
  const packet = (recentComments: Array<{ memberId: string; memberHandle: string; bodyMd: string }>) => ({
    trigger: "task_comment",
    agent: { handle: "designer", name: "Designer", memberId: "m_agent" },
    members: { m_person: { kind: "user", handle: "pat" }, m_agent: { kind: "agent", handle: "designer" } },
    task: {
      id: "task_demo",
      title: "Test: pricing page",
      bodyMd: "I need a pricing page for our app with three plans, and a button to pick one.",
      status: "in_progress",
      recentComments,
    },
    inbox: [],
    myTasks: [{ id: "task_demo", title: "Test: pricing page", status: "in_progress" }],
  });
  const goAhead = { memberId: "m_person", memberHandle: "pat", bodyMd: "@designer Go ahead with this one." };
  const refusedNote = {
    memberId: "m_agent",
    memberHandle: "designer",
    bodyMd: "_My reply couldn't be posted here: the reply check refused it (reasoning_preamble). The start of it is saved on run run_demo._",
  };

  it("on the observed comment, says the whole reply is the question and no files are written", () => {
    const prompt = bridge.buildPrompt(entry, packet([refusedNote, goAhead]));
    expect(prompt).toContain(
      "Asking comes first: you have not asked on this task yet, so if your persona asks before working, your whole reply this turn is that question; write no files.",
    );
    expect(prompt.indexOf(bridge.ASK_FIRST_ON_COMMENT)).toBeLessThan(prompt.indexOf("A new comment landed on a task you're involved with."));
  });

  it("leaves it out once the agent has asked on the task", () => {
    const asked = { memberId: "m_agent", memberHandle: "designer", bodyMd: QUESTION };
    const answer = { memberId: "m_person", memberHandle: "pat", bodyMd: "New visitors." };
    expect(bridge.agentAskedOnTask(packet([asked, answer]))).toBe(true);
    const prompt = bridge.buildPrompt(entry, packet([asked, answer]));
    expect(prompt).not.toContain(bridge.ASK_FIRST_ON_COMMENT);
    expect(prompt).toContain("A new comment landed on a task you're involved with.");
  });

  it("does not count a refused-reply note, a person's question, or a question mark inside code as the agent asking", () => {
    expect(bridge.agentAskedOnTask(packet([refusedNote, goAhead]))).toBe(false);
    expect(bridge.agentAskedOnTask(packet([{ memberId: "m_person", memberHandle: "pat", bodyMd: "Can you start?" }]))).toBe(false);
    expect(bridge.agentAskedOnTask(packet([{ memberId: "m_agent", memberHandle: "designer", bodyMd: "Ran `ls ?` and ```\nwhat?\n```" }]))).toBe(false);
  });

  it("does not touch other turns", () => {
    const assigned = { ...packet([]), trigger: "task_assigned" };
    expect(bridge.buildPrompt(entry, assigned)).not.toContain(bridge.ASK_FIRST_ON_COMMENT);
  });
});
