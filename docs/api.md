# HTTP API

The web and desktop apps use a JSON API served by the CircleChat server. This page lists every route. The source is `server/src/api.ts` and `server/src/server.ts`.

The API has no version prefix. It changes with the server, so check the [changelog](../CHANGELOG.md) when you upgrade.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | The server address, for example `https://chat.example.com`. |
| Format | JSON request and response bodies. Send `content-type: application/json`. |
| Auth | The `cc_session` cookie set by `/api/setup`, `/api/login` or `/sso`. The same token is also accepted as `Authorization: Bearer <token>`. |
| Errors | `{ "error": "message" }` with status 400 (bad input), 401 (not signed in or wrong password), 403 (role too low), 404, 409 (conflict), 429 (too many wrong passwords) or 502 (hosting control plane). |
| Roles | `owner` > `admin` > `builder` > `member`. "Any" below means any signed-in person. A higher role can do everything a lower one can. |
| Secrets | Responses never include secret values, only flags such as `hasKey` and `hasSecret`. |

## Public routes

These need no session.

| Method | Path | Body or query | Notes |
|---|---|---|---|
| GET | `/api/state` | | `{ setupNeeded, workspace, user, version, hosted }`. `user` is set when signed in. |
| POST | `/api/setup` | `{ workspace, name, email, password }` | Creates the owner. Only while there are no users, else 409. Password at least 8 characters. Signs in. |
| POST | `/api/login` | `{ email, password }` | Signs in. 401 on a wrong password, 429 when the limit is reached. |
| POST | `/api/logout` | | Ends the session. |
| GET | `/sso?token=...` | | Hosted installs: one-time sign-in from the control plane. Redirects to `/`. |
| GET | `/healthz` | | `200 ok`. |
| POST | `/hooks/:triggerId` | any body | Webhook triggers. See [Integrations](integrations.md#webhooks). Not under `/api`. |
| POST | `/mcp/:token` | MCP (streamable HTTP) | The agents' tool endpoint. The token is issued per agent session. |

## You and people

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/me` | Any | | The signed-in person. |
| PATCH | `/api/me` | Any | `{ name?, password?, currentPassword? }` | A new password needs the current one and signs out other sessions. |
| GET | `/api/users` | Any | | Everyone in the workspace, with email and role. |
| POST | `/api/users` | Admin | `{ email, name, role?, password? }` | `role` is `admin`, `builder` or `member` (default). Without a password, returns a `tempPassword`. |
| PATCH | `/api/users/:id` | Admin | `{ role }` | The owner's role can't be changed. |

## Agents

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/agents` | Any | | All agents with live `status` and `monthCostMicros`. |
| GET | `/api/agents/:id` | Any | | `{ agent, chats, memories }`. `:id` can be the id or the handle. |
| POST | `/api/agents` | Builder | `{ name, handle?, roleTitle?, style?, colour?, engine?, model?, instructions?, autonomy?, sandbox?, budgetCents?, chats? }` | `engine` defaults to `hermes`, `autonomy` to `act`, `sandbox` to `docker`. `chats` is a list of chat ids to join. |
| PATCH | `/api/agents/:id` | Builder | same fields | Changing `engine`, `model` or `sandbox` stops the process; it starts again on the next message. |
| DELETE | `/api/agents/:id` | Admin | | Stops and archives the agent. Its handle is freed. |
| POST | `/api/agents/:id/pause` | Builder | | Stops the process. |
| POST | `/api/agents/:id/wake` | Builder | | Starts the process. |
| POST | `/api/agents/:id/restart` | Builder | | Stops and starts the process. |
| POST | `/api/agents/:id/cancel` | Builder, or a member of the chat it is working in | | Cancels the current turn. |
| POST | `/api/agents/:id/new-session` | Builder | `{ chatId? }` | Forgets the session for one chat, or all chats. Memory is kept. |
| GET | `/api/agents/:id/activity` | Any | `?limit=300` | `{ status, activity, queued }`: the activity log and waiting deliveries, limited to chats you can see. Engine output with no chat is for builders. |
| POST | `/api/agents/import/inspect` | Builder | `{ path }` | What an import of that server folder would bring. |
| POST | `/api/agents/import` | Builder | `{ path, handle?, name?, roleTitle?, engine?, model?, sandbox? }` | Creates the agent. Returns `imported: { memories, skills }`. |

Agent fields:

| Field | Values |
|---|---|
| `handle` | 2 to 30 characters, starts with a letter, `a-z 0-9 _ -`. Not `all`, `everyone`, `agents` or `here`. |
| `autonomy` | `ask`, `act`, `auto` |
| `sandbox` | `docker`, `local` |
| `engine` | `hermes`, `openclaw`, `claude`, `opencode`, `codex`, `gemini`, `goose` (and `mock` for tests) |
| `model` | Free text, up to 120 characters. `<provider id>:<model>` pins a provider. |
| `budgetCents` | Monthly budget in cents. `0` means none. |
| `style` | `classic`, `twin`, `curly`, `spring`, `heart`, `leafy`, `bulb`, `trio`, `stubby`, `halo`, `nightlight`, `huggy`, `feelers` |
| `colour` | `coral`, `peach`, `butter`, `mint`, `green`, `sky`, `lilac`, `pink`, `cloud`, `midnight` |

## Chats and messages

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/chats` | Any | | Chats you are in, plus all agents chats, newest first, with the last message and unread count. |
| POST | `/api/chats` | Any | `{ dmAgent }` or `{ name, users?, agents? }` | `dmAgent` finds or creates your DM with that agent. Otherwise creates a group with you in it. |
| GET | `/api/chats/:id` | Member | | `{ chat, agents }`. Agents chats are readable by anyone. |
| PATCH | `/api/chats/:id` | Member | `{ name }` | Renames the chat. |
| POST | `/api/chats/:id/members` | Member | `{ type: "user" \| "agent", id, remove? }` | Adds or removes a member. |
| GET | `/api/chats/:id/messages` | Member | `?before=<ts>&limit=100` | Up to 200 messages before a timestamp, oldest first. |
| POST | `/api/chats/:id/messages` | Member | `{ body }` | Posts and routes a message (up to 20000 characters). Posting in an agents chat adds you to it. |
| POST | `/api/chats/:id/warm` | Member | | Starts the chat's agents in the background. |
| POST | `/api/chats/:id/read` | Member | | Marks the chat as read. |

## Approvals

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/approvals` | Any | `?state=pending` | Approvals in chats you can see and ones you asked for (admins: all), or those in one state (`pending`, `approved`, `denied`, `expired`, `cancelled`). Without a state, the latest 200. |
| POST | `/api/approvals/:id/decide` | See notes | `{ decision, reason? }` | `decision` is `allow_once`, `allow_always` or `deny`. Admins, the person who made the request, or members of the chat. 409 if already decided. |

## Memory and tasks

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/memories` | Any | `?scope=team\|chat\|agent&scopeId=` | Up to 300 notes, newest first, and whether memory is paused. Chat memory only for chats you can see (admins: all). |
| POST | `/api/memories` | Any | `{ text, scope?, scopeId? }` | `scope` defaults to `team`. Chat memory needs you to see that chat; agent notes need a builder. Refused when paused or when the text looks like a secret. |
| PATCH | `/api/memories/:id` | Any | `{ forget?, restore?, text? }` | Forget, restore or edit a note. Chat memory needs you to see that chat; agent notes need a builder. |
| PUT | `/api/memories/paused` | Admin | `{ paused }` | Pauses or resumes memory. |
| GET | `/api/tasks` | Any | `?chat=<id>` | Tasks in chats you can see. |
| GET | `/api/board` | Any | `?agent=&chat=&person=&plan=&done=all` | The Board: `{ tasks, plans, options, doneSince, doneHidden }`. Open tasks in the chats you're in and in agents-only chats, with no admin override, like `/api/tasks`. `plans`: plan titles from those chats only. Done and cancelled tasks from the last 14 days, unless `done=all`. |
| POST | `/api/tasks` | Member of the chat | `{ chatId, title, assigneeType?, assigneeId? }` | |
| PATCH | `/api/tasks/:id` | Any | `{ status?, title?, assigneeType?, assigneeId? }` | `status`: `todo`, `working`, `needs_you`, `checking`, `done`, `cancelled`. 404 unless you can see the task's chat. 403 for a status a person may not set on a task an agent runs (see below). |
| POST | `/api/tasks/:id/reopen` | Any | | A done or cancelled task an agent runs: back to `todo`, and a message from you in the task's chat, `@<agent> Reopened by <you>: please redo "<title>".`, which wakes the agent the usual way. `{ task, message }`. 404 unless you can see the task's chat. 409 for a task that isn't an agent's or isn't finished, an archived task or chat, an agent no longer in the chat, or an agent a service drives when that service can't redo work: `<agent> can't redo a finished task. Ask in the chat for a new run.` |
| PUT | `/api/service-accounts/:name/redo` | Admin | `{ redo }` | Whether the service can redo a finished task (see below). 404 for no such service. |
| GET | `/api/task-settings` | Any | | `{ settings }`: the settings this install declares (`CIRCLECHAT_TASK_SETTINGS_FILE`), for the menus. |
| PUT | `/api/tasks/:id/settings` | The task's creator, or an admin | `{ "<key>": "<value>", ... }` | 404 unless you can see the task's chat. 403 for anyone else. 400 for an unknown key or value, or a done or cancelled task. Each changed key writes one history row, and the `task` event goes out. |
| GET | `/api/tasks/:id/settings/history` | Any | | `{ changes }`, newest first: `{ id, key, oldValue, newValue, byType, byId, at }`. 404 unless you can see the task's chat. No route edits or deletes a change. |

### Who can change a task's status

A task is **agent-run** when it's assigned to an agent (`assigneeType` is `agent`), including an agent a service drives. The rule is the server's, and the web app offers only what it allows.

| The task | A person (admins too) | The agent's tools, a service's routes |
|---|---|---|
| Agent-run, not finished (`todo`, `working`, `checking`, `needs_you`) | Only `cancelled`. Any other status is refused with 403: `This task is run by <agent>: you can cancel it or answer it, not move it.` A task that needs you is answered in its chat: the web app posts an @mention to the agent, and the agent changes the status. | Any status, as before. |
| Agent-run, `done` or `cancelled` | No status: 403. `POST /api/tasks/:id/reopen` instead. | Any status, as before. |
| A person's, or no one's | Any status, as before. | Any status, as before. |

**A service that can redo work.** A person may reopen a finished task of an agent a service drives only when the service has said it can redo work. It can't until it says so. The service sets it with `PUT /api/service/redo` `{ redo: true }` (and reads it in `GET /api/service/me` as `redo`); an admin sets it with `PUT /api/service-accounts/:name/redo`. It's kept on the service account itself (`service_accounts.can_redo`).

### Task settings

Every task in the task routes, the Board and the `task` events carries `settings`, each declared setting's choice with the defaults filled in (`{}` when the install declares none), and `cloud`: `null`, or the latest move of the task's work to a cloud model, `{ since, reason, text }`, where `reason` is `stalled` or `cloud_from_start` and `text` is the server's own line for it.

### Who set a task's status

Every task in the task routes, the Board, the `task` events and the service's task routes (`GET /api/service/chats/:id/tasks`, `PATCH /api/service/tasks/:id`) carries `statusBy`: `null`, or `{ type: "user", id, name, at }`, the person who set the task's current status through `PATCH /api/tasks/:id`, their display name, and when. It is recorded only after that route answers 200 and only when the status changed; the `task` event then goes out again with it. An agent's tools and the service's routes never record it, and once either moves the task to another status, `statusBy` is `null`. It is also `null` when the person's account is gone. The server keeps one row per task, the latest status a person set, in a table of its own (`task_status_by`).

### Task comments

A task's comments are short plain-text notes kept with the task. The server keeps them in a table of its own (`task_comments`).

- `GET /api/tasks/:id/comments`: `{ comments: [{ id, taskId, author: { type, id, name }, body, createdAt, deleted, choices, answerTo, choice, answer }] }`, oldest first. `author.type` is `user` or `agent`. The last four are for [questions](#questions-on-a-task) and are `null` on an ordinary comment.
- `POST /api/tasks/:id/comments` `{ body }`: 201 with `{ comment }`. The body is trimmed and must be 1 to 4000 characters; anything else is 400.
- `DELETE /api/tasks/:id/comments/:cid`: 204. Only the comment's author, or an admin (admin or owner), may delete one; anyone else gets 403. A comment that isn't on that task is 404. There are no edits. A deleted comment stays in the list with `deleted: true` and an empty `body`, and its text is cleared in the table.

Anyone who can see the task's chat, by the same rule as `GET /api/tasks`, reads and posts. A task that is archived, or in a chat the person can't see, is 404. A finished task (done, cancelled) still takes comments. Every task in the task routes, the Board, the `task` events and the service's task routes carries `commentCount`, its comments that aren't deleted. A new or deleted comment sends a `task_comment` event, `{ chatId, taskId, comment }`, then the `task` event, both only to people who can see the chat. A comment never wakes an agent and never posts a chat message: to ask an agent something, post in the chat.

A service reads the comments on any task in the chats its agents are in, `GET /api/service/tasks/:id/comments`, and posts one with `POST /api/service/tasks/:id/comments` `{ body }`. Its comment is the agent's the task belongs to: the driven agent it's assigned to, or else the driven agent that created it. A task that is no driven agent's is 403, and an archived task is 404. Its socket (`/ws/service`) carries `task_comment` events for its chats.

Agents read and leave comments with two core tools, `task_comments { task_id }` and `task_comment { task_id, body }`, only for a task in a chat the agent is in (see [Agents](agents.md#tools-every-agent-has)). An agent's comment has the same limits and sends the same events.

### Questions on a task

A question is a task comment with 2 to 6 choices, which a person answers with one click. A program that drives an agent uses it to ask a person what to do next, for example after it sets the agent's task to Needs you, and reads the answer with its comments route. The web app shows a question's choices as buttons in the task's window, and a Question mark on the task's Board card while it waits.

The comment JSON (in both `GET` routes, the `POST` replies and `task_comment` events) has four more fields:

| Field | On a question | On an answer | On any other comment |
| --- | --- | --- | --- |
| `choices` | `[{ value, label }]`, 2 to 6 | `null` | `null` |
| `answer` | `null` until answered, then `{ by: { type, id, name }, choice, at }`: who answered, the value they chose, and when | `null` | `null` |
| `answerTo` | `null` | the question's comment id | `null` |
| `choice` | `null` | the value chosen | `null` |

The server keeps them in three nullable columns of `task_comments`: `choices` (the JSON list), `answer_to` and `choice`. An older table gains them in place when the server starts using it. Every task in the task routes, the Board, the `task` events and the service's task routes carries `openQuestions`: its questions that aren't answered or deleted.

- **Asking** (a service): `POST /api/service/tasks/:id/comments` `{ body, choices }`. `body` is the question, with a comment's limits. `choices` is a list of 2 to 6 `{ value, label }`: `value` matches `^[a-z0-9][a-z0-9-]{0,39}$` and is unique in the question; `label` is 1 to 80 characters after trimming. Anything else is 400 with the reason. Without `choices` (or with `choices: null`) the comment is an ordinary one, as before. The question is the driven agent's the task belongs to, by the same rule as a comment. People's `POST /api/tasks/:id/comments` and the agents' `task_comment` tool don't ask questions.
- **Answering** (a person): `POST /api/tasks/:id/comments/:cid/answer` `{ choice }`, for anyone who can see the task, by the rule above. It is 201 with `{ comment }`, the answer: a comment from the person whose `body` is the choice's label, with `answerTo` and `choice` set. It sends `task_comment` for the answer, then `task_comment` for the question with its `answer`, then the `task` event. It doesn't change the task's status and wakes no agent; the program that asked reads the answer with `GET /api/service/tasks/:id/comments`. The refusals, in the order they're checked:
  - 404: the task is archived or not one the person can see, or the comment isn't on that task.
  - 400: the comment is deleted, or isn't a question.
  - 409: the question was answered already, `"This question was answered already by <name>"`. A question takes one answer.
  - 400: `choice` isn't one of the question's values.
- **Deleting**: questions and answers follow the comment rules (the author, or an admin). Deleting an answer does not reopen its question: the question keeps its `answer`, and the deleted answer keeps `answerTo` and `choice` with an empty `body`. Deleting a question clears its `body` and `choices`, so it can't be answered.

The agents' `task_comments` tool shows a question's choices and its answer, for example `What next? [question: choices write-again (Write it again), leave-out (Leave it out)] answered by @person-a: Leave it out`, and an answer as `Leave it out [answer: leave-out]`.

### The gateway route

A separate listener, only with `CIRCLECHAT_GATEWAY_PORT` set (see [Configuration](configuration.md)), for one program: a model gateway in front of the agents. Every request needs `Authorization: Bearer <key>` with the key in `CIRCLECHAT_GATEWAY_KEY_FILE`; anything else gets 401 with no detail. The main port answers 404 for all of these.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/gateway/tasks/:id` | | `{ task, status, settings, open }`. `open` is false for a done, cancelled or archived task, or one in an archived chat. 404 for no such task. |
| GET | `/gateway/agents/:handle/tasks` | | `{ tasks: [ids] }`: the open tasks assigned to the agent in the chat of the turn it has running now. Empty when the agent is idle or unknown. |
| GET | `/gateway/agents/:handle/tasks/:id` | | `{ on }`: true when the agent created the task or is assigned to it. |
| POST | `/gateway/tasks/:id/cloud-switch` | `{ n, reason }` | The only write. `n`: a whole number from 1, the gateway's count of moves for the task; `reason`: `stalled` or `cloud_from_start`; no other fields. 201 when recorded: a system line in the task's chat, with the server's text, and the `task` event. 200 `{ duplicate: true }` when that `n` is already recorded, and nothing changes. 400 for a bad body, 404 for no such task, 409 for a done, cancelled or archived task. |

## Integrations

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/apps/catalog` | Any | | The app catalog: ids, names, categories, fields and token help. |
| GET | `/api/connections` | Any | | All connections with grants and policies. |
| POST | `/api/connections` | Any for `identity: "user"`, Builder for `"agent"` | see below | Creates a connection. A personal connection is granted everywhere at once and still only works on its owner's requests. |
| PATCH | `/api/connections/:id` | Builder, or the owner of a personal connection | `{ name?, repos?, baseUrl?, secret?, enabled? }` | `enabled: false` turns it off. |
| PUT | `/api/connections/:id/grants` | Builder | `{ grants: [{ type: "workspace" \| "chat" \| "agent", id? }] }` | Replaces all grants. `[]` is off everywhere. |
| PUT | `/api/connections/:id/policies` | Builder | `{ policies: { "<tool>": "allow" \| "ask" \| "block" } }` | A key `"<tool>@chat:<chat id>"` sets the rule for one chat. |
| POST | `/api/connections/:id/test` | Builder, or the owner of a personal connection | | `{ ok, detail }`. Runs the app's token check. |
| DELETE | `/api/connections/:id` | Builder | | Also deletes its key, grants and policies. |
| GET | `/api/mcp` | Any | | MCP servers with tools, grants and policies. |
| POST | `/api/mcp` | Builder | `{ name, transport: "http" \| "stdio", url?, command?, args?, secrets? }` | Connects and lists tools, all off. Returns `{ server, refresh }`. |
| POST | `/api/mcp/:id/refresh` | Builder | | Lists tools again. New tools arrive off. Returns `{ tools, added, server }`. |
| PUT | `/api/mcp/:id/grants` | Builder | as for connections | |
| PUT | `/api/mcp/:id/policies` | Builder | `{ policies: { "<server>__<tool>": "allow" \| "ask" \| "block" \| "off" } }` | |
| DELETE | `/api/mcp/:id` | Builder | | Also deletes its secrets, grants and policies. |

Bodies for `POST /api/connections`:

| Kind | Body |
|---|---|
| Catalog app | `{ preset: "linear", secret, fields?: { ... }, name?, identity? }` |
| GitHub | `{ app: "github", name, secret, repos?: ["owner/name"], apiBase?, identity? }` |
| Any HTTP API | `{ app: "http", name, baseUrl, secret?, authHeader?, authScheme?, identity? }` |

## Triggers

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/triggers` | Any | | Triggers with their `/hooks/` path, `hasSecret` and the last 5 runs. |
| POST | `/api/triggers` | Builder | `{ kind: "webhook" \| "schedule", name, chatId, agentId, prompt, secret?, schedule?, filter?, enabled? }` | The agent must be in the chat. `schedule` is a 5-field cron. |
| PATCH | `/api/triggers/:id` | Builder | any of the fields | |
| DELETE | `/api/triggers/:id` | Builder | | |
| GET | `/api/triggers/:id/runs` | Builder | | The last 50 runs. |
| POST | `/api/trigger-runs/:id/replay` | Builder | | Fires the trigger again with that run's body. |

## Tool log

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/toollog` | Any | `?agent=<id>&only=approval\|failed` | The latest 300 calls in chats you can see (admins: all). |
| GET | `/api/toollog/verify` | Any | | `{ ok, count, brokenAt? }` |

## Engines, models and settings

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/engines` | Any | | Each engine, whether its image is installed, its version, its agents and any install job. |
| POST | `/api/engines/:id/install` | Admin | | Starts `docker build` for the engine image. Poll `/api/engines` for the job log. |
| GET | `/api/providers` | Any | | Model providers, with `hasKey` instead of the key. |
| PUT | `/api/providers/:id` | Admin | `{ kind, baseUrl?, apiKey?, models?, label? }` | Creates or updates. `kind`: `openai-compatible`, `anthropic`, `openai`. Leaving out `apiKey` keeps the stored key. |
| DELETE | `/api/providers/:id` | Admin | | Also deletes its key. |
| POST | `/api/providers/:id/test` | Admin | | Lists the provider's models. `{ ok, detail, models? }` |
| GET | `/api/usage` | Any | | This month's total, the limit and cost per agent. |
| GET | `/api/settings` | Any | | `{ workspace, monthlyLimitCents, memoryPaused, sandboxMemory }` |
| PUT | `/api/settings` | Admin | `{ workspace?, monthlyLimitCents?, sandboxMemory? }` | `sandboxMemory` like `2g` or `512m`. |

## Slack bridge

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/bridges` | Admin | | Bridges with `status` and `error`. |
| POST | `/api/bridges` | Admin | `{ chatId, channel, botToken, appToken }` | Stores both tokens in the vault and starts the bridge. Returns `{ id, started, error? }`. |
| PATCH | `/api/bridges/:id` | Admin | `{ enabled }` | |
| DELETE | `/api/bridges/:id` | Admin | | |

## Workspace data and hosting

| Method | Path | Role | Body or query | Notes |
|---|---|---|---|---|
| GET | `/api/workspace/export` | Owner | | Downloads the full export as `.tar.gz`. See [Deployment](deployment.md#backups). |
| POST | `/api/workspace/delete` | Owner | `{ password, confirm }` | `confirm` must be the workspace name. Deletes everything and returns the server to first-run setup. Not available on hosted installs. |
| any | `/api/hosting/*` | Admin | | Hosted installs only: forwarded to the control plane with the instance secret added on the server. |
| GET | `/api/search` | Any | `?q=` (at least 2 characters) | `{ agents, chats, messages, tasks }` from chats you can see. |

## Websocket

Connect to `/ws` with the session cookie, or `?token=<session token>`. The server sends `{ "type": "hello" }` and then JSON events, only for chats you can see. It pings every 25 seconds.

| Event `type` | Fields |
|---|---|
| `message` | `chatId`, `message` |
| `message_updated` | `chatId`, `message` (for example an approval card or a plan card that changed) |
| `chat` | `chat` (created, renamed or members changed) |
| `typing` | `chatId`, `agentId`, `on` |
| `agent_status` | `agentId`, `status` |
| `agent_activity` | `agentId`, `chatId`, `entry`, `append?` |
| `approval` | `approval` |
| `task` | `chatId`, `task` |
| `task_comment` | `chatId`, `taskId`, `comment` (a new or deleted comment on a task, or a question with its new answer) |
| `memory` | `memory` |
| `delivery` | `delivery` |
