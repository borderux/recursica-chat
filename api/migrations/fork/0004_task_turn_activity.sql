-- Fork: what an agent's running turn on a task is doing, shown on the task
-- card and the board (see src/lib/task-working.ts). One row per running turn
-- of a task's assignee, from the turn's start until its reply; the step comes
-- from the bridge's progress frames. Runs on every start (see
-- src/db/migrate.ts), so every statement must be safe to repeat.
CREATE TABLE IF NOT EXISTS "task_turn_activity" (
  "run_id" varchar(32) PRIMARY KEY REFERENCES "agent_runs" ("id") ON DELETE CASCADE,
  "agent_id" varchar(32) NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "task_id" varchar(32) NOT NULL REFERENCES "tasks" ("id") ON DELETE CASCADE,
  "workspace_id" varchar(32) NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "phase" varchar(40),
  "phase_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "task_turn_activity_workspace_idx" ON "task_turn_activity" ("workspace_id");
CREATE INDEX IF NOT EXISTS "task_turn_activity_agent_idx" ON "task_turn_activity" ("agent_id");
