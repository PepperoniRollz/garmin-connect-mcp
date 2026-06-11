# Garmin Connect MCP Server

## Project Overview
An MCP (Model Context Protocol) server that connects Claude to Garmin Connect, exposing fitness and health data as tools. Runs in two modes: stdio (local Claude Code subprocess) and Streamable HTTP (remote connector, in progress). Roadmap and requirements live in `docs/SPEC.md`.

## Tech Stack
- **Runtime**: Node.js (ES modules)
- **Language**: TypeScript (strict mode, Google TS style)
- **MCP SDK**: `@modelcontextprotocol/sdk` — server framework
- **HTTP**: `express` — HTTP-mode transport host
- **Garmin Client**: `garmin-connect` — unofficial Garmin Connect API wrapper
- **Validation**: `zod` — config and tool input validation

## Project Structure
```
src/index.ts        — Entry dispatcher: loads config, selects transport mode
src/constants.ts    — ALL constant values (env vars, routes, headers, defaults)
src/config.ts       — Centralized env/CLI config parsing (zod, fail-fast)
src/credentials.ts  — CredentialProvider interface + env/keyring/chained impls
src/garminClient.ts — Garmin client singleton (configureGarminClient + getClient)
src/server.ts       — createServer() factory: transport-agnostic tool registration
src/entry/stdio.ts  — stdio transport entry point
src/entry/http.ts   — Streamable HTTP entry point (Express, session map)
scripts/            — Acceptance test scripts (run with tsx)
docs/SPEC.md        — Remote connector upgrade spec (phases, decisions)
dist/               — Compiled JS output
```

## Commands
- `npm run build` — Compile TypeScript to `dist/`
- `npm run dev` — Run directly with tsx (for development)
- `npm start` — Run compiled output (stdio mode by default)
- `npx @modelcontextprotocol/inspector` — Debug/test tools interactively
- `npx tsx scripts/http-session-test.ts` — HTTP session lifecycle acceptance test

## Architecture
- **Transport modes**: `--transport` CLI flag or `TRANSPORT_MODE` env var (`stdio` | `http`); default stdio. HTTP mode binds to `127.0.0.1` only and expects a TLS-terminating reverse proxy in front.
- **Config**: `loadConfig()` in `src/config.ts` validates everything at startup and reports **all** problems at once. Env vars: see `.env.example`. The server never reads `.env` files itself.
- **Credentials**: `CredentialProvider` abstraction. HTTP mode: `GARMIN_USERNAME`/`GARMIN_PASSWORD` env vars only (required, validated at startup). Stdio mode: env vars if set, else OS credential store (macOS Keychain / Windows Credential Manager / Linux libsecret).
- **Garmin token cache**: `TOKEN_CACHE_DIR` (default `~/.garmin-mcp-tokens`); reused across sessions, fresh login on expiry.
- **Client singleton**: entry points call `configureGarminClient()`; tools call `getClient()` which lazily initializes and caches.
- **Tools**: registered in `createServer()` via `server.registerTool()`. Tools accept optional date strings (`YYYY-MM-DD`) and return JSON-formatted results.

## Conventions
- **No magic strings/numbers** — every env var name, route, header, and default lives in `src/constants.ts` as an enum or `as const` object
- Google TypeScript style; no `any` without a justifying comment
- Tool names use kebab-case (e.g. `get-heart-rate`)
- All tools return data via `formatResult()` which JSON-stringifies with indentation
- Dates are optional and default to today/last night when omitted
- Never log to stdout (it's the MCP transport channel) — use the structured `logger` (`src/logger.ts`), which writes JSON to stderr; never log credentials, tokens, or Garmin payloads at info level
