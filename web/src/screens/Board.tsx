// SPDX-License-Identifier: AGPL-3.0-only
// Board: the tasks of every chat a person may see, in columns by status (web/src/board.ts; the data:
// GET /api/board, server/src/board.ts). The filters live in the address, so a filtered board can be
// bookmarked, and back and forward work. A card opens its chat. A card moves by drag and drop, or by
// its status menu (keyboard, phone), through PATCH /api/tasks/:id like the Tasks screen: it moves at
// once, and goes back if the server says no.
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api, type Task } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Icon, Modal, UserAv, WorkingMark, ago, dayLabel } from "../ui/ui.tsx";
import { progressLine, showsWorking } from "../taskprogress.ts";
import { COLUMNS, STATUS_LABELS, cardAgent, dropStatus, filterCount, readQuery, writeQuery, type BoardQuery, type ColumnKey, type Status } from "../board.ts";
import { ChatAvatar, TaskBox, chatTitle } from "./Chats.tsx";
import { TaskSettings } from "../ui/tasksettings.tsx";
import "../board.css";

interface BoardData {
  tasks: Task[];
  plans: Record<string, string>;
  options: { agents: string[]; chats: string[]; people: string[]; plans: string[] };
  doneSince: number;
  doneHidden: number;
}

export function BoardScreen({ search }: { search: string }) {
  const { go, fail } = useStore();
  const q = readQuery(search);
  const qs = writeQuery(q);
  const [data, setData] = useState<BoardData | null>(null);
  // moves on their way to the server: shown at once, dropped again if the server refuses
  const [moving, setMoving] = useState<Record<string, Status>>({});
  const [dragId, setDragId] = useState("");
  const [over, setOver] = useState<ColumnKey | "">("");
  const [sheet, setSheet] = useState(false);

  // only the latest load lands: an older answer (other filters, or from before a move) never overwrites it
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api.get<BoardData>(`/api/board${qs}`).then((d) => {
      if (n === seq.current) setData(d);
    });
  }, [qs]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);
  const later = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);
  useBus((e) => {
    // reconnected (reconnect.ts): catch up on what changed while the connection was down
    if (e.type === "hello") load().catch(() => {});
    if (e.type !== "task") return;
    // the card changes in place at once; a reload a moment later brings new cards, and applies the filters
    setData((d) => d && { ...d, tasks: e.task.archivedAt ? d.tasks.filter((t) => t.id !== e.task.id) : d.tasks.map((t) => (t.id === e.task.id ? e.task : t)) });
    clearTimeout(later.current);
    later.current = window.setTimeout(() => load().catch(() => {}), 300);
  });

  const setQuery = (patch: Partial<BoardQuery>) => go(`/board${writeQuery({ ...q, ...patch })}`);
  const move = (t: Task, status: Status) => {
    if (status === t.status || t.archivedAt) return;
    setMoving((m) => ({ ...m, [t.id]: status }));
    api
      .patch<{ task: Task }>(`/api/tasks/${t.id}`, { status })
      .then((r) => setData((d) => d && { ...d, tasks: d.tasks.map((x) => (x.id === r.task.id ? r.task : x)) }))
      .catch((x) => {
        fail(x);
        load().catch(() => {});
      })
      .finally(() =>
        setMoving((m) => {
          const { [t.id]: _gone, ...rest } = m;
          return rest;
        }),
      );
  };

  const tasks = (data?.tasks ?? []).map((t) => (moving[t.id] ? { ...t, status: moving[t.id] } : t)).sort((a, b) => b.updatedAt - a.updatedAt);
  const n = filterCount(q);
  const drop = (col: ColumnKey) => (e: DragEvent) => {
    e.preventDefault();
    const id = dragId || e.dataTransfer.getData("text/plain");
    const t = tasks.find((x) => x.id === id);
    const to = t && dropStatus(t.status, col);
    if (t && to) move(t, to);
    setDragId("");
    setOver("");
  };

  return (
    <div className="board-screen">
      <div className="board-top">
        <h2>Board</h2>
        <div className="board-filters">
          <FilterMenus q={q} data={data} onChange={setQuery} />
          {n > 0 && (
            <button className="btn sm ghost" onClick={() => setQuery({ agent: "", chat: "", person: "", plan: "" })}>
              <Icon n="x" size="sm" />
              Clear
            </button>
          )}
        </div>
        <button className={"btn sm board-filter-btn" + (n ? " on" : "")} onClick={() => setSheet(true)} aria-haspopup="dialog">
          <Icon n="filter" size="sm" />
          Filters{n ? ` (${n})` : ""}
        </button>
      </div>
      {data && !data.tasks.length && !n && !data.doneHidden ? (
        <div className="big-empty board-empty">
          <Empty icon="board">No tasks yet. Agents add them when they post a plan.</Empty>
        </div>
      ) : (
        <div className="board-cols" role="list" aria-label="Task board">
          {COLUMNS.map((col) => {
            const list = tasks.filter((t) => col.statuses.includes(t.status));
            return (
              <section
                key={col.key}
                role="listitem"
                aria-label={col.label}
                data-col={col.key}
                className={`board-col col-${col.key}` + (over === col.key ? " over" : "")}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== col.key) setOver(col.key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver("");
                }}
                onDrop={drop(col.key)}
              >
                <header className="board-col-h">
                  <i className="board-dot" />
                  <b>{col.label}</b>
                  <span className="board-count num">{list.length}</span>
                  {col.key === "done" && data && (data.doneHidden > 0 || q.allDone) && (
                    <button className="btn sm ghost board-window" onClick={() => setQuery({ allDone: !q.allDone })}>
                      {q.allDone ? "Last 14 days" : `Show all (${data.doneHidden} older)`}
                    </button>
                  )}
                </header>
                <div className="board-cards">
                  {list.map((t) => (
                    <Card
                      key={t.id}
                      t={t}
                      plan={data?.plans[t.planId] ?? ""}
                      dragging={dragId === t.id}
                      onMove={(s) => move(t, s)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", t.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(t.id);
                      }}
                      onDragEnd={() => {
                        setDragId("");
                        setOver("");
                      }}
                    />
                  ))}
                  {!list.length && <div className="board-none small muted">{col.key === "done" && !q.allDone ? "Nothing done in the last 14 days" : "Nothing here"}</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {sheet && (
        <Modal
          title="Filters"
          onClose={() => setSheet(false)}
          footer={
            <>
              <button className="btn ghost" disabled={!n} onClick={() => setQuery({ agent: "", chat: "", person: "", plan: "" })}>
                Clear all
              </button>
              <span className="grow" />
              <button className="btn primary" onClick={() => setSheet(false)}>
                Done
              </button>
            </>
          }
        >
          <div className="board-sheet">
            <FilterMenus q={q} data={data} onChange={setQuery} labelled />
            <label className="board-field">
              <span>Done</span>
              <select className="input sm" value={q.allDone ? "all" : ""} onChange={(e) => setQuery({ allDone: e.target.value === "all" })}>
                <option value="">Last 14 days</option>
                <option value="all">All</option>
              </select>
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

type FilterKey = "agent" | "chat" | "person" | "plan";

/** The four filter menus: inline on a wide screen, stacked in the sheet on a phone. */
function FilterMenus({ q, data, onChange, labelled }: { q: BoardQuery; data: BoardData | null; onChange: (p: Partial<BoardQuery>) => void; labelled?: boolean }) {
  const { agent, chat, who } = useStore();
  const o = data?.options ?? { agents: [], chats: [], people: [], plans: [] };
  const byName = (l: [string, string][]) => l.sort((a, b) => a[1].localeCompare(b[1]));
  const chatName = (id: string) => {
    const c = chat(id);
    return c ? chatTitle(c, agent) : "A chat";
  };
  const menus: [FilterKey, string, string, [string, string][]][] = [
    ["agent", "Agent", "All agents", byName(o.agents.map((id) => [id, agent(id)?.name ?? "An agent"]))],
    ["chat", "Chat", "All chats", byName(o.chats.map((id) => [id, chatName(id)]))],
    ["person", "Person", "Everyone", byName(o.people.map((id) => [id, who(id)]))],
    ["plan", "Plan", "All plans", byName(o.plans.map((id) => [id, data?.plans[id] ?? "A plan"]))],
  ];
  return (
    <>
      {menus.map(([k, label, all, opts]) => {
        const v = q[k];
        // a value from an old link that no longer matches anything still shows, so it can be cleared
        const list: [string, string][] = v && !opts.some(([id]) => id === v) ? [...opts, [v, "Not on the board"]] : opts;
        const menu = (
          <select className={"input sm" + (v ? " on" : "")} aria-label={label} value={v} onChange={(e) => onChange({ [k]: e.target.value } as Partial<BoardQuery>)}>
            <option value="">{all}</option>
            {list.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        );
        return labelled ? (
          <label key={k} className="board-field">
            <span>{label}</span>
            {menu}
          </label>
        ) : (
          <span key={k}>{menu}</span>
        );
      })}
    </>
  );
}

function Card(props: { t: Task; plan: string; dragging: boolean; onMove: (s: Status) => void; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }) {
  const { t, plan } = props;
  const { agent, user, chat, who, go } = useStore();
  const c = chat(t.chatId);
  const aid = cardAgent(t, (id) => !!agent(id));
  const a = aid ? agent(aid) : undefined;
  // an archived task can't move from here: restore it first (Tasks > Archived)
  const readOnly = !!t.archivedAt;
  const open = () => go(`/chats/${t.chatId}`);
  const line = progressLine(t);
  let assignee: ReactNode = <span className="muted">Anyone</span>;
  if (t.assigneeType === "agent" && t.assigneeId) assignee = <Who av={<AgentAv a={agent(t.assigneeId)} size={20} dot={false} />} name={agent(t.assigneeId)?.name ?? "An agent"} />;
  if (t.assigneeType === "user" && t.assigneeId) assignee = <Who av={<UserAv u={user(t.assigneeId)} size={20} />} name={who(t.assigneeId)} />;
  return (
    <article
      className={"board-card" + (props.dragging ? " dragging" : "") + (readOnly ? " ro" : "")}
      data-task={t.id}
      draggable={!readOnly}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
      tabIndex={0}
      aria-label={`${t.title}. Open in its chat`}
    >
      <div className="board-card-t">
        <span className="todo board-box">
          <TaskBox t={t} />
        </span>
        <b className={t.status === "done" || t.status === "cancelled" ? "done-t" : ""}>{t.title}</b>
      </div>
      {(t.status === "checking" || t.status === "cancelled" || (a && showsWorking(t))) && (
        <div className="board-marks">
          {t.status === "checking" && <span className="status working">Checking</span>}
          {t.status === "cancelled" && <span className="status off">Cancelled</span>}
          {t.assigneeType === "agent" && <WorkingMark a={a} chatId={t.chatId} done={!showsWorking(t)} />}
        </div>
      )}
      {line && <div className="board-progress">{line}</div>}
      <TaskSettings t={t} />
      <div className="board-meta">
        {c && (
          <span className="board-chat" title="Chat">
            <ChatAvatar c={c} size={18} />
            <span>{chatTitle(c, agent)}</span>
          </span>
        )}
        {plan && (
          <span className="board-plan" title="Plan">
            <Icon n="list" size="sm" />
            <span>{plan}</span>
          </span>
        )}
      </div>
      <dl className="board-who">
        {a && !(t.assigneeType === "agent" && t.assigneeId === aid) && (
          <>
            <dt>Agent</dt>
            <dd>
              <Who av={<AgentAv a={a} size={20} dot={false} />} name={a.name} />
            </dd>
          </>
        )}
        <dt>Assignee</dt>
        <dd>{assignee}</dd>
      </dl>
      <div className="board-foot">
        <span className="small muted" title={`Updated ${dayLabel(t.updatedAt)}`}>
          Updated {Date.now() - t.updatedAt < 60_000 ? "just now" : ago(t.updatedAt)}
        </span>
        <select
          className="input sm board-status"
          value={t.status}
          disabled={readOnly}
          aria-label={`Status of ${t.title}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => props.onMove(e.target.value as Status)}
        >
          {STATUS_LABELS.map(([s, label]) => (
            <option key={s} value={s}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}

function Who({ av, name }: { av: ReactNode; name: string }) {
  return (
    <span className="board-name">
      {av}
      <span>{name}</span>
    </span>
  );
}
