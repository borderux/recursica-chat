// SPDX-License-Identifier: AGPL-3.0-only
// Files an agent attached (server/src/files.ts): a download link each, never a preview. The server
// sends every file as an attachment, so the browser saves the file and never shows or runs it.
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useBus } from "../store.tsx";

export interface FileRef {
  id: string;
  name: string;
  size: number;
  taskId?: string;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function FileChips({ files }: { files?: FileRef[] }) {
  if (!Array.isArray(files) || !files.length) return null;
  return (
    <div className="file-chips">
      {files.map((f) => (
        <a key={f.id} className="file-chip" href={`/api/files/${encodeURIComponent(f.id)}`} download={f.name} rel="noopener">
          <span className="file-name">{f.name}</span>
          <span className="file-size">{size(f.size)}</span>
        </a>
      ))}
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
  });
  return byTask;
}
