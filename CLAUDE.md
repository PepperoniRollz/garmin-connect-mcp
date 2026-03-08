# Garmin Connect MCP Server

## Project Overview
An MCP (Model Context Protocol) server that connects Claude Code to Garmin Connect, exposing fitness and health data as tools.

## Tech Stack
- **Runtime**: Node.js (ES modules)
- **Language**: TypeScript (strict mode)
- **MCP SDK**: `@modelcontextprotocol/sdk` — server framework
- **Garmin Client**: `garmin-connect` — unofficial Garmin Connect API wrapper
- **Validation**: `zod` — input schema validation for MCP tools

## Project Structure
```
src/index.ts    — Single-file MCP server with all tools and auth logic
dist/           — Compiled JS output
```

## Commands
- `npm run build` — Compile TypeScript to `dist/`
- `npm run dev` — Run directly with tsx (for development)
- `npm start` — Run compiled output
- `npx @modelcontextprotocol/inspector` — Debug/test tools interactively

## Architecture
- **Auth**: Credentials are read from the OS credential store (macOS Keychain, Windows Credential Manager, or Linux libsecret). Falls back to `GARMIN_USERNAME`/`GARMIN_PASSWORD` env vars. OAuth tokens are cached to `~/.garmin-mcp-tokens` and reused across sessions. Falls back to fresh login if token is expired.
- **Client singleton**: `getClient()` lazily initializes and caches the Garmin client.
- **Tools**: Each `server.tool()` call registers an MCP tool. Tools accept optional date strings (`YYYY-MM-DD`) and return JSON-formatted results.
- **Transport**: Uses stdio (stdin/stdout) — standard for Claude Code MCP servers.

## Conventions
- Keep all server code in `src/index.ts` unless it grows significantly
- Tool names use kebab-case (e.g. `get-heart-rate`)
- All tools return data via `formatResult()` which JSON-stringifies with indentation
- Dates are optional and default to today/last night when omitted
- Never log to stdout (it's the MCP transport channel) — use stderr for debug logging if needed
