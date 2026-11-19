// SPDX-License-Identifier: AGPL-3.0-only
// A model provider set on the server by its operator, for a script that hands each agent its own
// key without anyone pasting, seeing or copying the key.
//
//   sudo node server/src/cli.ts set-provider <id> --base-url <url> --models <a,b>   key on stdin
//   sudo node server/src/cli.ts provider-key-hash <id>                             prints a SHA-256
//
// - Only root may run either, like `session` (clisession.ts): the key is a way to the model.
// - set-provider reads the key from stdin only: never from an argument, and never printed. Empty
//   stdin keeps the provider's stored key. The provider is OpenAI-compatible.
// - set-provider changes only a provider it made. A provider added in the app stays as the app's.
// - provider-key-hash prints the SHA-256 of the stored key, or nothing when there is none, so a
//   script can tell whether the stored key is current without reading the key.
import { createHash } from "node:crypto";
import type { App } from "./app.ts";

export const CLI_LABEL = (id: string) => `${id} (set by the server's CLI)`;
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const USAGE = "usage: cli.ts set-provider <id> --base-url <url> --models <a,b>";

/** Parses `<id> --base-url <url> --models <a,b>`. Throws with a message for the person at the keyboard. */
export function providerArgs(args: string[]): { id: string; baseUrl: string; models: string[] } {
  const [id, ...rest] = args;
  if (!id || !ID.test(id)) throw new Error(`${USAGE} (the id: lowercase letters, digits, - and _)`);
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!["--base-url", "--models"].includes(flag) || value === undefined || opts[flag] !== undefined) throw new Error(USAGE);
    opts[flag] = value;
  }
  const baseUrl = opts["--base-url"];
  if (!baseUrl || !/^https?:\/\/\S+$/.test(baseUrl)) throw new Error(`${USAGE} (--base-url: an http or https address)`);
  const models = (opts["--models"] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!models.length) throw new Error(`${USAGE} (--models: at least one model)`);
  return { id, baseUrl, models };
}

/** Adds or updates the provider. `key` is the text from stdin; empty keeps the stored key. */
export function setProvider(app: App, p: { id: string; baseUrl: string; models: string[] }, key: string): "added" | "updated" {
  const k = key.replace(/\r?\n$/, "");
  if (k && !/^\S{8,4096}$/.test(k)) throw new Error("stdin must hold the key alone, on one line");
  const existing = (app.providers(false) as any[]).find((x) => x.id === p.id);
  if (existing && existing.label !== CLI_LABEL(p.id)) throw new Error(`${p.id} was added in the app, so this command leaves it alone. Pick another id.`);
  if (!existing && !k) throw new Error(`${p.id} is new: stdin must hold its key`);
  app.upsertProvider({ id: p.id, kind: "openai-compatible", baseUrl: p.baseUrl, apiKey: k || undefined, models: p.models, label: CLI_LABEL(p.id) });
  return existing ? "updated" : "added";
}

/** The SHA-256 of the provider's stored key, or "" when there is no such provider or no key. */
export function providerKeyHash(app: App, id: string): string {
  const p = (app.providers(true) as any[]).find((x) => x.id === id);
  return p?.apiKey ? createHash("sha256").update(p.apiKey).digest("hex") : "";
}
