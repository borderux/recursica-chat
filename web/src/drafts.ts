// SPDX-License-Identifier: AGPL-3.0-only
// Unsent drafts, kept in the browser per person and chat: the message box, and the blanks of a
// starter being filled in. A draft survives a lost connection, a server restart and a page reload;
// a successful send clears it. Files picked to send are not kept: a browser can't store them.
import { useCallback, useEffect, useRef, useState } from "react";

/** A draft older than this is dropped when read. */
export const DRAFT_TTL = 30 * 24 * 60 * 60_000;

/** Where a draft lives: one key per person, chat and part ("message", or a starter's blanks). */
export function draftKey(userId: string, chatId: string, part = "message"): string {
  return `cc:draft:${userId}:${chatId}:${part}`;
}

/** The part of localStorage this needs. */
export interface DraftStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function browserStore(): DraftStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage turned off
  }
}

/** Nothing worth keeping: an empty or blank text, or an object whose every value is. */
export function isEmptyDraft(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "object") return Object.values(v as object).every(isEmptyDraft);
  return false;
}

export function readDraft<T>(key: string, fallback: T, store: DraftStore | null = browserStore(), now = Date.now()): T {
  try {
    const raw = store?.getItem(key);
    if (!raw) return fallback;
    const d = JSON.parse(raw) as { at?: number; value?: T };
    if (typeof d.at !== "number" || now - d.at > DRAFT_TTL || d.value === undefined) {
      store?.removeItem(key);
      return fallback;
    }
    return d.value;
  } catch {
    return fallback;
  }
}

/** Keeps the draft, or removes it when it's empty (after a send, or the text was deleted). */
export function writeDraft(key: string, value: unknown, store: DraftStore | null = browserStore(), now = Date.now()): void {
  try {
    if (isEmptyDraft(value)) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify({ at: now, value }));
  } catch {
    /* full or turned off: the draft just isn't kept */
  }
}

/** useState that also keeps its value under `key`, and starts from what's kept there. */
export function useDraft<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: readDraft(key, fallback) }));
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  // another chat or person: start from that one's draft
  const current = state.key === key ? state.value : readDraft(key, fallback);
  useEffect(() => {
    if (state.key !== key) setState({ key, value: readDraft(key, fallbackRef.current) });
  }, [key, state.key]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setState((s) => {
        const prev = s.key === key ? s.value : readDraft(key, fallbackRef.current);
        const value = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        writeDraft(key, value);
        return { key, value };
      }),
    [key],
  );
  return [current, set];
}
