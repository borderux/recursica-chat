-- Fork: each turn container the bridge stopped because it ran past its
-- deadline plus the stop grace (see src/lib/turn-container-stops.ts). An
-- operator's notifier reads these rows and posts them; CircleChat itself
-- sends them nowhere. Runs on every start (see src/db/migrate.ts), so every
-- statement must be safe to repeat.
CREATE TABLE IF NOT EXISTS "turn_container_stops" (
  "container" varchar(80) PRIMARY KEY,
  "agent_id" varchar(32) NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "overdue_ms" bigint NOT NULL DEFAULT 0,
  "stopped_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "turn_container_stops_stopped_idx" ON "turn_container_stops" ("stopped_at");
