// SPDX-License-Identifier: AGPL-3.0-only
// A guard for tests that must never reach the internet, whatever the code under test does.
// Every TCP connection and every DNS lookup in this process goes through node:net and node:dns;
// the guard refuses any that isn't for loopback (or a local socket file) before a lookup or a
// packet happens, and records it. fetch, http, https and tls all connect through net.Socket.
import net from "node:net";
import dns from "node:dns";

const LOOPBACK = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

export interface NetworkGuard {
  /** every host:port, or host for a lookup, that something tried to reach */
  attempts: string[];
  release(): void;
}

export function noOutsideNetwork(): NetworkGuard {
  const attempts: string[] = [];
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;
  const realPromisesLookup = dns.promises.lookup;
  const refuse = (what: string) => new Error(`test guard: nothing may leave this machine (${what})`);

  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = args[0];
    const o = Array.isArray(first) ? first[0] : typeof first === "object" && first !== null ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    if (o && o.path === undefined) {
      const host = String(o.host ?? "localhost");
      if (!LOOPBACK(host)) {
        attempts.push(`${host}:${o.port}`);
        process.nextTick(() => this.destroy(refuse(`${host}:${o.port}`)));
        return this;
      }
    }
    return (realConnect as any).apply(this, args);
  } as any;
  (dns as any).lookup = function (host: string, ...rest: any[]) {
    if (!LOOPBACK(String(host))) {
      attempts.push(String(host));
      const cb = rest.find((x) => typeof x === "function");
      if (cb) process.nextTick(() => cb(refuse(String(host))));
      return;
    }
    return (realLookup as any).call(dns, host, ...rest);
  };
  (dns.promises as any).lookup = async (host: string, ...rest: any[]) => {
    if (!LOOPBACK(String(host))) {
      attempts.push(String(host));
      throw refuse(String(host));
    }
    return (realPromisesLookup as any).call(dns.promises, host, ...rest);
  };
  return {
    attempts,
    release() {
      net.Socket.prototype.connect = realConnect;
      (dns as any).lookup = realLookup;
      (dns.promises as any).lookup = realPromisesLookup;
    },
  };
}
