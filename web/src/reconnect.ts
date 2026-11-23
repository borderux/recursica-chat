// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the live connection up: after a drop (a server restart, a proxy answering 502 while it comes
// back) it tries again with a capped backoff, and calls onUp on each open so the app catches up on
// what it missed. Plain functions with the socket and the clock passed in, so a test can drive them.

/** The first wait after a drop, and the most it ever waits between tries. */
export const FIRST_DELAY = 500;
export const MAX_DELAY = 10_000;

/** The wait after `prev`: doubled, at most MAX_DELAY. */
export function nextDelay(prev: number): number {
  return Math.min(Math.max(prev, FIRST_DELAY) * 2, MAX_DELAY);
}

/** The part of a WebSocket this needs. */
export interface SocketLike {
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  close(): void;
}

export interface Clock {
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
}

const realClock: Clock = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as any) };

/**
 * Opens a socket with `open`, and opens a new one each time it closes, until the returned stop is
 * called. The wait starts at FIRST_DELAY, doubles on each failed try up to MAX_DELAY, and goes back
 * to FIRST_DELAY once a socket opens. onUp runs on every open (the first and each reconnect), onDown
 * on every close.
 */
export function keepConnected(
  open: () => SocketLike,
  on: { up: () => void; down: () => void; message: (data: unknown) => void },
  clock: Clock = realClock,
): () => void {
  let ws: SocketLike | null = null;
  let stop = false;
  let delay = FIRST_DELAY;
  let timer: unknown;
  const connect = () => {
    timer = undefined;
    if (stop) return;
    const s = open();
    ws = s;
    s.onopen = () => {
      delay = FIRST_DELAY;
      on.up();
    };
    s.onmessage = (m: { data: unknown }) => on.message(m.data);
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      on.down();
      if (stop) return;
      timer = clock.set(connect, delay);
      delay = nextDelay(delay);
    };
  };
  connect();
  return () => {
    stop = true;
    if (timer !== undefined) clock.clear(timer);
    ws?.close();
  };
}
