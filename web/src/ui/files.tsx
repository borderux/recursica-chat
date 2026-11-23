// SPDX-License-Identifier: AGPL-3.0-only
// Files on messages and tasks, an agent's (server/src/files.ts) or a person's upload
// (server/src/uploads.ts): a download link each, never a preview. The server sends every file as an
// attachment, so the browser saves the file and never shows or runs it. An upload shows whether its
// text could be read, and the uploader or an admin may delete it.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useBus, useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";

export interface FileRef {
  id: string;
  name: string;
  size: number;
  taskId?: string;
  /** The person who uploaded it; empty for an agent's file. */
  userId?: string;
  /** The text's state: on a message, a word; from the list, an object with the reason. */
  text?: "pending" | "ok" | "failed" | { state: "pending" | "ok" | "failed"; reason: string };
  reason?: string;
}
/** The accept list for the upload pickers. The server checks each file's bytes, whatever this says. */
export const UPLOAD_ACCEPT = ".pdf,.txt,.md,application/pdf,text/plain,text/markdown";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function FileChips({ files }: { files?: FileRef[] }) {
  const { me, isAdmin, fail, toast } = useStore();
  if (!Array.isArray(files) || !files.length) return null;
  const remove = (f: FileRef) =>
    api
      .del(`/api/files/${encodeURIComponent(f.id)}`)
      .then(() => toast(`Deleted ${f.name}`))
      .catch(fail);
  return (
    <div className="file-chips">
      {files.map((f) => {
        const state = typeof f.text === "object" ? f.text.state : f.text;
        const reason = typeof f.text === "object" ? f.text.reason : (f.reason ?? "");
        const mine = !!f.userId && (f.userId === me.id || isAdmin);
        return (
          <span key={f.id} className="file-chip-wrap">
            <a className="file-chip" href={`/api/files/${encodeURIComponent(f.id)}`} download={f.name} rel="noopener">
              <span className="file-name">{f.name}</span>
              <span className="file-size">{size(f.size)}</span>
            </a>
            {state === "pending" && <span className="small muted">reading the text…</span>}
            {state === "failed" && (
              <span className="small" style={{ color: "var(--blocked)" }} title={reason}>
                Couldn't read the text{reason ? `: ${reason}` : ""}. Attach a text version.
              </span>
            )}
            {mine && (
              <button className="btn icon ghost sm" aria-label={`Delete ${f.name}`} title="Delete this upload" onClick={() => remove(f)}>
                <Icon n="x" size="sm" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** The files on each task the person can see, by task id. Refreshes when an agent attaches more. */
export function useTaskFiles(): Record<string, FileRef[]> {
  const [byTask, setByTask] = useState<Record<string, FileRef[]>>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    api
      .get("/api/files")
      .then((r: { files: FileRef[] }) => {
        const out: Record<string, FileRef[]> = {};
        for (const f of r.files) (out[f.taskId!] ??= []).push(f);
        setByTask(out);
      })
      .catch(() => {});
  }, [n]);
  useBus((e) => {
    if (e.type === "message" && e.message?.meta?.taskId && e.message?.meta?.files) setN((x) => x + 1);
    if (e.type === "task") setN((x) => x + 1); // a task-only attach posts no message, only a task event
    if (e.type === "hello") setN((x) => x + 1); // reconnected: catch up
  });
  return byTask;
}

/** "Attach": a person uploads PDF, .txt or .md files to a task (POST /api/tasks/:id/files). */
export function TaskAttach({ taskId }: { taskId: string }) {
  const { fail } = useStore();
  const pick = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn sm ghost" title="Attach a PDF, .txt or .md file to this task" onClick={() => pick.current?.click()}>
        <Icon n="file" size="sm" />
        Attach
      </button>
      <input
        ref={pick}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        hidden
        aria-label="Attach files"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) api.upload(`/api/tasks/${taskId}/files`, picked).catch(fail);
        }}
      />
    </>
  );
}
