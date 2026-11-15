-- Fork: each person's Slack member ID, for Slack DMs about mentions. Runs on
-- every start (see src/db/migrate.ts), so every statement must be safe to
-- repeat. See lib/slack-link-rules.ts and docs/slack-dms.md.
--
-- A person types an ID, which waits in pending_slack_user_id. A notifier that
-- holds the Slack bot token, outside CircleChat, sends a code to that ID and
-- writes only the code's salt and hash here. The person types the code into
-- CircleChat, and the ID moves to slack_user_id. Only slack_user_id ever gets
-- a DM about a mention.
CREATE TABLE IF NOT EXISTS "user_slack" (
  "user_id" varchar(32) PRIMARY KEY REFERENCES "users" ("id") ON DELETE CASCADE,
  "slack_user_id" varchar(20),
  "verified_at" timestamptz,
  "pending_slack_user_id" varchar(20),
  "code_requested_at" timestamptz,
  "code_salt" varchar(32),
  "code_hash" varchar(64),
  "code_sent_at" timestamptz,
  "code_expires_at" timestamptz,
  "code_attempts" integer NOT NULL DEFAULT 0,
  "send_error" varchar(60),
  "prompt_closed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One person per verified Slack ID.
CREATE UNIQUE INDEX IF NOT EXISTS "user_slack_verified_key"
  ON "user_slack" ("slack_user_id") WHERE "slack_user_id" IS NOT NULL;
