// SPDX-License-Identifier: AGPL-3.0-only
// A note while the live connection is down (a server restart, a lost network): the app is trying
// again by itself (../reconnect.ts), and catches up when it's back. Unsent drafts are kept
// (../drafts.ts). It waits a moment before showing, so a quick blip shows nothing.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.tsx";

/** How long the connection is down before the note shows. */
export const SHOW_AFTER = 1500;

export function Reconnecting() {
  const { online } = useStore();
  const wasUp = useRef(false);
  const [show, setShow] = useState(false);
  if (online) wasUp.current = true;
  useEffect(() => {
    if (online || !wasUp.current) return setShow(false);
    const t = window.setTimeout(() => setShow(true), SHOW_AFTER);
    return () => clearTimeout(t);
  }, [online]);
  if (!show || online) return null;
  return (
    <div className="credit-note" style={{ top: 20, left: "50%", right: "auto", transform: "translateX(-50%)", padding: "8px 16px" }} role="status" aria-live="polite" data-testid="reconnecting">
      <span>Reconnecting… Your drafts are kept.</span>
    </div>
  );
}
