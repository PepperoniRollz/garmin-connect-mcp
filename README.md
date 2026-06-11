# garmin-connect-mcp

An [MCP](https://modelcontextprotocol.io) server that connects Claude to
your [Garmin Connect](https://connect.garmin.com) data — steps, heart rate,
sleep, activities, workouts, hydration, weight, and golf summaries — as 13
read-only tools.

Runs in two modes from one codebase:

| Mode | Transport | Auth | Use case |
|---|---|---|---|
| **stdio** (default) | stdin/stdout subprocess | none (local) | Claude Code / Claude Desktop on your machine |
| **http** | Streamable HTTP | built-in OAuth 2.1 | Remote custom connector for claude.ai web, desktop, and mobile |

## Tools

Date inputs are optional `YYYY-MM-DD` strings defaulting to today (or last
night for sleep tools).

| Tool | Returns | Units / payload notes |
|---|---|---|
| `get-user-profile` | Garmin profile info | |
| `get-user-settings` | Units, display preferences | |
| `get-activities` | Recent activities (pagination, type filter) | |
| `get-activity-details` | One activity by ID | |
| `count-activities` | Activity counts by type | |
| `get-daily-summary` | Total / active / resting (BMR) calories, steps, distance, intensity minutes, HR range, stress, Body Battery | Calories are **kilocalories** (dietary Calories); `totalKilocalories = activeKilocalories + bmrKilocalories`. Totals keep accruing until the day ends and the device syncs |
| `get-steps` | Step count for a date | Can lag `get-daily-summary.totalSteps` until the next device sync |
| `get-heart-rate` | Heart rate series + summary for a date | |
| `get-sleep` | Condensed sleep: duration, deep/light/REM/awake stages, score, overnight HRV, RHR, Body Battery change | All durations in **seconds**. `date` = the morning the sleep ended |
| `get-sleep-data` | Full raw sleep payload (movement, respiration, HR/Body Battery series) | Large payload; prefer `get-sleep` unless you need the series data |
| `get-sleep-duration` | Sleep hours + minutes | |
| `get-daily-weight` | Weight entries for a date | Weights are in **grams** (e.g. `81000` = 81 kg / ~178.6 lb) |
| `get-daily-hydration` | Water intake for a date | **Ounces** |
| `get-workouts` | Saved workout plans | |
| `get-golf-summary` | Golf round summaries | |

## Quickstart: stdio mode (Claude Code)

```sh
git clone https://github.com/PepperoniRollz/garmin-connect-mcp.git
cd garmin-connect-mcp
npm ci && npm run build
```

Store your Garmin credentials in the OS credential store (macOS shown;
Windows Credential Manager and Linux libsecret are also supported — the
server prints per-platform instructions if credentials are missing):

```sh
security add-generic-password -s garmin-connect-mcp -a username -w 'you@example.com'
security add-generic-password -s garmin-connect-mcp -a password -w 'your-garmin-password'
```

Then register it with Claude Code:

```sh
claude mcp add garmin -- node /path/to/garmin-connect-mcp/dist/index.js
```

`GARMIN_USERNAME` / `GARMIN_PASSWORD` environment variables take precedence
over the credential store when both are set.

## Remote connector mode (claude.ai web / desktop / mobile)

In HTTP mode the server hosts its own OAuth 2.1 authorization server
(PKCE S256 only, dynamic client registration, rotating refresh tokens) so
claude.ai can connect securely. You deploy it behind a TLS-terminating
reverse proxy; only you can authorize access, via a single owner password.

```
                      ┌─────────────────────────────────────────┐
                      │ Your server                             │
 Claude (Anthropic    │  ┌────────┐      ┌────────────────────┐ │
 cloud) ── HTTPS ────▶│  │ Caddy  │─────▶│ garmin-connect-mcp │ │
                      │  │ :443   │      │ http mode :8081    │ │
                      │  └────────┘      │ (localhost only)   │ │
                      │   auto-TLS       └─────────┬──────────┘ │
                      └────────────────────────────┼────────────┘
                                                   ▼
                                            Garmin Connect API
```

### Deploy (Docker Compose + Caddy)

1. **DNS**: point a subdomain (e.g. `garmin-mcp.example.com`) at your
   server. If you use Cloudflare, "DNS only" (gray cloud) is the verified
   configuration; the proxied mode is untested with long-lived SSE streams.
2. **Owner password hash** (the plaintext never appears in any config):
   ```sh
   npm run hash-password
   ```
3. **Configure**: copy the repo to the server, then
   ```sh
   cp .env.deploy.example .env && chmod 600 .env
   ```
   Fill in `GARMIN_USERNAME`, `GARMIN_PASSWORD`, `GARMIN_MCP_PUBLIC_URL`
   (e.g. `https://garmin-mcp.example.com/mcp` — path must be `/mcp`), and
   `SERVER_OWNER_PASSWORD_HASH` (**single-quoted** — bcrypt hashes contain
   `$`, which Docker Compose otherwise interpolates).
4. **Run**:
   ```sh
   docker compose up -d --build
   ```
   The container publishes to `127.0.0.1:8081` only.
5. **Caddy site block** (Caddy obtains the Let's Encrypt certificate
   automatically):
   ```
   garmin-mcp.example.com {
       reverse_proxy localhost:8081
       encode gzip
   }
   ```
   `scripts/phase4-root-setup.sh` automates this (plus compose-plugin
   install) with a validate-before-reload safety path; review it first.
6. **Connect**: claude.ai → Settings → Connectors → Add custom connector →
   `https://garmin-mcp.example.com/mcp`. Claude discovers the OAuth
   metadata, registers itself, and sends you to the login page; enter the
   owner password to approve. The same connector works on Claude mobile.

### Verify a deployment

```sh
curl https://garmin-mcp.example.com/healthz        # → {"status":"ok"}
curl -X POST https://garmin-mcp.example.com/mcp    # → 401 + WWW-Authenticate
OAUTH_TEST_PASSWORD=... npx tsx scripts/oauth-flow-test.ts https://garmin-mcp.example.com
```

## Environment variables

| Variable | Mode | Required | Default | Purpose |
|---|---|---|---|---|
| `GARMIN_USERNAME` | both | http: yes | — | Garmin account email (stdio falls back to the OS credential store) |
| `GARMIN_PASSWORD` | both | http: yes | — | Garmin account password |
| `TRANSPORT_MODE` | both | no | `stdio` | `stdio` or `http` (`--transport` flag wins) |
| `PORT` | http | no | `8080` | Listen port |
| `BIND_HOST` | http | no | `127.0.0.1` | Listen interface; `0.0.0.0` inside containers |
| `GARMIN_MCP_PUBLIC_URL` | http | yes | — | Public MCP endpoint URL; OAuth `resource` equals it exactly; path must be `/mcp` |
| `SERVER_OWNER_PASSWORD_HASH` | http | yes | — | bcrypt hash from `npm run hash-password` |
| `AUTH_DB_PATH` | http | no | `~/.garmin-mcp-auth.db` | SQLite file for OAuth clients/codes/tokens |
| `TOKEN_CACHE_DIR` | both | no | `~/.garmin-mcp-tokens` | Garmin OAuth token cache |
| `TRUSTED_PROXY` | http | no | `loopback` | Express trust-proxy (IP/CIDR/list); set to the Docker bridge gateway in compose |
| `LOG_LEVEL` | both | no | `info` | `debug`/`info`/`warn`/`error`; structured JSON on stderr |

The server never reads `.env` files itself — provide real environment
variables (Docker Compose `env_file:`, systemd `EnvironmentFile=`, shell).

## Security notes

- **Unofficial API disclaimer**: this project uses the unofficial
  [`garmin-connect`](https://www.npmjs.com/package/garmin-connect) client.
  Garmin does not sanction it; it can break without notice, and aggressive
  use could affect your Garmin account. Use at your own risk.
- **Single-user model**: one deployment serves exactly one Garmin account.
  OAuth protects access *to the server*; whoever completes the owner login
  sees that account's data. There is no multi-tenancy.
- **Credential handling**: Garmin credentials live in env vars (HTTP mode)
  or the OS credential store (stdio). The owner password exists only as a
  bcrypt hash. OAuth tokens and codes are stored as SHA-256 hashes in
  SQLite and survive restarts; refresh tokens rotate on use.
- **Never expose HTTP mode without auth.** See [SECURITY.md](SECURITY.md).
- **Datacenter-IP caveat**: Garmin throttles (429) fresh logins from cloud
  provider IPs. Seed the deployed token cache with tokens minted on a
  residential connection: run the server locally once, then copy
  `oauth1_token.json` / `oauth2_token.json` from your `TOKEN_CACHE_DIR`
  into the server's token volume. Cached tokens refresh without
  re-triggering the throttle.

## Development

```sh
npm run dev        # run from source (tsx)
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit (src + scripts)
npm run lint       # gts (Google TypeScript style)
npm test           # e2e: OAuth flow + session lifecycle, no Garmin account needed
```

Architecture and roadmap: [docs/SPEC.md](docs/SPEC.md).

## License

[MIT](LICENSE)
