// SPDX-License-Identifier: AGPL-3.0-only
// A question on a task (the server: server/src/taskcomments.ts): a comment with 2 to 6 choices, which
// a service asks for the agent it drives. In the task's window (ui/taskcomments.tsx) it shows one button
// per choice; a click answers it at once, with no confirmation, as a comment from the person. Once
// answered, the buttons stay, turned off, under "Answered by <name>: <label>". If someone answered first,
// the server's reason shows and the list reloads. The Board card shows a Question mark while one waits.
import { useState } from "react";
import { api, ApiError, type Task, type TaskComment } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./ui.tsx";
import "../taskquestions.css";

/** Whether a Board card carries the Question mark: a question on the task waits for an answer. */
export const hasOpenQuestion = (t: Task) => (t.openQuestions ?? 0) > 0;

/** The mark on a Board card, among its other marks. */
export function QuestionMark({ t }: { t: Task }) {
  if (!hasOpenQuestion(t)) return null;
  const n = t.openQuestions ?? 0;
  const label = n === 1 ? "A question waits for an answer" : `${n} questions wait for an answer`;
  return (
    <span className="status waiting tq-mark" title={label} aria-label={label}>
      Question
    </span>
  );
}

/** A question's buttons, under its text. `onAnswered` takes the new answer; `reload` fetches the list again. */
export function QuestionChoices({ c, onAnswered, reload }: { c: TaskComment; onAnswered: (a: TaskComment) => void; reload: () => void }) {
  const { user, who, fail } = useStore();
  const [busy, setBusy] = useState(false);
  const choices = c.choices ?? [];
  const ans = c.answer ?? null;
  const pick = (value: string) => {
    if (busy || ans) return;
    setBusy(true);
    api
      .post<{ comment: TaskComment }>(`/api/tasks/${c.taskId}/comments/${c.id}/answer`, { choice: value })
      .then((r) => {
        onAnswered(r.comment);
        // the question's own event follows over the socket; show the answer now
        onAnswered({ ...c, answer: { by: r.comment.author, choice: value, at: r.comment.createdAt } });
      })
      .catch((e) => {
        fail(e);
        // answered already, or gone: show what the server has now
        if (e instanceof ApiError) reload();
      })
      .finally(() => setBusy(false));
  };
  const byName = ans ? (ans.by.type === "user" && user(ans.by.id) ? who(ans.by.id) : ans.by.name || "someone") : "";
  const chosen = ans ? (choices.find((x) => x.value === ans.choice)?.label ?? ans.choice) : "";
  return (
    <div className="tq" data-question={c.id}>
      <div className="tq-choices" role="group" aria-label="Choices">
        {choices.map((x) => {
          const mine = ans?.choice === x.value;
          return (
            <button key={x.value} type="button" className={"btn sm tq-btn" + (mine ? " tq-chosen" : "")} data-choice={x.value} disabled={busy || !!ans} aria-pressed={ans ? mine : undefined} onClick={() => pick(x.value)}>
              {mine && <Icon n="check" size="sm" />}
              {x.label}
            </button>
          );
        })}
      </div>
      <div className="small tq-state" aria-live="polite">
        {ans ? (
          <>
            Answered by <b>{byName}</b>: {chosen}
          </>
        ) : (
          <span className="muted">Pick one to answer. The answer can't be changed.</span>
        )}
      </div>
    </div>
  );
}
