import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { TURN_PHASES, isTurnPhase, showsOnTask } from "../lib/task-working.js";

// While a task assignee's turn on that task runs, from its start until its
// reply, the task card shows "designer is working, 2 min: reading skills" and
// the board card a working marker. The worker records the turn; the bridge
// reads the step from the turn's Hermes session and sends it.

type Bridge = {
  phaseOfTool: (name: string) => string;
  phaseFromToolCalls: (raw: unknown) => string;
  watchTurnPhase: (o: { read: () => Promise<string | null>; send: (p: string) => void; every?: number }) => () => void;
  TURN_PHASES: string[];
  TURN_PHASE_MS: number;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});
afterEach(() => vi.useRealTimers());

const api = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const bridgeSrc = () => readFileSync(resolve(__dirname, "../../hermes-multi-bridge.mjs"), "utf8");

describe("the step a turn is on", () => {
  it("comes from the kind of tool its latest call uses", () => {
    expect(bridge.phaseOfTool("skill_view")).toBe("reading skills");
    expect(bridge.phaseOfTool("skills_list")).toBe("reading skills");
    expect(bridge.phaseOfTool("read_file")).toBe("reading files");
    expect(bridge.phaseOfTool("write_file")).toBe("writing files");
    expect(bridge.phaseOfTool("patch")).toBe("writing files");
    expect(bridge.phaseOfTool("terminal")).toBe("running a command");
    expect(bridge.phaseOfTool("web_search")).toBe("searching the web");
    expect(bridge.phaseOfTool("browser_navigate")).toBe("using the browser");
    expect(bridge.phaseOfTool("delegate_task")).toBe("delegating");
    expect(bridge.phaseOfTool("mcp__example_docs__lookup")).toBe("using tools");
    expect(bridge.phaseOfTool("something_new")).toBe("using tools");
  });

  it("is the last call's tool in a message's tool_calls, or thinking without one", () => {
    const calls = JSON.stringify([
      { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "skill_view", arguments: "{}" } },
    ]);
    expect(bridge.phaseFromToolCalls(calls)).toBe("reading skills");
    expect(bridge.phaseFromToolCalls(JSON.stringify([{ name: "terminal" }]))).toBe("running a command");
    expect(bridge.phaseFromToolCalls("[]")).toBe("thinking");
    expect(bridge.phaseFromToolCalls(null)).toBe("thinking");
    expect(bridge.phaseFromToolCalls("not json")).toBe("thinking");
  });

  it("uses only the steps the api keeps", () => {
    expect(bridge.TURN_PHASES).toEqual([...TURN_PHASES]);
    for (const n of ["skill_view", "read_file", "write_file", "terminal", "web_search", "browser_click", "delegate_task", "x"]) {
      expect(isTurnPhase(bridge.phaseOfTool(n))).toBe(true);
    }
    expect(isTurnPhase("starting")).toBe(true);
    expect(isTurnPhase("writing the reply")).toBe(true);
    expect(isTurnPhase("anything an agent types")).toBe(false);
    expect(isTurnPhase(undefined)).toBe(false);
  });
});

describe("the bridge sends each change of step while the turn runs", () => {
  it("reads every 15 s and sends a step only when it changes", async () => {
    expect(bridge.TURN_PHASE_MS).toBe(15_000);
    vi.useFakeTimers();
    const steps = ["thinking", "thinking", "reading skills", null, "writing files"];
    const sent: string[] = [];
    const stop = bridge.watchTurnPhase({ read: async () => steps.shift() ?? null, send: (p) => sent.push(p), every: 1000 });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["thinking", "reading skills", "writing files"]);
    stop();
    steps.push("delegating");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual(["thinking", "reading skills", "writing files"]);
  });

  it("says starting when the turn takes its slot, and writing the reply when the container is done", () => {
    const src = bridgeSrc();
    const handler = src.slice(src.indexOf("function connect(entry) {"));
    const reap = handler.indexOf("if (usesTurnContainers(entry)) await reapTurnContainers([entry.handle]);");
    expect(handler.indexOf('progress("starting");')).toBeGreaterThan(reap);
    const run = handler.slice(handler.indexOf("const runOnce = async (promptText) => {"));
    expect(run.indexOf("watchTurnPhase(")).toBeLessThan(run.indexOf("await callHermes("));
    expect(run.indexOf("stopPhase();")).toBeGreaterThan(run.indexOf("await callHermes("));
    expect(run.indexOf('progress("writing the reply");')).toBeGreaterThan(run.indexOf("stopPhase();"));
    expect(handler).toMatch(/type: "progress", phase/);
  });
});

describe("the api", () => {
  it("shows a turn only for one of the task's assignees", () => {
    expect(showsOnTask(["mem_designer", "mem_person_a"], "mem_designer")).toBe(true);
    expect(showsOnTask(["mem_person_a"], "mem_designer")).toBe(false);
    expect(showsOnTask(["mem_person_a"], null)).toBe(false);
  });

  it("keeps a progress frame's step from the agent's socket, through the vocabulary check", () => {
    const socket = api("ws/agent-socket.ts");
    expect(socket).toMatch(/data\.type === "progress"\) \{[\s\S]*?await setTurnPhase\(agent\.id, data\.phase\);/);
    const lib = api("lib/task-working.ts");
    expect(lib).toMatch(/export async function setTurnPhase\(agentId: string, phase: unknown\): Promise<void> \{\s*if \(!isTurnPhase\(phase\)\) return;/);
  });

  it("records the turn when it starts on a task, and removes it when the turn ends, however it ended", () => {
    const worker = api("worker.ts");
    const start = worker.indexOf("await startTaskWork({ runId, agentId: agent.id, taskId: payload.taskId, workspaceId: agent.workspaceId });");
    expect(start).toBeGreaterThan(worker.indexOf("const claim = await claimTurn("));
    expect(start).toBeLessThan(worker.indexOf("const packet = await buildContext("));
    const fin = worker.slice(worker.indexOf("    } finally {"));
    expect(fin.indexOf("if (started) await endTaskWork(started);")).toBeGreaterThan(0);
    expect(fin.indexOf("if (started) await endTaskWork(started);")).toBeLessThan(fin.indexOf("await releaseTurn("));
    // A turn a restarted worker left behind shows no more.
    const boot = worker.slice(worker.indexOf("async function startAgentWorker()"));
    expect(boot).toMatch(/recoverAfterRestart\(\);\s*await clearStaleTaskWork\(\)/);
  });

  it("tells the workspace each time a task's working state changes", () => {
    const lib = api("lib/task-working.ts");
    expect(lib).toMatch(/publishToWorkspace\(workspaceId, \{ type: "task\.working", workspaceId, taskId \}\)/);
    expect(api("lib/events.ts")).toMatch(/type: "task\.working"; workspaceId: string; taskId: string/);
  });

  it("lists only turns still running, at GET /api/tasks/working", () => {
    const lib = api("lib/task-working.ts");
    expect(lib).toMatch(/innerJoin\(agentRuns, and\(eq\(agentRuns\.id, taskTurnActivity\.runId\), eq\(agentRuns\.status, "running"\)\)\)/);
    expect(api("routes/task-working.ts")).toMatch(/app\.get\("\/tasks\/working", \{ preHandler: requireWorkspace \}/);
    expect(api("index.ts")).toMatch(/await app\.register\(taskWorkingRoutes, \{ prefix: "\/api" \}\)/);
  });

  it("creates its table in a fork migration that is safe to run on every start", () => {
    const dir = resolve(__dirname, "../../migrations/fork");
    const file = readdirSync(dir).find((f) => f.endsWith("_task_turn_activity.sql"));
    expect(file).toBeTruthy();
    const sql = readFileSync(resolve(dir, file!), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "task_turn_activity"/);
    for (const stmt of sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(stmt).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
    }
  });
});

describe("the web", () => {
  const web = (p: string) => readFileSync(resolve(__dirname, "../../../web/src", p), "utf8");

  it("shows the line on the task card and the marker on the board card", () => {
    expect(web("components/TaskModal.tsx")).toMatch(/<TaskWorkingLine taskId=\{t\.id\} \/>/);
    expect(web("components/Board.tsx")).toMatch(/<BoardWorkingMarker work=\{workOnTask\(working, c\.id\)\} \/>/);
  });

  it("refreshes on task.working and when a run finishes", () => {
    expect(web("components/TaskWorking.tsx")).toMatch(/ev\.type === "task\.working" \|\| ev\.type === "agent\.run\.finished"/);
  });
});
