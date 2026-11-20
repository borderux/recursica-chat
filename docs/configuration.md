# Configuration

CircleChat is configured with environment variables for the server, and with workspace settings that admins change in the web app. This page lists both, then describes the data folder and the vault key.

## Environment variables

The server reads these in `server/src/index.ts`. The operator commands in `server/src/cli.ts` read `CIRCLECHAT_DATA` and `CIRCLECHAT_MASTER_KEY` too.

| Variable | Default | What it does |
|---|---|---|
| `CIRCLECHAT_DATA` | `data/` in the repo root | The data folder: database, agent homes, vault key. The default is relative to the repo, not to the current directory. |
| `CIRCLECHAT_PORT` | `3100` | Port for the web app, the API, webhooks and the agents' tool endpoint. |
| `CIRCLECHAT_HOST` | `127.0.0.1` | Bind address. Keep the default and put a TLS proxy in front for the internet. |
| `CIRCLECHAT_MASTER_KEY` | read from `<data>/master.key`, created on first run | The vault key: 32 random bytes, base64url. If set, the file is not read or written. |
| `CIRCLECHAT_TRUST_PROXY` | off | Set to `1` behind a TLS reverse proxy. The server then trusts `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, so session cookies get the `Secure` flag and login limits count the real client address. Only safe when the server can be reached through the proxy alone. |
| `CIRCLECHAT_TOOL_DEFAULT` | none | Set to `block` and a connected app's tool with no policy is blocked, whatever its kind; unset, the kind decides (read: Allow, write: Ask, dangerous: Block). MCP tools stay off until reviewed either way. Any other value stops the server at start. See [Integrations](integrations.md#policies-allow-ask-block). |
| `CIRCLECHAT_GOOGLE_CLIENT_ID` | none | Turns on **Sign in with Google** for owners and admins: the OAuth client's id. Google sends people back to `<first address in CIRCLECHAT_PUBLIC_URL>/auth/google/callback`, so `CIRCLECHAT_PUBLIC_URL` must be set, and that address must be the client's authorized redirect URI. Sign-in only finds an existing account by email: an owner or admin, or, with `CIRCLECHAT_GOOGLE_DOMAIN`, anyone whose email is in that domain, whatever their role. It never creates an account. It uses the authorization code flow with PKCE, a state and a nonce, and checks the ID token's issuer, audience, expiry, nonce and verified email. It asks Google for `openid email profile`. At each sign-in, the server keeps a copy of the person's Google photo as their avatar: only from `lh3.googleusercontent.com` (https, no redirects), at most 256 KB within 3 seconds, and only a JPEG, PNG or WebP by its first bytes. Browsers load it from this server, never from Google. A failed fetch never stops a sign-in. Add the `.../auth/userinfo.profile` scope under the client's **Data access**. |
| `CIRCLECHAT_GOOGLE_CLIENT_SECRET_FILE` | none | Required with `CIRCLECHAT_GOOGLE_CLIENT_ID`: a file holding the client secret, read at each sign-in. It must be a plain file that others can't read or write. The secret itself never goes in the environment. |
| `CIRCLECHAT_GOOGLE_DOMAIN` | none | Only Google accounts of this Google Workspace domain may sign in (the ID token's `hd`). Everyone whose email is exactly in this domain (not a subdomain) may sign in with Google, whatever their role. |
| `CIRCLECHAT_PASSWORD_SIGNIN` | `all` | `members`: owners and admins must sign in with Google, and members still use passwords. `off`: nobody signs in with a password. Both need `CIRCLECHAT_GOOGLE_CLIENT_ID`, or the server won't start. A refused password sign-in is told only after the password is right, so it reveals nobody's role. To get back in without Google, set it to `all` and restart. |
| `CIRCLECHAT_PUBLIC_URL` | none | Each address people open the app at, comma-separated, such as `https://chat.example.com`. Include the desktop app's server address. A browser request that changes something (`/api/*` with POST, PUT, PATCH or DELETE), and the `/ws` event socket, must come from one of these origins, by its `Origin` header (or `Sec-Fetch-Site: same-origin` when there is no `Origin`). A request with neither header is accepted only without a session cookie, such as a script using an API token. Unset, only a loopback page on the server's own host and port may change anything (local development), so behind a proxy every browser change is refused until this is set. Webhooks, the agents' tool endpoint and the model proxy are not checked: they never use the session cookie. A bad address stops the server at start. |
| `CIRCLECHAT_AGENT_LISTEN` | none | Linux: an extra address that serves only the agents' tool endpoint (`/mcp/*`) and `/healthz`. An IPv4 or IPv6 address, or an interface name such as `docker0`. If the interface has no address yet, the server retries every 5 seconds. See [Deployment](deployment.md#agents-on-linux). |
| `CIRCLECHAT_AGENT_EGRESS` | `open` | What agent containers may reach. `open`: Docker's normal network. `none`: only CircleChat itself (its tools and model proxy). `allowlist`: CircleChat plus `CIRCLECHAT_AGENT_EGRESS_ALLOW`. See [Security](security.md#agent-network-limits). |
| `CIRCLECHAT_AGENT_EGRESS_ALLOW` | none | For `allowlist`: comma-separated host names, such as `github.com,*.npmjs.org`. Ports 80 and 443 only. |
| `CIRCLECHAT_SANDBOXES` | `docker,local` | Which sandboxes agents may use. Set to `docker` and the API refuses the `local` sandbox, and the server won't start an agent that would run as a process on the server: one set to `local`, or one whose engine has no Docker image (the test engines). Such an agent runs as the server's user and can read the data folder and the vault key. An unknown name stops the server at start. |
| `CIRCLECHAT_AGENT_PORT` | same as `CIRCLECHAT_PORT` | Port for the `CIRCLECHAT_AGENT_LISTEN` listener, and the port in the default `CIRCLECHAT_AGENT_URL`. |
| `CIRCLECHAT_AGENT_URL` | `http://host.docker.internal:<agent port>` | The base URL agent containers use to reach the tool gateway. Containers start with `--add-host host.docker.internal:host-gateway`. |
| `CIRCLECHAT_PDF_IMAGE` | `circlechat/pdftext:latest` | The image that reads a PDF's text for people's uploads, built from `images/pdftext`. Best set to the image ID recorded when it was built, so the server runs exactly that image. See [People's uploads](agents.md#peoples-uploads). |
| `CIRCLECHAT_WARM_ON_BOOT` | on | Set to `0` to stop the server from starting the most recently used agents at boot. |
| `CIRCLECHAT_SEED` | none | Path to a seed file applied once on first boot, while there are no users. The file is deleted afterwards. See [Deployment](deployment.md#seed-file). |
| `CIRCLECHAT_LOCAL_MODEL_URL` | none | Registers an OpenAI-compatible provider with the id `local` on first run, while no providers are saved yet. |
| `CIRCLECHAT_LOCAL_MODELS` | none | Comma-separated model names for the `local` provider above. |

Other variables used only by tools and tests:

| Variable | Used by | What it does |
|---|---|---|
| `CIRCLECHAT_URL` | desktop app | The server address to open, instead of the saved one. |
| `CHROME_PATH` | `e2e/ui.e2e.ts`, `tools/screenshots.ts` | Path to Chrome. The default is the macOS install path. |
| `LOCAL_MODEL_URL`, `LOCAL_MODEL`, `SANDBOX` | `test/real/real-engines.ts` | The model server, model name and sandbox (`docker` or `local`) for real engine tests. |

### Making a vault key

To set `CIRCLECHAT_MASTER_KEY` yourself, generate 32 random bytes:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The server refuses to start if the key does not decode to exactly 32 bytes.

## Workspace settings

These are stored in the `settings` table and changed in the web app.

| Setting | Where | Default | What it does |
|---|---|---|---|
| Workspace name | Settings, Server | `My team` | Shown in the app and in each agent's briefing. |
| Monthly limit | Settings, Models and keys | none | A spending cap for the whole workspace, in dollars. When reached, no agent starts a new turn until next month. |
| Per-agent budget | Agent profile, Spending | none | A monthly cap for one agent. |
| Sandbox memory | Settings API (`sandboxMemory`) | `2g` | Memory limit for each agent container, such as `2g` or `512m`. An engine with a higher minimum (OpenClaw needs `4g`) always gets at least that. |
| Memory paused | Memory | off | While paused, nobody can save new memories. |

Two settings have no screen or API yet. You can set them directly in the database:

| Key | Default | What it does |
|---|---|---|
| `sandbox_cpus` | `2` | CPU limit for each agent container, passed to `docker run --cpus`. |
| `approval_ttl_ms` | `86400000` (24 hours) | How long an approval waits for an answer. No answer means no. |

```bash
sqlite3 data/circlechat.db \
  "INSERT INTO settings(key, value) VALUES('sandbox_cpus', '4')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

New containers and new approvals pick up the change. Running agents keep their current limits until they restart.

## Fixed limits

These are set in code and are not configurable.

| Limit | Value | Where |
|---|---|---|
| Idle sleep | 15 minutes with nothing to do | `server/src/app.ts` |
| Turn timeout | 20 minutes per turn | `server/src/app.ts` |
| Agents warmed at boot | 4 most recent | `server/src/agents/runtime.ts` |
| Hand-off hops | 5 per goal | `server/src/services.ts` |
| Container processes | 512 (`--pids-limit`) | `server/src/agents/runtime.ts` |
| Session cookie | 30 days | `server/src/api.ts` |
| Wrong passwords | 20 per address and 10 per account in 15 minutes | `server/src/api.ts` |
| Request body for `/mcp/*` and `/hooks/*` | 2 MB | `server/src/server.ts` |

## The data folder

Everything CircleChat stores is in one folder, `CIRCLECHAT_DATA`.

```text
data/
  master.key                    vault key (mode 600), unless CIRCLECHAT_MASTER_KEY is set
  circlechat.db                 SQLite database in WAL mode
  circlechat.db-wal             write-ahead log (part of the database while the server runs)
  circlechat.db-shm
  agents/
    <agent id>/
      session.log.jsonl         the agent's activity log, shown in Watch
      home/                     mounted at /home/agent in the container
        work/                   the agent's working folder
        .hermes/ .openclaw/ .config/opencode/ .codex/ ...
                                engine config written by CircleChat at each start
  files/
    <file id>                   a file an agent attached (mode 600), listed in the files table
```

Some engines keep state that needs a real Linux filesystem on a Docker named volume instead, for example `cc-<agent id>-hermes` for Hermes. Those volumes are not in the data folder.

Engine config files in an agent's home hold a stand-in token for CircleChat's model proxy, not the provider's key (Gemini CLI is the exception). Treat the data folder as secret anyway: it holds the database and the vault key. See [Security](security.md#model-keys).

## The vault key

Keys for model providers, connected apps, MCP servers, the Slack bridge and hosting are stored in the `secrets` table, encrypted with AES-256-GCM. The key is `CIRCLECHAT_MASTER_KEY`, or `master.key` in the data folder.

- **Back it up separately.** `cli.ts backup` and the workspace export do not include it, by design.
- **Without it the vault can't be read.** A restored database with the wrong key starts, but every stored key fails to decrypt, so agents and connections stop working until you enter the keys again.
- **There is no key rotation command.** Changing the key makes the existing secrets unreadable.

On first run the server prints:

```text
Created a new vault key at /path/to/data/master.key. Back it up: without it, stored keys can't be read.
```
