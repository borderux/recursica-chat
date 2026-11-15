// Fork: the Slack member ID field, for Slack DMs about mentions. The modal
// after sign-in (SlackPrompt) and Settings → Profile (SlackDmsSection) use the
// same form. The person types the ID, a code arrives as a Slack DM, and the
// person types the code. Only a verified ID gets DMs.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSpectator } from "../lib/hooks";
import Modal from "./Modal";
import { FIND_ID_STEPS, isSlackId, normalizeSlackId, slackLinkError, waitingForCode, type SlackLink } from "../lib/slackLink";

export function useSlackLink(enabled = true) {
  return useQuery<SlackLink>({
    queryKey: ["slack-link"],
    queryFn: () => api.get<SlackLink>("/users/me/slack"),
    enabled,
    staleTime: 30_000,
    // While the code is on the way, check every 3 seconds.
    refetchInterval: (q) => (waitingForCode(q.state.data) ? 3000 : false),
  });
}

function SlackLinkForm({ link, onVerified }: { link: SlackLink; onVerified?: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState("");
  const [code, setCode] = useState("");
  const [editing, setEditing] = useState(!link.slackUserId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (link.sendError) setErr(slackLinkError(link.sendError)); }, [link.sendError]);

  async function run(fn: () => Promise<SlackLink>) {
    setBusy(true);
    setErr(null);
    try {
      qc.setQueryData(["slack-link"], await fn());
      return true;
    } catch (e) {
      setErr(slackLinkError((e as Error).message));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const sendCode = (slackUserId: string) => run(() => api.post<SlackLink>("/users/me/slack", { slackUserId }));
  async function verify() {
    if (await run(() => api.post<SlackLink>("/users/me/slack/verify", { code: code.trim() }))) {
      setCode("");
      setEditing(false);
      onVerified?.();
    }
  }

  const pending = link.pendingSlackUserId;
  if (link.slackUserId && !editing && !pending) {
    return (
      <div className="flex items-center gap-3 text-[13px]">
        <span>Slack DMs go to <span className="font-mono">{link.slackUserId}</span>.</span>
        <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>Change</button>
        <button className="btn sm" disabled={busy} onClick={() => run(() => api.del<SlackLink>("/users/me/slack"))}>Remove</button>
        {err && <span role="alert" className="text-[var(--color-err)]">{err}</span>}
      </div>
    );
  }

  return (
    <div className="text-[13px] flex flex-col gap-2">
      {link.slackUserId && <p>Slack DMs go to <span className="font-mono">{link.slackUserId}</span> until you verify a new ID.</p>}
      {!pending || link.codeStatus === "failed" ? (
        <>
          <label htmlFor="slack-id" className="text-[var(--color-muted)]">Slack member ID</label>
          <div className="flex gap-2">
            <input
              id="slack-id"
              value={id}
              disabled={busy}
              onChange={(e) => setId(e.target.value)}
              placeholder="U0123ABCD"
              maxLength={20}
              className="border border-[var(--color-hair-2)] rounded px-2 py-1.5 font-mono flex-1"
            />
            <button className="btn sm primary disabled:opacity-40" disabled={busy || !isSlackId(id)} onClick={() => sendCode(normalizeSlackId(id))}>
              Send code
            </button>
          </div>
          <p className="text-[12px] text-[var(--color-muted)]">{FIND_ID_STEPS}</p>
        </>
      ) : link.codeStatus === "requested" ? (
        <p>Sending a code to <span className="font-mono">{pending}</span> in Slack…</p>
      ) : (
        <>
          <p>
            {link.codeStatus === "sent"
              ? <>We sent a 6-digit code to <span className="font-mono">{pending}</span> in Slack. The code works for 10 minutes.</>
              : <>The code for <span className="font-mono">{pending}</span> no longer works.</>}
          </p>
          <div className="flex gap-2">
            {link.codeStatus === "sent" && (
              <>
                <label htmlFor="slack-code" className="sr-only">Code</label>
                <input
                  id="slack-code"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  className="border border-[var(--color-hair-2)] rounded px-2 py-1.5 font-mono w-32"
                />
                <button className="btn sm primary disabled:opacity-40" disabled={busy || !/^\d{6}$/.test(code.trim())} onClick={verify}>Verify</button>
              </>
            )}
            <button className="btn sm" disabled={busy} onClick={() => sendCode(pending)}>Send a new code</button>
            <button className="btn sm" disabled={busy} onClick={() => { setId(""); run(() => api.del<SlackLink>("/users/me/slack")); }}>Use another ID</button>
          </div>
        </>
      )}
      {err && <p role="alert" className="text-[var(--color-err)]">{err}</p>}
    </div>
  );
}

// Settings → Profile: add, change or remove the ID.
export function SlackDmsSection() {
  const spectator = useSpectator();
  const link = useSlackLink(!spectator);
  if (spectator || !link.data) return null;
  return (
    <div className="mt-4 pt-4 border-t border-[var(--color-hair)]">
      <h3 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Slack DMs</h3>
      <p className="text-[12px] text-[var(--color-muted)] mb-2">When someone mentions you in CircleChat, you get a DM in Slack.</p>
      <SlackLinkForm link={link.data} />
    </div>
  );
}

// The modal after sign-in: once for each person with no verified ID. Skip,
// a close or a verified ID ends the asking.
export function SlackPrompt() {
  const qc = useQueryClient();
  const spectator = useSpectator();
  const link = useSlackLink(!spectator);
  const [closed, setClosed] = useState(false);
  if (spectator || closed || !link.data?.prompt) return null;
  async function close() {
    setClosed(true);
    try { qc.setQueryData(["slack-link"], await api.post<SlackLink>("/users/me/slack/skip")); } catch { /* the modal asks again after the next sign-in */ }
  }
  return (
    <Modal onClose={close} className="w-[440px] max-w-[92vw] p-5">
      <h2 className="text-[15px] font-semibold mb-1">Get Slack DMs for mentions</h2>
      <p className="text-[13px] text-[var(--color-muted)] mb-3">When someone mentions you in CircleChat, you can get a DM in Slack. Add your Slack member ID.</p>
      <SlackLinkForm link={link.data} onVerified={() => setClosed(true)} />
      <div className="flex justify-end mt-4">
        <button className="btn sm" onClick={close}>Skip</button>
      </div>
    </Modal>
  );
}
