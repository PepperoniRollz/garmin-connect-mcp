# Spec: garmin-connect-mcp — Remote Connector Upgrade

## Objective

Upgrade the existing `garmin-connect-mcp` server (TypeScript, official MCP SDK, originally stdio-only) so it can run as a **remote MCP server** hosted on an existing DigitalOcean droplet and be added as a **custom connector** in claude.ai — usable from claude.ai web, Claude Desktop, and Claude mobile. Preserve stdio mode for local Claude Code use. The repository remains open source; no secrets in the repo.

## Status

- **Phase 1 — Core/Transport Separation: DONE** (commit `94fc6a7`)
- **Phase 2 — Configuration: DONE** (commit `1057553`)
- **Phase 3 — OAuth 2.1 Authorization: DONE** (built-in auth server via SDK
  `mcpAuthRouter`; see Phase 3 notes below)
- Phases 4–6: not started

## Resolved Decisions

Formerly "Open Decisions" — all resolved with the owner (June 2026):

1. **OAuth approach: Option A** — built-in minimal OAuth 2.1 authorization server using the MCP SDK's auth helpers. Only flag for discussion if the SDK helpers can't cleanly support DCR + PKCE (S256).
2. **License: MIT** (already in repo).
3. **Subdomain:** final hostname provided at Phase 4. Until then use the `GARMIN_MCP_PUBLIC_URL` env var as a placeholder in all examples; never hardcode a hostname.
4. **Credentials:** `GARMIN_USERNAME` / `GARMIN_PASSWORD` are the canonical env var names (this spec's original `GARMIN_EMAIL` references are amended accordingly). Keyring stays supported in stdio mode via the `CredentialProvider` abstraction; env vars are canonical in HTTP mode.
5. **HTTP framework: Express** — matches the SDK's bundled helpers and examples (resolved in Phase 1).

## Hard Requirements (verified against Anthropic connector docs, June 2026)

These are non-negotiable platform constraints; design around them:

1. The server must be reachable over the **public internet via HTTPS**. Claude connects from Anthropic's cloud infrastructure (all clients: web, desktop, mobile), never from the user's device. If the droplet firewall is restrictive, Anthropic's published IP ranges must be allowlisted.
2. Transport must be **Streamable HTTP** (preferred; SSE is legacy-supported). Stdio cannot be used for remote connectors.
3. Authentication constraints:
   - **Static bearer tokens are NOT supported** by claude.ai custom connectors.
   - **Tokens/API keys in the URL query string are PROHIBITED** (per the MCP authorization spec).
   - Machine-to-machine `client_credentials` with no user in the loop is not supported.
   - Therefore: protected access requires **OAuth 2.1 with PKCE**.
4. The server must host **Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource` so Claude can discover the authorization server. The `resource` field must exactly match the MCP server URL.
5. The authorization server must serve discovery metadata (RFC 8414 / OIDC discovery) and should support **Dynamic Client Registration (DCR)** so Claude can self-register as a client.
6. Claude's OAuth callback URL for web/desktop/mobile is the claude.ai callback (`https://claude.ai/api/mcp/auth_callback`); also allow the claude.com equivalent. Claude Code additionally uses RFC 8252 loopback redirects (`http://localhost/callback` and `http://127.0.0.1/callback`, port-agnostic) — support these if OAuth-in-Claude-Code is desired.

## Target Architecture

```
                      ┌─────────────────────────────────────────┐
                      │ DigitalOcean droplet                    │
 Claude (Anthropic    │  ┌────────┐      ┌────────────────────┐ │
 cloud) ── HTTPS ────▶│  │ Caddy  │─────▶│ garmin-connect-mcp │ │
                      │  │ :443   │      │ HTTP mode :8080    │ │
                      │  └────────┘      │ (localhost only)   │ │
                      │   auto-TLS       └─────────┬──────────┘ │
                      └────────────────────────────┼────────────┘
                                                   │ env-var creds
                                                   ▼
                                            Garmin Connect API
```

- One codebase, two entry points: `stdio` (existing behavior) and `http` (new).
- In HTTP mode the app binds to localhost only; Caddy terminates TLS on a dedicated subdomain (value of `GARMIN_MCP_PUBLIC_URL`) with automatic Let's Encrypt certificates and reverse-proxies to the app.
- Single-user deployment model: the server serves exactly one Garmin account, configured via environment variables. OAuth protects *access to the server*; Garmin credentials never pass through the OAuth layer.

## Coding Standards (apply throughout)

- Follow the **Google TypeScript Style Guide**.
- **No magic strings or magic numbers.** All constant values — env var names, header names, route paths, transport names, error codes, well-known URIs, default ports — are defined in enums (or `as const` constant objects where an enum is unsuitable, e.g. non-string-safe contexts), in a dedicated constants module (`src/constants.ts`).
- Strict TypeScript (`strict: true`); no `any` without justification.
- Validate all external input (env config, OAuth requests, tool arguments) with a schema library (zod is already idiomatic in the MCP SDK ecosystem).
- Structured logging with levels; never log credentials, tokens, or Garmin data payloads at info level.

Example of the expected constants pattern:

```ts
export enum EnvVar {
  GarminUsername = 'GARMIN_USERNAME',
  GarminPassword = 'GARMIN_PASSWORD',
  Port = 'PORT',
  PublicUrl = 'GARMIN_MCP_PUBLIC_URL',
  TransportMode = 'TRANSPORT_MODE',
}

export enum TransportMode {
  Stdio = 'stdio',
  Http = 'http',
}

export enum WellKnownPath {
  ProtectedResource = '/.well-known/oauth-protected-resource',
  AuthServerMetadata = '/.well-known/oauth-authorization-server',
}
```

## Phase 1 — Core/Transport Separation ✅ DONE

1. Extract all tool registration and Garmin client logic into a transport-agnostic `createServer()` factory (returns the configured `McpServer`).
2. Create two thin entry points:
   - `src/entry/stdio.ts` — wires `StdioServerTransport` (current behavior, unchanged externally).
   - `src/entry/http.ts` — wires `StreamableHTTPServerTransport` on an Express app.
3. Implement Streamable HTTP session handling per the SDK: `Mcp-Session-Id` header issuance on initialize, per-session transport map, session teardown on DELETE.
4. Select mode via `TRANSPORT_MODE` env var or CLI flag; default remains stdio so existing Claude Code users are unaffected.

**Acceptance (met):** stdio mode passes existing usage unchanged (tool list/schemas byte-identical to pre-refactor; real keychain-backed tool call verified); HTTP mode passes a full session lifecycle test with MCP Inspector locally (no auth yet) plus `scripts/http-session-test.ts`.

## Phase 2 — Configuration

1. Replace keyring dependency in HTTP mode with environment variables (`GARMIN_USERNAME`, `GARMIN_PASSWORD`). Keep keyring as the credential source in stdio mode for backward compatibility; abstract behind a `CredentialProvider` interface with two implementations.
2. Centralize config parsing/validation in one module (zod schema); fail fast on startup with a clear message listing **every** missing/invalid var, not just the first.
3. Garmin OAuth token cache: move from file-default to a configurable path (`TOKEN_CACHE_DIR`) suitable for a server filesystem or Docker volume.
4. Add `.env.example` documenting every variable with comments. Never read `.env` in production mode implicitly without documenting it.

**Acceptance:** server starts in HTTP mode from env vars alone on a clean machine; startup fails loudly and clearly when misconfigured.

## Phase 3 — OAuth 2.1 Authorization (the main work)

Goal: protect the MCP endpoint so only the owner can connect, while satisfying claude.ai's discovery and flow requirements.

1. **Approach (resolved): Option A — built-in auth server.** Implement a minimal OAuth 2.1 authorization server inside the app using the MCP SDK's auth router/helpers (`mcpAuthRouter` or current equivalent). Single hardcoded user concept: a login page checks a `SERVER_OWNER_PASSWORD` (bcrypt hash in env) before issuing the authorization code. Supports PKCE and DCR. Escalate to the owner only if the SDK helpers can't cleanly support DCR + PKCE (S256).
2. Implement:
   - `/.well-known/oauth-protected-resource` (RFC 9728) with `resource` exactly matching `GARMIN_MCP_PUBLIC_URL` and `authorization_servers` populated.
   - Authorization server metadata discovery (RFC 8414).
   - **PKCE required** (S256 only). **DCR endpoint** so Claude can register dynamically.
   - Redirect URI allowlist as an enum/const list: claude.ai callback, claude.com callback, and loopback URIs with port-agnostic matching for Claude Code.
   - Access token validation middleware on the MCP endpoint; correct `WWW-Authenticate` header with `resource_metadata` URL on 401 responses.
   - Short-lived access tokens + refresh tokens; tokens persisted server-side (SQLite or flat file is fine at this scale) and survive restarts.
3. Security hardening:
   - Rate limiting on auth endpoints and the MCP endpoint.
   - Bind app to `127.0.0.1`; only Caddy is public.
   - CORS: no permissive `*` on the MCP endpoint.
   - Audit log line for each successful/failed auth and each tool invocation (tool name only, not payload).

**Acceptance (met):** MCP Inspector completes the full OAuth flow against a local instance; an unauthenticated request to the MCP endpoint returns 401 with correct discovery headers; a wrong-password login cannot obtain a code; tokens survive restart (SQLite via node:sqlite at `AUTH_DB_PATH`).

**Phase 3 implementation notes:**
- Owner credential is `SERVER_OWNER_PASSWORD_HASH` (bcrypt; generate with `npm run hash-password`) — plaintext never appears in config.
- Loopback redirect URIs are matched on scheme+host only (any port, any path), not pinned to `/callback`: RFC 8252 §7.3 mandates variable ports, and real clients differ (Claude Code uses `/callback`, MCP Inspector `/oauth/callback`). Loopback redirects only reach the user's own machine; the registered URI still must match exactly at authorization time.
- Refresh tokens rotate on use (OAuth 2.1); access tokens 1h, refresh 30d, codes/pending logins 10min, all single-use where applicable; tokens stored as SHA-256 hashes.
- MCP sessions idle >30min are reaped every 5min (designed with token lifetimes; bearer token is re-validated on every request).

## Phase 4 — Deployment (DigitalOcean)

1. Add a multi-stage `Dockerfile` (node:lts-slim runtime, non-root user) and `docker-compose.yml` (app + named volume for token cache/auth DB).
2. Caddyfile for the subdomain (hostname supplied by owner at this phase; `garmin-mcp.example.com` below is illustrative):
   ```
   garmin-mcp.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```
   Document DNS A-record setup and that Caddy handles certificates automatically.
3. Document firewall notes: 443/80 open; app port not exposed; reference Anthropic IP allowlisting only if the deployer runs a restrictive ingress policy.
4. Health endpoint (`/healthz`, unauthenticated, no data) for uptime checks.

**Acceptance:** `docker compose up` on the droplet + DNS + Caddyfile yields a working HTTPS endpoint; claude.ai → Settings → Connectors → Add custom connector → OAuth flow completes → tools callable from a claude.ai chat **and from the Claude mobile app**.

## Phase 5 — Open Source Hygiene

1. README rewrite: what it is, both modes (Claude Code stdio quickstart; remote connector full guide), architecture diagram, env var table, security notes (unofficial Garmin API disclaimer, credential handling, single-user model).
2. `LICENSE` (MIT — resolved), `SECURITY.md` (how to report issues; explicit warning never to run HTTP mode without auth on a public interface).
3. CI (GitHub Actions): typecheck, lint (Google TS config / gts), tests, Docker build.
4. Confirm no secrets in git history; add `.env`, token cache, and auth DB paths to `.gitignore`.

## Phase 6 — Verification Checklist (run before reconvening)

- [ ] stdio mode: unchanged behavior in Claude Code
- [ ] HTTP mode local: MCP Inspector full session + OAuth flow
- [ ] Deployed: 401 + discovery metadata when unauthenticated
- [ ] claude.ai web: connector added, OAuth completed, a Garmin tool returns real data
- [ ] Claude mobile: same connector works
- [ ] Restart survival: tokens/sessions behave sanely after `docker compose restart`
- [ ] Repo: clean of secrets, README accurate, CI green

## Out of Scope (for this iteration)

- Multi-user/multi-tenant support
- MyFitnessPal or other data sources
- Caching/analytics layers on top of Garmin data
- Publishing to any MCP directory/registry
