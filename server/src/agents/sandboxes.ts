// SPDX-License-Identifier: AGPL-3.0-only
// Which sandboxes this server allows agents to run in.
//   CIRCLECHAT_SANDBOXES=docker,local   (default) both
//   CIRCLECHAT_SANDBOXES=docker         only Docker containers
// An agent that runs as a process on the server, rather than in a container, runs as the server's
// own user: it can read the data folder, the vault key and the server's environment. With
// "docker" alone, the API refuses the local sandbox, and the runtime refuses to start any agent
// that would run on the server: one set to the local sandbox, or one whose engine has no Docker
// image (the test engines).

export type Sandbox = "docker" | "local";
const ALL: Sandbox[] = ["docker", "local"];

/** The sandboxes the server allows. Throws on a name it doesn't know, so a typo fails closed. */
export function allowedSandboxes(env: NodeJS.ProcessEnv = process.env): Set<Sandbox> {
  const raw = (env.CIRCLECHAT_SANDBOXES ?? "").trim().toLowerCase();
  if (!raw) return new Set(ALL);
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!ALL.includes(n as Sandbox)) throw new Error(`CIRCLECHAT_SANDBOXES: "${n}" isn't a sandbox (use docker, local or both)`);
  if (!names.length) throw new Error("CIRCLECHAT_SANDBOXES lists no sandbox (use docker, local or both)");
  return new Set(names as Sandbox[]);
}

/** Why the API can't save this sandbox for an agent, or null when it can. */
export function sandboxProblem(sandbox: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ALL.includes(sandbox as Sandbox)) return "sandbox must be docker or local";
  if (!allowedSandboxes(env).has(sandbox as Sandbox)) return `This server allows only the ${[...allowedSandboxes(env)].join(" and ")} sandbox (CIRCLECHAT_SANDBOXES).`;
  return null;
}

/**
 * Why the runtime won't start this agent, or null when it may. An agent runs on the server unless
 * its sandbox is docker and its engine has an image.
 */
export function startProblem(sandbox: string, engine: { name: string; image: string }, env: NodeJS.ProcessEnv = process.env): string | null {
  if (sandbox === "docker" && engine.image) return null;
  if (allowedSandboxes(env).has("local")) return null;
  const why = sandbox === "docker" ? `the ${engine.name} engine has no Docker image, so it would run on the server` : "it is set to the local sandbox, which runs on the server";
  return `this server allows only Docker sandboxes (CIRCLECHAT_SANDBOXES), and ${why}`;
}
