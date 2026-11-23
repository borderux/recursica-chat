// SPDX-License-Identifier: AGPL-3.0-only
// A task opened from the Board (screens/Board.tsx), in upstream's Modal over the board: its title,
// status, people, chat, plan, progress, last update, files and settings, built from the same parts as
// a task's row on the Tasks screen. The task's id lives in the board's address (?task=…), so Back
// closes it and a link opens it. Changing the status here is the board's own move. Its comments, live,
// are ui/taskcomments.tsx.
//
// Who changes the status (web/src/taskrules.ts; the server's rule: server/src/taskrules.ts): a task an
// agent runs is the agent's to move. A person may cancel it, answer it in its chat when it needs them
// (the Answer box posts an @mention there), and reopen it once it's finished.
//
// Which tasks it shows: GET /api/tasks, the same rule as the board. A task the person can't see, or
// one that's gone or archived, shows "not found", and nothing of it.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type Task } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Icon, Modal, UserAv, WorkingMark, ago, dayLabel } from "../ui/ui.tsx";
import { FileChips, TaskAttach, useTaskFiles } from "../ui/files.tsx";
import { TaskSettings } from "../ui/tasksettings.tsx";
import { TaskComments } from "../ui/taskcomments.tsx";
import { progressLine, showsWorking } from "../taskprogress.ts";
import { cardAgent, type Status } from "../board.ts";
import { agentRunNote, isAgentRun, isFinished, statusChoices } from "../taskrules.ts";
import { ChatAvatar, TaskBox, chatTitle } from "./Chats.tsx";

/**
 * The status menu, on a card and in the task's window: every status for a person's task; for one an
 * agent runs, only Cancel while it runs, and Reopen in its place once it's finished.
 */
export function StatusMenu({ t, label, className, onMove, onReopenError }: { t: Task; label: string; className: string; onMove: (s: Status) => void; onReopenError?: (msg: string) => void }) {
  const { agent } = useStore();
  if (isAgentRun(t) && isFinished(t) && !t.archivedAt) return <ReopenButton t={t} className={className} onError={onReopenError} />;
  const choices = statusChoices(t);
  return (
    <select
      className={"input sm " + className}
      value={t.status}
      disabled={!!t.archivedAt || choices.length < 2}
      aria-label={label}
      title={isAgentRun(t) ? agentRunNote(agent(t.assigneeId)?.name ?? "An agent") : undefined}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onMove(e.target.value as Status)}
    >
      {choices.map(([s, l]) => (
        <option key={s} value={s}>
          {s === "cancelled" && isAgentRun(t) && t.status !== "cancelled" ? "Cancel" : l}
        </option>
      ))}
    </select>
  );
}

/** Reopen a finished task an agent ran: back to To do, and a message in its chat asks the agent to redo it. */
function ReopenButton({ t, className, onError }: { t: Task; className: string; onError?: (msg: string) => void }) {
  const { fail } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={"btn sm reopen " + className}
      disabled={busy}
      aria-label={`Reopen ${t.title}`}
      title="Back to To do, and the agent is asked in the chat to redo it"
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        api
          .post(`/api/tasks/${t.id}/reopen`, {})
          .catch((x) => (onError ? onError((x as Error).message) : fail(x)))
          .finally(() => setBusy(false));
      }}
    >
      <Icon n="undo" size="sm" />
      Reopen
    </button>
  );
}

/** A task that needs its person: the answer goes to its chat, to the agent, and the agent moves the task. */
function AnswerBox({ t, handle, name }: { t: Task; handle: string; name: string }) {
  const { fail } = useStore();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    api
      .post(`/api/chats/${t.chatId}/messages`, { body: `@${handle} ${body}` })
      .then(() => {
        setText("");
        setSent(true);
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return (
    <form className="bt-answer" onSubmit={send}>
      <label className="bt-h" htmlFor={`answer-${t.id}`}>
        {name} needs you
      </label>
      <textarea
        id={`answer-${t.id}`}
        className="input"
        rows={3}
        value={text}
        placeholder={`Answer ${name}`}
        onChange={(e) => {
          setText(e.target.value);
          setSent(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e);
        }}
      />
      <div className="bt-answer-f">
        <span className="small muted" role="status">
          {sent ? `Sent to the chat. ${name} moves the task on.` : "It goes to the task's chat."}
        </span>
        <button className="btn primary sm" disabled={!text.trim() || busy}>
          <Icon n="send" size="sm" />
          Answer
        </button>
      </div>
    </form>
  );
}

export function Who({ av, name }: { av: ReactNode; name: string }) {
  return (
    <span className="board-name">
      {av}
      <span>{name}</span>
    </span>
  );
}

/** Who a task is assigned to: an agent, a person, or anyone. */
export function Assignee({ t, size = 20 }: { t: Task; size?: number }) {
  const { agent, user, who } = useStore();
  if (t.assigneeType === "agent" && t.assigneeId) return <Who av={<AgentAv a={agent(t.assigneeId)} size={size} dot={false} />} name={agent(t.assigneeId)?.name ?? "An agent"} />;
  if (t.assigneeType === "user" && t.assigneeId) return <Who av={<UserAv u={user(t.assigneeId)} size={size} />} name={who(t.assigneeId)} />;
  return <span className="muted">Anyone</span>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]):not([hidden]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Whether this overlay is the top one: a window opened from inside this one (a setting's history) sits over it. */
const isTop = (overlay: Element | null | undefined) => {
  const all = document.querySelectorAll(".overlay");
  return !!overlay && all[all.length - 1] === overlay;
};

export interface TaskModalProps {
  id: string;
  /** the task as the board has it, with a move on its way already applied; undefined when it isn't on the board */
  task?: Task;
  /** a move on its way to the server, for a task that isn't on the board */
  moving?: Status;
  plans: Record<string, string>;
  onMove: (t: Task, s: Status) => void;
  onClose: () => void;
}

export function TaskModal(props: TaskModalProps) {
  const { id } = props;
  const { agent, chat, go } = useStore();
  const files = useTaskFiles();
  const labelId = useId();
  const box = useRef<HTMLDivElement>(null);
  // why the server refused a reopen, said plainly in the window
  const [refused, setRefused] = useState("");

  // the task from the same list as the board: also the one that says "not found"
  const [own, setOwn] = useState<Task | null | undefined>(undefined);
  const seq = useRef(0);
  const loadOwn = useCallback(() => {
    const n = ++seq.current;
    return api.get<{ tasks: Task[] }>("/api/tasks").then((r) => {
      if (n === seq.current) setOwn(r.tasks.find((t) => t.id === id) ?? null);
    });
  }, [id]);
  useEffect(() => {
    loadOwn().catch(() => {
      // the board says so when it can't load; here the task stays unknown
    });
  }, [loadOwn]);
  const later = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);
  const ownRef = useRef(own);
  ownRef.current = own;
  useBus((e) => {
    // reconnected (reconnect.ts): the task may have changed, or gone, while the connection was down
    if (e.type === "hello") loadOwn().catch(() => {});
    // a chat archived, or its members changed: the task may no longer be the person's to see
    if (e.type === "chat") {
      clearTimeout(later.current);
      later.current = window.setTimeout(() => loadOwn().catch(() => {}), 300);
    }
    if (e.type !== "task" || e.task.id !== id) return;
    if (e.task.archivedAt) setOwn(null);
    else if (ownRef.current) setOwn(e.task);
    else loadOwn().catch(() => {});
  });
  // the task left the board (hidden, archived, gone): ask again, rather than show the last copy
  const onBoard = !!props.task;
  const wasOnBoard = useRef(onBoard);
  useEffect(() => {
    if (wasOnBoard.current && !onBoard) loadOwn().catch(() => {});
    wasOnBoard.current = onBoard;
  }, [onBoard, loadOwn]);

  const t: Task | null | undefined = own === null ? null : (props.task ?? (own && props.moving ? { ...own, status: props.moving } : own));
  const status = t?.status;
  useEffect(() => setRefused(""), [status]);

  // close: only when this is the top window, so Escape in a setting's history closes that alone
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const close = useCallback(() => {
    const overlay = box.current?.closest(".modal")?.parentElement;
    if (overlay && !isTop(overlay)) return;
    closeRef.current();
  }, []);

  // upstream's Modal, made a labelled dialog that holds the focus, and gives it back to the card
  useEffect(() => {
    const dlg = box.current?.closest<HTMLElement>("[role=dialog]");
    const overlay = dlg?.parentElement;
    if (!dlg || !overlay) return;
    dlg.setAttribute("aria-labelledby", labelId);
    dlg.tabIndex = -1;
    dlg.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !isTop(overlay)) return;
      const list = [...dlg.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const at = document.activeElement;
      if (!list.length) {
        e.preventDefault();
        dlg.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (at === first || at === dlg || !dlg.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !dlg.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (isTop(overlay) && !dlg.contains(e.target as Node)) dlg.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    };
  }, [labelId, id]);

  if (t === undefined)
    return (
      <Modal title={<span id={labelId}>Task</span>} onClose={close} width={640}>
        <div className="bt" ref={box}>
          <div className="small muted">Loading...</div>
        </div>
      </Modal>
    );
  if (t === null)
    return (
      <Modal
        title={<span id={labelId}>Task not found</span>}
        onClose={close}
        width={640}
        footer={
          <>
            <span className="grow" />
            <button className="btn" onClick={close}>
              Back to the board
            </button>
          </>
        }
      >
        <div className="bt bt-missing" ref={box}>
          <Empty icon="alert">This task may have been deleted or archived, or it's in a chat you can't see.</Empty>
        </div>
      </Modal>
    );

  const c = chat(t.chatId);
  const aid = cardAgent(t, (x) => !!agent(x));
  const a = aid ? agent(aid) : undefined;
  const line = progressLine(t);
  const plan = props.plans[t.planId] ?? "";
  const finished = t.status === "done" || t.status === "cancelled";
  const toChat = `/chats/${t.chatId}`;
  const runner = isAgentRun(t) ? agent(t.assigneeId) : undefined;
  return (
    <Modal
      title={
        <span id={labelId} className={finished ? "bt-done" : ""}>
          {t.title}
        </span>
      }
      onClose={close}
      width={640}
      footer={
        <>
          <a
            className="btn"
            href={toChat}
            onClick={(e) => {
              e.preventDefault();
              go(toChat);
            }}
          >
            <Icon n="chat" size="sm" />
            Open in chat
          </a>
          <span className="grow" />
          <button className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="bt" ref={box} data-open-task={t.id}>
        <div className="bt-status">
          <span className="todo board-box">
            <TaskBox t={t} />
          </span>
          <StatusMenu t={t} label="Status" className="bt-select" onMove={(s) => props.onMove(t, s)} onReopenError={setRefused} />
          {t.status === "checking" && <span className="status working">Checking</span>}
          {t.status === "cancelled" && <span className="status off">Cancelled</span>}
          {a && t.assigneeType === "agent" && <WorkingMark a={a} chatId={t.chatId} done={!showsWorking(t)} />}
        </div>
        {refused && (
          <p className="bt-refused small" role="alert">
            {refused}
          </p>
        )}
        {runner && !finished && (
          <p className="small muted bt-note">{t.status === "needs_you" ? `${runner.name} runs this task: answer it below, or cancel it.` : `${runner.name} runs this task: you can cancel it, not move it.`}</p>
        )}
        {runner && finished && !refused && <p className="small muted bt-note">Reopen it to have {runner.name} redo it.</p>}
        {line && <div className="board-progress">{line}</div>}
        {runner && t.status === "needs_you" && <AnswerBox t={t} handle={runner.handle} name={runner.name} />}
        <TaskSettings t={t} />
        <dl className="bt-facts">
          <dt>Assignee</dt>
          <dd>
            <Assignee t={t} size={22} />
          </dd>
          <dt>Agent</dt>
          <dd>{a ? <Who av={<AgentAv a={a} size={22} dot={false} />} name={a.name} /> : <span className="muted">None</span>}</dd>
          <dt>Chat</dt>
          <dd>
            <span className="board-chat">
              {c && <ChatAvatar c={c} size={22} />}
              <span>{c ? chatTitle(c, agent) : "A chat"}</span>
            </span>
          </dd>
          <dt>Plan</dt>
          <dd>
            {plan ? (
              <span className="board-plan">
                <Icon n="list" size="sm" />
                <span>{plan}</span>
              </span>
            ) : (
              <span className="muted">None</span>
            )}
          </dd>
          <dt>Updated</dt>
          <dd>
            {Date.now() - t.updatedAt < 60_000 ? "just now" : ago(t.updatedAt)}
            <span className="muted">, {dayLabel(t.updatedAt)}</span>
          </dd>
        </dl>
        <section className="bt-files" aria-label="Files">
          <div className="bt-h">Files</div>
          {files[t.id]?.length ? <FileChips files={files[t.id]} /> : <div className="small muted">No files yet.</div>}
          <div>
            <TaskAttach taskId={t.id} />
          </div>
        </section>
        <TaskComments t={t} />
      </div>
    </Modal>
  );
}
