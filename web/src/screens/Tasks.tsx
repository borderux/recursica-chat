// SPDX-License-Identifier: AGPL-3.0-only
// Tasks: a shared checklist per chat. Archived tasks (and a whole plan's) leave the lists; the Archived
// view shows them, by chat, to restore.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Task } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { AgentAv, Empty, Filters, Icon, UserAv, WorkingMark } from "../ui/ui.tsx";
import { progressLine, showsWorking } from "../taskprogress.ts";
import { ChatAvatar, TaskBox, chatTitle } from "./Chats.tsx";
import { FileChips, UPLOAD_ACCEPT, useTaskFiles } from "../ui/files.tsx";
import { TaskSettings } from "../ui/tasksettings.tsx";

const SECTIONS: [string, Task["status"][]][] = [
  ["Needs you", ["needs_you"]],
  ["In progress", ["working", "checking"]],
  ["To do", ["todo"]],
  ["Done", ["done"]],
  ["Cancelled", ["cancelled"]],
];
const finished = (t: Task) => t.status === "done" || t.status === "cancelled";

export function TasksScreen({ chatId }: { chatId?: string }) {
  const { chats, agent, go, fail, user, who } = useStore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [view, setView] = useState<"open" | "archived">("open");
  const [archived, setArchived] = useState<Task[]>([]);
  const taskFiles = useTaskFiles();
  useEffect(() => {
    api
      .get("/api/tasks")
      .then((r) => setTasks(r.tasks))
      .catch(fail);
  }, [fail]);
  const loadArchived = () =>
    api
      .get("/api/archived")
      .then((r) => setArchived(r.tasks))
      .catch(fail);
  useEffect(() => {
    if (view === "archived") loadArchived();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useBus((e) => {
    // reconnected (reconnect.ts): catch up on what changed while the connection was down
    if (e.type === "hello") {
      api.get("/api/tasks").then((r) => setTasks(r.tasks)).catch(() => {});
      if (view === "archived") loadArchived();
    }
    if (e.type !== "task") return;
    // an archived task leaves the open list, and joins the archived one; a restored one, the other way
    const put = (l: Task[], keep: boolean) =>
      keep ? (l.some((t) => t.id === e.task.id) ? l.map((t) => (t.id === e.task.id ? e.task : t)) : [...l, e.task]) : l.filter((t) => t.id !== e.task.id);
    setTasks((l) => put(l, !e.task.archivedAt));
    setArchived((l) => put(l, !!e.task.archivedAt));
  });
  useEffect(() => {
    if (!chatId && chats.length) {
      const withTasks = chats.find((c) => tasks.some((t) => t.chatId === c.id));
      go(`/tasks/${(withTasks ?? chats[0]).id}`, true);
    }
  }, [chatId, chats, tasks, go]);

  const c = chats.find((x) => x.id === chatId);
  const mine = tasks.filter((t) => t.chatId === chatId);
  const done = mine.filter(finished).length;
  const shelf = archived.filter((t) => t.chatId === chatId);
  const archive = (path: string, restore: boolean) => api.post(`${path}/${restore ? "restore" : "archive"}`, {}).catch(fail);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !chatId) return;
    const [type, id] = assignee ? assignee.split(":") : ["", ""];
    try {
      await api.post("/api/tasks", { chatId, title, assigneeType: type, assigneeId: id });
      setTitle("");
    } catch (x) {
      fail(x);
    }
  };
  const setStatus = (t: Task, status: Task["status"]) => api.patch(`/api/tasks/${t.id}`, { status }).catch(fail);

  return (
    <div className="main">
      <div className="list">
        <div className="list-top">
          <h2>Tasks</h2>
        </div>
        <Filters
          value={view}
          onChange={setView}
          options={[
            ["open", "Tasks"],
            ["archived", "Archived"],
          ]}
        />
        <div className="scroll">
          {view === "archived" && !archived.length && (
            <div className="small muted" style={{ padding: "20px 24px" }}>
              No archived tasks.
            </div>
          )}
          {chats.map((ch) => {
            const ts = (view === "archived" ? archived : tasks).filter((t) => t.chatId === ch.id);
            if (view === "archived" && !ts.length) return null;
            const open = ts.filter((t) => !finished(t)).length;
            return (
              <div key={ch.id} className={"row-chat" + (ch.id === chatId ? " on" : "")} onClick={() => go(`/tasks/${ch.id}`)}>
                <ChatAvatar c={ch} />
                <div className="mid">
                  <div className="t">
                    <b>{chatTitle(ch, agent)}</b>
                  </div>
                  <div className="p">{view === "archived" ? `${ts.length} archived` : ts.length ? `${open} open · ${ts.length - open} done` : "No tasks"}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="convo pane">
        {!c ? (
          <div className="big-empty" style={{ height: "100%" }}>
            <Empty icon="board">Pick a chat to see its tasks.</Empty>
          </div>
        ) : (
          <div className="page">
            <div className="row">
              <h2 className="h2" style={{ cursor: "pointer" }} onClick={() => go(`/chats/${c.id}`)}>
                {chatTitle(c, agent)}
              </h2>
            </div>
            {view === "archived" ? (
              <ArchivedTasks list={shelf} onRestore={archive} />
            ) : (
              <>
                <div className="meter" style={{ marginTop: 16 }}>
                  <i style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%`, background: "var(--done)" }} />
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {done} of {mine.length} done
                </div>
                <form onSubmit={add} className="row" style={{ marginTop: 18, gap: 8 }}>
                  <input className="input sm grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" />
                  <select className="input sm" style={{ width: 160 }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Who does it">
                    <option value="">Anyone</option>
                    {c.members.map((m) => (
                      <option key={m.type + m.id} value={`${m.type}:${m.id}`}>
                        {m.type === "agent" ? agent(m.id)?.name : who(m.id)}
                      </option>
                    ))}
                  </select>
                  <button className="btn primary sm" disabled={!title.trim()}>
                    <Icon n="plus" size="sm" />
                    Add
                  </button>
                </form>
                {mine.length === 0 && <Empty icon="check">No tasks here yet. Agents add them when they post a plan.</Empty>}
                {SECTIONS.map(([label, statuses]) => {
                  const list = mine.filter((t) => statuses.includes(t.status));
                  if (!list.length) return null;
                  return (
                    <div key={label}>
                      <div className="sect">{label}</div>
                      <ul className="todo group" style={{ padding: "6px 16px" }}>
                        {list.map((t, i) => (
                          <li key={t.id} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
                            <TaskBox t={t} onToggle={() => setStatus(t, t.status === "done" ? "todo" : "done")} />
                            <span className={finished(t) ? "done-t" : ""}>
                              {t.title}
                              {progressLine(t) && <span className="task-progress">{progressLine(t)}</span>}
                              <TaskSettings t={t} />
                            </span>
                            <span className="who">
                              {t.status === "needs_you" && <span className="status waiting">Needs you</span>}
                              {t.status === "checking" && <span className="status working">Checking</span>}
                              <select
                                className="input sm"
                                style={{ height: 30, width: 120, fontSize: 12.5, paddingRight: 28, backgroundPosition: "right 8px center" }}
                                value={t.status}
                                aria-label="Status"
                                onChange={(e) => setStatus(t, e.target.value as Task["status"])}
                              >
                                <option value="todo">To do</option>
                                <option value="working">In progress</option>
                                <option value="checking">Checking</option>
                                <option value="needs_you">Needs you</option>
                                <option value="done">Done</option>
                                <option value="cancelled">Cancelled</option>
                              </select>
                              {t.assigneeType === "agent" && <WorkingMark a={agent(t.assigneeId)} chatId={t.chatId} done={!showsWorking(t)} />}
                              {t.assigneeType === "agent" && <AgentAv a={agent(t.assigneeId)} size={28} dot={false} />}
                              {t.assigneeType === "user" && <UserAv u={user(t.assigneeId)} size={28} />}
                              <button
                                className="btn icon ghost sm"
                                aria-label="Archive"
                                title="Archive: it leaves the list, and stays under Archived"
                                onClick={() => archive(`/api/tasks/${t.id}`, false)}
                              >
                                <Icon n="box" size="sm" />
                              </button>
                            </span>
                            <FileChips files={taskFiles[t.id]} />
                            <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Attach a PDF, .txt or .md file to this task">
                              <Icon n="file" size="sm" />
                              Attach
                              <input
                                type="file"
                                multiple
                                accept={UPLOAD_ACCEPT}
                                hidden
                                onChange={(e) => {
                                  const picked = Array.from(e.target.files ?? []);
                                  e.target.value = "";
                                  if (picked.length) api.upload(`/api/tasks/${t.id}/files`, picked).catch(fail);
                                }}
                              />
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A chat's archived tasks, by plan: each restores on its own, or a plan's all at once. */
function ArchivedTasks({ list, onRestore }: { list: Task[]; onRestore: (path: string, restore: boolean) => void }) {
  if (!list.length) return <Empty icon="box">Nothing archived in this chat.</Empty>;
  const plans = [...new Set(list.map((t) => t.planId))];
  return (
    <div style={{ marginTop: 16 }}>
      {plans.map((p) => (
        <div key={p || "none"}>
          <div className="sect row" style={{ alignItems: "center" }}>
            <span className="grow">{p ? "A plan's tasks" : "Tasks"}</span>
            {p && (
              <button className="btn sm ghost" onClick={() => onRestore(`/api/plans/${p}`, true)}>
                <Icon n="refresh" size="sm" />
                Restore the plan
              </button>
            )}
          </div>
          <ul className="todo group" style={{ padding: "6px 16px" }}>
            {list
              .filter((t) => t.planId === p)
              .map((t, i) => (
                <li key={t.id} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
                  <TaskBox t={t} />
                  <span className={t.status === "done" || t.status === "cancelled" ? "done-t" : ""}>{t.title}</span>
                  <span className="who">
                    <span className="small muted">archived {new Date(t.archivedAt ?? 0).toLocaleDateString()}</span>
                    <button className="btn sm ghost" onClick={() => onRestore(`/api/tasks/${t.id}`, true)}>
                      <Icon n="refresh" size="sm" />
                      Restore
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
