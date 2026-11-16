// SPDX-License-Identifier: AGPL-3.0-only
// How an agent container gets its environment without the values showing in a process list.
//
// Every account on the host can read a process's arguments (ps). `docker run -e NAME=value` would
// put an engine's model key, or the model proxy's stand-in token, in the arguments of a docker
// process that lives as long as the agent. Instead the arguments carry only `-e NAME`, and the
// values go in the docker process's own environment, which only its own account and root can read.
// docker then copies each named variable into the container, so the container sees the same values.
//
// Fixed values that are not secrets, such as the agent's HOME, stay as `-e NAME=value`: the docker
// process reads HOME, PATH, the proxy settings and its own DOCKER_* settings for itself, so those
// names must never be set in its environment on an agent's behalf.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCKER_READS = /^(HOME|PATH|TMPDIR|USER|SHELL|DOCKER_.*|(HTTPS?|ALL|NO)_PROXY)$/i;

export interface DockerEnv {
  /** `docker run` arguments: `-e NAME=value` for the fixed values, `-e NAME` for the rest. */
  args: string[];
  /** Variables to add to the docker process's environment, one for each `-e NAME`. */
  env: Record<string, string>;
}

/**
 * `fixed` holds values that may appear in arguments (never a secret). `byName` holds the engine's
 * settings, which may be secrets: they reach the container by name only. Throws on a name that
 * isn't a plain variable name, or that docker itself reads.
 */
export function dockerEnv(fixed: Record<string, string>, byName: Record<string, string>): DockerEnv {
  const args: string[] = [];
  for (const [k, v] of Object.entries(fixed)) {
    if (!NAME.test(k)) throw new Error(`not a variable name: ${k}`);
    if (k in byName) throw new Error(`${k} is set twice`);
    args.push("-e", `${k}=${v}`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(byName)) {
    if (!NAME.test(k)) throw new Error(`not a variable name: ${k}`);
    if (DOCKER_READS.test(k)) throw new Error(`${k} is read by docker itself, so an engine can't set it`);
    args.push("-e", k);
    env[k] = String(v);
  }
  return { args, env };
}
