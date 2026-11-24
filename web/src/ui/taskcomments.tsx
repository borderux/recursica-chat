// SPDX-License-Identifier: AGPL-3.0-only
// A task's comments (the server: server/src/taskcomments.ts), in the task's window over the Board
// (screens/BoardTask.tsx), and the small count on its card. Comments are plain text, rendered the way
// a chat message is: a person's with their @mentions marked, an agent's as Markdown, never as HTML.
// The list is live (task_comment events). The author, or an admin, deletes one, after a second click
// to confirm; a deleted one says "Comment deleted". A comment never reaches an agent: asking an agent
// something stays the Answer box, which posts in the chat. A question's buttons are ui/taskquestions.tsx.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type Task, type TaskComment } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Icon, UserAv, ago, dayLabel, withMentions } from "./ui.tsx";
import { Markdown } from "./Markdown.tsx";
import { QuestionChoices } from "./taskquestions.tsx";
import "../taskcomments.css";

export const MAX_COMMENT = 4000;

/** A comment's place in the list: the same comment again replaces it; a new one goes in by time. */
export function mergeComment(list: TaskComment[], c: TaskComment): TaskComment[] {
  const at = list.findIndex((x) => x.id === c.id);
  if (at >= 0) return list.map((x, i) => (i === at ? c : x));
  return [...list, c].sort((a, b) => a.createdAt - b.createdAt);
}

/** The count on a Board card: only when the task has comments. */
export function CommentCount({ t }: { t: Task }) {
  const n = t.commentCount ?? 0;
  if (n <= 0) return null;
  const label = `${n} comment${n === 1 ? "" : "s"}`;
  return (
    <span className="tc-count" title={label} aria-label={label}>
      <Icon n="chat" size="sm" />
      <span className="num">{n}</span>
    </span>
  );
}

export function TaskComments({ t }: { t: Task }) {
  const { fail } = useStore();
  const [list, setList] = useState<TaskComment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api
      .get<{ comments: TaskComment[] }>(`/api/tasks/${t.id}/comments`)
      .then((r) => {
        if (n !== seq.current) return;
        setList(r.comments);
        setFailed(false);
      })
      .catch(() => {
        if (n === seq.current) setFailed(true);
      });
  }, [t.id]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);
  useBus((e) => {
    // reconnected: comments may have come or gone while the connection was down
    if (e.type === "hello") void load();
    if (e.type !== "task_comment" || e.taskId !== t.id) return;
    setList((l) => (l ? mergeComment(l, e.comment) : l));
  });

  const shown = list?.filter((c) => !c.deleted).length ?? 0;
  return (
    <section className="tc" aria-label="Comments">
      <div className="bt-h">
        Comments{shown ? <span className="tc-n num"> {shown}</span> : null}
      </div>
      {list === null ? (
        <div className="small muted">{failed ? "The comments couldn't load." : "Loading..."}</div>
      ) : list.length ? (
        <ol className="tc-list">
          {list.map((c) => (
            <Comment key={c.id} c={c} onError={fail} onAnswered={(x) => setList((l) => mergeComment(l ?? [], x))} reload={() => void load()} />
          ))}
        </ol>
      ) : (
        <div className="small muted">No comments yet.</div>
      )}
      <CommentBox t={t} onPosted={(c) => setList((l) => mergeComment(l ?? [], c))} />
    </section>
  );
}

function Comment({ c, onError, onAnswered, reload }: { c: TaskComment; onError: (e: unknown) => void; onAnswered: (a: TaskComment) => void; reload: () => void }) {
  const { me, isAdmin, agent, user, who } = useStore();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = c.author.type === "agent" ? agent(c.author.id) : undefined;
  const u = c.author.type === "user" ? user(c.author.id) : undefined;
  const name = c.author.type === "agent" ? (a?.name ?? c.author.name) : u ? who(u.id) : c.author.name || "Someone";
  const mayDelete = !c.deleted && ((c.author.type === "user" && c.author.id === me.id) || isAdmin);
  const remove = () => {
    setBusy(true);
    api
      .del(`/api/tasks/${c.taskId}/comments/${c.id}`)
      .catch(onError)
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };
  return (
    <li className={"tc-item" + (c.deleted ? " tc-gone" : "")} data-comment={c.id}>
      <span className="tc-av">{c.author.type === "agent" ? <AgentAv a={a} size={24} dot={false} /> : <UserAv u={u} size={24} />}</span>
      <div className="tc-main">
        <div className="tc-h">
          <b className="tc-who">{name}</b>
          <time className="small muted" dateTime={new Date(c.createdAt).toISOString()} title={dayLabel(c.createdAt)}>
            {Date.now() - c.createdAt < 60_000 ? "just now" : ago(c.createdAt)}
          </time>
          {mayDelete && !asking && (
            <button type="button" className="btn ghost sm tc-del" aria-label={`Delete the comment from ${name}`} title="Delete" onClick={() => setAsking(true)}>
              <Icon n="trash" size="sm" />
            </button>
          )}
        </div>
        {c.deleted ? (
          <div className="small muted tc-deleted">Comment deleted</div>
        ) : (
          <div className="tc-body">{a ? <Markdown text={c.body} /> : withMentions(c.body)}</div>
        )}
        {!c.deleted && c.choices && <QuestionChoices c={c} onAnswered={onAnswered} reload={reload} />}
        {asking && (
          <div className="tc-ask" role="group" aria-label="Delete this comment?">
            <span className="small">Delete this comment?</span>
            <button type="button" className="btn sm danger" disabled={busy} onClick={remove}>
              Delete
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => setAsking(false)}>
              Keep
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function CommentBox({ t, onPosted }: { t: Task; onPosted: (c: TaskComment) => void }) {
  const { fail } = useStore();
  const fid = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const len = text.trim().length;
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!len || len > MAX_COMMENT || busy) return;
    setBusy(true);
    api
      .post<{ comment: TaskComment }>(`/api/tasks/${t.id}/comments`, { body: text })
      .then((r) => {
        setText("");
        onPosted(r.comment);
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return (
    <form className="tc-box" onSubmit={send}>
      <textarea
        id={fid}
        aria-label="Add a comment"
        className="input"
        rows={2}
        value={text}
        maxLength={MAX_COMMENT + 200}
        placeholder="Add a comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e);
        }}
      />
      <div className="tc-box-f">
        <span className={"small " + (len > MAX_COMMENT ? "tc-over" : "muted")} aria-live="polite">
          {len > MAX_COMMENT - 400 ? `${len} of ${MAX_COMMENT}` : "A comment doesn't notify the agent. To ask it something, use the chat."}
        </span>
        <button className="btn sm primary" disabled={!len || len > MAX_COMMENT || busy}>
          Comment
        </button>
      </div>
    </form>
  );
}
