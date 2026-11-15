// Fork: an agent working on a task, where people look (lib/taskWorking.ts).
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { bus } from "../ws/client";
import { markerTitle, workOnTask, workingLine, type TaskWork } from "../lib/taskWorking";

const KEY = ["task-working"] as const;

// Every running task turn in the workspace, kept live by "task.working" and
// the run events.
export function useTaskWorking() {
  const qc = useQueryClient();
  const q = useQuery<{ working: TaskWork[] }>({
    queryKey: KEY,
    queryFn: () => api.get("/tasks/working"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  useEffect(
    () =>
      bus.on((ev) => {
        if (ev.type === "task.working" || ev.type === "agent.run.finished") qc.invalidateQueries({ queryKey: KEY });
      }),
    [qc],
  );
  return q.data?.working;
}

// Re-renders every `ms`, so the minutes count up.
function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

// The task card's live line, under the title.
export function TaskWorkingLine({ taskId }: { taskId: string }) {
  const work = workOnTask(useTaskWorking(), taskId);
  const now = useNow(15_000, work.length > 0);
  if (!work.length) return null;
  return (
    <div className="tm-working" role="status" aria-live="polite">
      {work.map((w) => (
        <div key={w.runId} className="tm-working-line">
          <span className="working-dot" aria-hidden="true" />
          {workingLine(w, now)}
        </div>
      ))}
    </div>
  );
}

// The board card's working marker.
export function BoardWorkingMarker({ work }: { work: TaskWork[] }) {
  const now = useNow(30_000, work.length > 0);
  if (!work.length) return null;
  return (
    <div className="kc-working" title={markerTitle(work, now)}>
      <span className="working-dot" aria-hidden="true" />
      Working
    </div>
  );
}
