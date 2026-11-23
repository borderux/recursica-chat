// SPDX-License-Identifier: AGPL-3.0-only
// A task's settings on its Board card and its row on the Tasks screen (web/src/tasksettings.ts; the
// server: server/src/tasksettings.ts). Each declared setting shows its current choice. The task's
// creator or an admin changes it from a small menu; everyone else sees it read-only, and the server
// checks again. A task whose work moved to a cloud model shows "Cloud since 14:32", with the server's
// text in its tooltip and label. The history of changes opens from the clock button.
import { useEffect, useState, type SyntheticEvent } from "react";
import { api, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, Modal, dayLabel } from "./ui.tsx";
import { canChangeSettings, choiceLabel, cloudSince, describeChange, type SettingChange, type SettingDecl } from "../tasksettings.ts";
import "../tasksettings.css";

// the declared settings: one request per page load, shared by every card
let declared: SettingDecl[] | null = null;
let loading: Promise<SettingDecl[]> | null = null;
function loadDeclared(): Promise<SettingDecl[]> {
  loading ??= api
    .get<{ settings: SettingDecl[] }>("/api/task-settings")
    .then((r) => (declared = r.settings ?? []))
    .catch(() => {
      loading = null; // try again next time
      return [];
    });
  return loading;
}

export function useDeclaredSettings(): SettingDecl[] {
  const [d, setD] = useState<SettingDecl[]>(declared ?? []);
  useEffect(() => {
    let live = true;
    if (!declared) void loadDeclared().then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, []);
  return d;
}

// a click in here must not open the card's chat (the card opens on a key only when it has the focus itself)
const keep = (e: SyntheticEvent) => e.stopPropagation();

export function TaskSettings({ t }: { t: Task }) {
  const decl = useDeclaredSettings();
  const { me, fail } = useStore();
  // a choice on its way to the server: shown at once, until the task says so too, or the server refuses
  const [pending, setPending] = useState<Record<string, string>>({});
  const [history, setHistory] = useState(false);
  useEffect(() => {
    setPending((p) => {
      const left = Object.fromEntries(Object.entries(p).filter(([k, v]) => t.settings?.[k] !== v));
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });
  }, [t.settings]);
  if (!decl.length && !t.cloud) return null;
  const may = canChangeSettings(t, me);
  const cur = (s: SettingDecl) => pending[s.key] ?? t.settings?.[s.key] ?? s.default;
  const drop = (key: string) =>
    setPending((p) => {
      const { [key]: _gone, ...rest } = p;
      return rest;
    });
  const change = (key: string, value: string) => {
    setPending((p) => ({ ...p, [key]: value }));
    api.put(`/api/tasks/${t.id}/settings`, { [key]: value }).catch((x) => {
      drop(key);
      fail(x);
    });
  };
  const why = t.status === "done" || t.status === "cancelled" ? "Settings stay as they were once a task is done or cancelled" : "Only the task's creator or an admin can change this";
  return (
    <span className="ts-row" onClick={keep} onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      draggable={false}>
      {t.cloud && <CloudMark cloud={t.cloud} />}
      {decl.map((s) =>
        may ? (
          <label key={s.key} className="ts-chip ts-edit" title={`${s.label}: change it for this task`}>
            <span className="ts-k">{s.label}</span>
            <b>{choiceLabel(s, cur(s))}</b>
            <Icon n="down" size="sm" />
            {/* the menu itself: see-through, over the chip, so the chip is only as wide as its choice */}
            <select value={cur(s)} aria-label={`${s.label} of ${t.title}`} onChange={(e) => change(s.key, e.target.value)}>
              {s.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span key={s.key} className="ts-chip" title={why} aria-label={`${s.label}: ${choiceLabel(s, cur(s))}. ${why}`} role="note">
            <span className="ts-k">{s.label}</span>
            <b>{choiceLabel(s, cur(s))}</b>
          </span>
        ),
      )}
      {decl.length > 0 && (
        <button className="btn icon ghost sm ts-hist" title="Settings history" aria-label={`Settings history of ${t.title}`} onClick={() => setHistory(true)}>
          <Icon n="clock" size="sm" />
        </button>
      )}
      {history && <History t={t} decl={decl} onClose={() => setHistory(false)} />}
    </span>
  );
}

/** "Cloud since 14:32": the server's text in the tooltip, and in the label for screen readers. */
export function CloudMark({ cloud }: { cloud: NonNullable<Task["cloud"]> }) {
  const mark = cloudSince(cloud.since);
  return (
    <span className="ts-cloud" title={cloud.text} aria-label={`${mark}. ${cloud.text}`} role="note" tabIndex={0}>
      <Icon n="zap" size="sm" />
      {mark}
    </span>
  );
}

function History({ t, decl, onClose }: { t: Task; decl: SettingDecl[]; onClose: () => void }) {
  const { who, fail } = useStore();
  const [list, setList] = useState<SettingChange[] | null>(null);
  useEffect(() => {
    api
      .get<{ changes: SettingChange[] }>(`/api/tasks/${t.id}/settings/history`)
      .then((r) => setList(r.changes))
      .catch((x) => {
        setList([]);
        fail(x);
      });
  }, [t.id, fail]);
  return (
    <Modal title="Settings history" sub={t.title} onClose={onClose}>
      <div className="ts-history">
        {t.cloud && <p className="ts-history-cloud small">{t.cloud.text}</p>}
        {list === null ? (
          <div className="small muted">Loading...</div>
        ) : !list.length ? (
          <div className="small muted">No changes yet.</div>
        ) : (
          <ol>
            {list.map((c) => (
              <li key={c.id}>
                <b>{describeChange(decl, c)}</b>
                <span className="small muted">
                  {c.byType === "user" && c.byId ? who(c.byId) : "Someone"}, {c.at ? dayLabel(c.at) : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}
