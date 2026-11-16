// SPDX-License-Identifier: AGPL-3.0-only
// An agent container's settings reach `docker run` by name only (`-e NAME`), with the values in the
// docker process's own environment. Every account on the host can list a process's arguments, so a
// model key, or the model proxy's stand-in token, must never be one. A stand-in `docker` on PATH
// records exactly what the runtime passes it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, setupOwner, waitFor, Client, type Harness } from "./helpers.ts";
import { dockerEnv } from "../server/src/agents/dockerenv.ts";

test("dockerEnv: fixed values as NAME=value, everything else by name only", () => {
  const r = dockerEnv({ HOME: "/home/agent" }, { GEMINI_API_KEY: "example-secret-value", HERMES_HOME: "/var/lib/hermes/home" });
  assert.deepEqual(r.args, ["-e", "HOME=/home/agent", "-e", "GEMINI_API_KEY", "-e", "HERMES_HOME"]);
  assert.deepEqual(r.env, { GEMINI_API_KEY: "example-secret-value", HERMES_HOME: "/var/lib/hermes/home" });
  assert.ok(!r.args.some((a) => a.includes("example-secret-value")));
});

test("dockerEnv: refuses a name docker reads for itself, a name set twice, and a name that isn't one", () => {
  for (const name of ["HOME", "PATH", "TMPDIR", "DOCKER_HOST", "docker_config", "HTTP_PROXY", "https_proxy", "NO_PROXY"]) {
    assert.throws(() => dockerEnv({}, { [name]: "x" }), /read by docker itself/, name);
  }
  assert.throws(() => dockerEnv({ HOME: "/home/agent" }, { HOME: "/elsewhere" }), /set twice/);
  assert.throws(() => dockerEnv({}, { "A=B": "x" }), /not a variable name/);
  assert.throws(() => dockerEnv({}, { "": "x" }), /not a variable name/);
});

// A stand-in docker: `docker run` writes its arguments and its environment to files, then fails,
// so the agent never starts. Every other docker command does nothing.
let h: Harness;
let c: Client;
let out: string;
let savedPath: string | undefined;
const REAL_KEY = "example-provider-key-7f3a9c1e5b";
const PROXIED_KEY = "example-anthropic-key-2d8b6e4a0c";

before(async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  out = mkdtempSync(join(tmpdir(), "fake-docker-out-"));
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
if [ "$1" = run ]; then
  f="${out}/run-$$"
  for a in "$@"; do printf '%s\\n' "$a"; done > "$f.args"
  env > "$f.env"
  exit 1
fi
exit 0
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  h = await startApp();
  c = await setupOwner(h);
});
after(async () => {
  await h.close();
  process.env.PATH = savedPath;
  rmSync(out, { recursive: true, force: true });
});

/** Start an agent in the docker sandbox, and return what the stand-in docker recorded for it. */
async function recordRun(handle: string, engine: string, model: string): Promise<{ args: string[]; env: Map<string, string> }> {
  const seen = new Set(readdirSync(out));
  const r = await c.post("/api/agents", { name: handle[0].toUpperCase() + handle.slice(1), handle, engine, model, sandbox: "docker" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const chat = (await c.post("/api/chats", { dmAgent: r.json.agent.id })).json.chat;
  await c.post(`/api/chats/${chat.id}/messages`, { body: "hello" });
  const file = await waitFor(() => readdirSync(out).find((f) => f.endsWith(".env") && !seen.has(f)), `docker run for ${handle}`);
  const base = join(out, file.replace(/\.env$/, ""));
  await waitFor(() => readdirSync(out).includes(file.replace(/\.env$/, ".args")), "the arguments file");
  const args = readFileSync(`${base}.args`, "utf8").split("\n").filter(Boolean);
  const env = new Map(
    readFileSync(`${base}.env`, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]),
  );
  return { args, env };
}

test("an engine that gets the provider's real key: by name in the arguments, the value only in docker's environment", async () => {
  assert.equal((await c.put("/api/providers/example-google", { kind: "openai-compatible", baseUrl: "https://models.example.com/v1", apiKey: REAL_KEY, models: ["m1"] })).status, 200);
  const { args, env } = await recordRun("designer", "gemini", "example-google:m1");
  assert.ok(!args.some((a) => a.includes(REAL_KEY)), "the key is not in docker's arguments");
  assert.ok(args.join("\n").includes("-e\nGEMINI_API_KEY\n"), "the key's name is");
  assert.equal(env.get("GEMINI_API_KEY"), REAL_KEY, "docker's environment holds the value, for docker to copy into the container");
  assert.ok(args.join("\n").includes("-e\nHOME=/home/agent\n"), "the fixed HOME stays NAME=value");
  assert.ok(!args.some((a) => /^[A-Z_]+_API_KEY=/.test(a)), "no NAME=value for a key");
});

test("an engine behind the model proxy: the stand-in token is never an argument, and the real key goes nowhere", async () => {
  assert.equal((await c.put("/api/providers/example-anthropic", { kind: "anthropic", baseUrl: "https://api.example.com", apiKey: PROXIED_KEY, models: ["m2"] })).status, 200);
  const { args, env } = await recordRun("reviewer", "claude", "example-anthropic:m2");
  const token = env.get("ANTHROPIC_API_KEY") ?? "";
  assert.match(token, /^ccm_/, "the container gets the proxy's stand-in token");
  assert.ok(!args.some((a) => a.includes(token)), "the stand-in token is not in docker's arguments");
  assert.ok(args.join("\n").includes("-e\nANTHROPIC_API_KEY\n"));
  const everything = args.join("\n") + "\n" + [...env.values()].join("\n");
  assert.ok(!everything.includes(PROXIED_KEY), "the provider's real key reaches neither the arguments nor docker's environment");
});
