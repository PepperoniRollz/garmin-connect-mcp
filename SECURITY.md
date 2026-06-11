# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/PepperoniRollz/garmin-connect-mcp/security/advisories/new)
(Security → Report a vulnerability). Do not open public issues for security
reports. You can expect an acknowledgement within a week; coordinated
disclosure preferred.

## Deployment warnings

- **NEVER run HTTP mode without authentication on a public interface.**
  HTTP mode always requires OAuth (the server refuses to start without
  `SERVER_OWNER_PASSWORD_HASH`), but defense in depth matters: keep
  `BIND_HOST` on loopback (or publish the container port to `127.0.0.1`
  only) and expose the server exclusively through a TLS-terminating
  reverse proxy. Anyone who can reach an unprotected transport could read
  your Garmin health data.
- The MCP endpoint serves **one** Garmin account to whoever holds a valid
  token. Treat the owner password like the account password itself.
- `.env` on the server should be mode `0600`. The bcrypt hash must be
  single-quoted in compose env files ($-interpolation otherwise corrupts
  it — the server's startup validation will catch this and refuse to run).
- `TRUSTED_PROXY` must name only your actual reverse proxy; trusting too
  broadly lets clients spoof `X-Forwarded-For` in audit logs and evade
  per-IP rate limits.

## Threat-model notes

- Access tokens last 1 hour; refresh tokens 30 days and rotate on use;
  authorization codes and pending logins are single-use with 10-minute
  expiry. All are stored as SHA-256 hashes in SQLite.
- PKCE S256 is mandatory; `plain` is rejected. Dynamic client registration
  is restricted by a redirect-URI allowlist (claude.ai/claude.com callbacks
  and RFC 8252 loopback).
- Login and MCP endpoints are rate limited per IP; auth events and tool
  invocations (tool name only, never payloads) are audit-logged to stderr.

## Dependency audit status (June 2026)

`npm audit` triage for this repository:

- **Runtime tree: 0 known vulnerabilities.** Advisories in `axios`, `qs`,
  `lodash`, `fast-uri`, `path-to-regexp`, `follow-redirects`, `hono`, and
  `@hono/node-server` (all transitive via `garmin-connect`, `express`, or
  the MCP SDK) were resolved by non-breaking upgrades (`npm audit fix`);
  the bumped `axios` was verified against the live Garmin API and the full
  e2e suite.
- **Remaining: `tmp` ≤0.2.5 (high) via `gts → inquirer → external-editor`.**
  Dev-only: `gts` is a devDependency used for linting; it is not part of
  `dist/`, and the Docker image prunes dev dependencies, so this code never
  ships or runs in production. No upstream fix is available
  (`external-editor` pins the vulnerable range). The advisories require an
  attacker to control arguments to `tmp` during local lint tooling, which
  is not an exposed surface. Accepted; revisit when gts updates its
  `inquirer` dependency.
