// SPDX-License-Identifier: AGPL-3.0-only
// Service accounts (server/src/serviceaccounts.ts): an identity for a program, with a long-lived
// token that root makes, that works only on /api/service/* and only from the server's own computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startApp, setupOwner } from "./helpers.ts";
import { serviceCommand, serviceRequest, listServices, SERVICE_TOKEN_PREFIX } from "../server/src/serviceaccounts.ts";

const call = (url: string, path: string, headers: Record<string, string> = {}) => fetch(url + path, { headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("service accounts: made, given a token, listed and revoked by command; the token is never stored", async () => {
  const h = await startApp();
  try {
    const db = h.app.db;
    for (const bad of ["", "A", "x", "has space", "-lead", "under_score", "a".repeat(41)]) assert.throws(() => serviceCommand(db, "service-create", [bad]), Error, bad);
    assert.match(serviceCommand(db, "service-create", ["example-service"]).stderr ?? "", /Made the service example-service/);
    assert.throws(() => serviceCommand(db, "service-create", ["example-service"]), /already/);
    assert.throws(() => serviceCommand(db, "service-token", ["no-such-service"]), /no service/);
    assert.throws(() => serviceCommand(db, "service-token", []), /usage/);
    assert.match(serviceCommand(db, "service-list", []).stdout ?? "", /^example-service {2}token: none/);

    const t = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
    assert.ok(t.startsWith(SERVICE_TOKEN_PREFIX) && t.length > 40, "a long random token with its prefix");
    const dump = JSON.stringify(db.prepare("SELECT * FROM service_accounts").all());
    assert.ok(!dump.includes(t) && !dump.includes(t.slice(SERVICE_TOKEN_PREFIX.length)), "only the token's hash is stored");
    const list = serviceCommand(db, "service-list", []).stdout ?? "";
    assert.match(list, /token: yes/);
    assert.ok(!list.includes(t.slice(SERVICE_TOKEN_PREFIX.length, 20)), "the list never shows a token");

    // a new token replaces the old one
    const t2 = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
    assert.notEqual(t2, t);
    assert.equal((await call(h.url, "/api/service/me", bearer(t))).status, 401, "the old token stops working");
    const me = await call(h.url, "/api/service/me", bearer(t2));
    assert.equal(me.status, 200);
    assert.equal((await me.json()).service.name, "example-service");
    assert.ok(listServices(db)[0].lastUsedAt, "last used is recorded");

    // revoked: refused until a new token
    serviceCommand(db, "service-revoke", ["example-service"]);
    assert.equal((await call(h.url, "/api/service/me", bearer(t2))).status, 401);
    assert.match(serviceCommand(db, "service-list", []).stdout ?? "", /token: revoked/);
    const t3 = serviceCommand(db, "service-token", ["example-service"]).stdout ?? "";
    assert.equal((await call(h.url, "/api/service/me", bearer(t3))).status, 200);
  } finally {
    await h.close();
  }
});

test("service accounts: the token works only on the service routes, and a session never works there", async () => {
  const h = await startApp();
  try {
    const owner = await setupOwner(h);
    serviceCommand(h.app.db, "service-create", ["example-service"]);
    const t = serviceCommand(h.app.db, "service-token", ["example-service"]).stdout ?? "";

    assert.equal((await call(h.url, "/api/me", bearer(t))).status, 401, "a person's route refuses a service token");
    assert.equal((await call(h.url, "/api/chats", bearer(t))).status, 401);
    assert.equal((await call(h.url, "/api/users", bearer(t))).status, 401);
    assert.equal((await call(h.url, "/api/service/me")).status, 401, "no token");
    assert.equal((await call(h.url, "/api/service/me", bearer("ccsvc_" + "x".repeat(43)))).status, 401, "a made-up token");

    // a person's session, as a cookie (a browser) or as a Bearer token
    const session = owner.cookie.replace(/^cc_session=/, "");
    assert.equal((await call(h.url, "/api/service/me", { cookie: owner.cookie })).status, 403);
    assert.equal((await call(h.url, "/api/service/me", bearer(session))).status, 401);
    assert.equal((await owner.get("/api/service/me")).status, 403, "the web app's own requests are refused");

    // an unknown service path ends here, never in a person's routes
    assert.equal((await call(h.url, "/api/service/nothing", bearer(t))).status, 404);
  } finally {
    await h.close();
  }
});

test("service accounts: only from the server's own computer, straight to the server", async () => {
  const h = await startApp();
  try {
    serviceCommand(h.app.db, "service-create", ["example-service"]);
    const t = serviceCommand(h.app.db, "service-token", ["example-service"]).stdout ?? "";
    assert.equal((await call(h.url, "/api/service/me", bearer(t))).status, 200);
    for (const [k, v] of [
      ["origin", h.url],
      ["sec-fetch-site", "same-origin"],
      ["cookie", "other=1"],
      ["x-forwarded-for", "100.64.0.1"],
      ["x-forwarded-host", "chat.example.com"],
      ["forwarded", "for=100.64.0.1"],
      ["tailscale-user-login", "person-a@example.com"],
    ]) {
      const r = await call(h.url, "/api/service/me", { ...bearer(t), [k]: v });
      assert.equal(r.status, 403, k);
    }
    // from another address
    const headers = (o: Record<string, string>) => (n: string) => o[n];
    const r = serviceRequest(h.app.db, headers({ authorization: `Bearer ${t}` }), "192.168.1.20");
    assert.ok("error" in r && r.status === 403);
    assert.ok("service" in serviceRequest(h.app.db, headers({ authorization: `Bearer ${t}` }), "::ffff:127.0.0.1"));
  } finally {
    await h.close();
  }
});

test("service accounts: every command is root's only", { skip: process.getuid?.() === 0 ? "runs as root here" : false }, () => {
  for (const cmd of ["service-create", "service-token", "service-revoke", "service-list"]) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "server", "src", "cli.ts"), cmd, "example-service"], {
      env: { ...process.env, CIRCLECHAT_DATA: import.meta.dirname },
      encoding: "utf8",
    });
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /only root/, cmd);
    assert.equal(r.stdout, "", cmd);
  }
});
