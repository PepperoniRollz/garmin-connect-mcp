# garmin-connect-mcp

An MCP server that connects [Claude Code](https://claude.com/claude-code) to your [Garmin Connect](https://connect.garmin.com) account. Ask Claude about your runs, sleep, heart rate, steps, and more.

## Available Tools

| Tool | Description |
|------|-------------|
| `get-user-profile` | Your Garmin profile info |
| `get-user-settings` | Units, display preferences |
| `get-activities` | List recent activities with pagination and type filtering |
| `get-activity-details` | Detailed data for a specific activity |
| `count-activities` | Activity counts grouped by type |
| `get-steps` | Step count for a date |
| `get-heart-rate` | Heart rate data for a date |
| `get-sleep-data` | Detailed sleep breakdown |
| `get-sleep-duration` | Sleep hours and minutes |
| `get-daily-weight` | Weight for a date |
| `get-daily-hydration` | Water intake (oz) for a date |
| `get-workouts` | Saved workout plans |
| `get-golf-summary` | Golf round summaries |

## Setup

### 1. Install dependencies

```bash
git clone https://github.com/youruser/garmin-connect-mcp.git
cd garmin-connect-mcp
npm install
npm run build
```

### 2. Store your Garmin credentials in macOS Keychain

```bash
security add-generic-password -s "garmin-connect-mcp" -a "username" -w "your-garmin-email@example.com"
security add-generic-password -s "garmin-connect-mcp" -a "password" -w "your-garmin-password"
```

Your credentials are stored encrypted in the system keychain — never in plain text config files.

### 3. Add the MCP server to Claude Code

```bash
claude mcp add garmin -t stdio -s user -- node /absolute/path/to/garmin-connect-mcp/dist/index.js
```

### 4. Restart Claude Code

The Garmin tools will now be available. Try asking:

- "How did I sleep last night?"
- "Show me my last 10 runs"
- "What was my heart rate yesterday?"
- "How many steps did I take this week?"

## Development

```bash
# Run directly without compiling
npm run dev

# Test tools interactively with the MCP Inspector
npx @modelcontextprotocol/inspector
```

## Authentication

Credentials are read from the **macOS Keychain** at startup (service: `garmin-connect-mcp`). This avoids storing secrets in plain text config files. Environment variables `GARMIN_USERNAME` and `GARMIN_PASSWORD` are supported as a fallback (e.g. for CI).

After the first login, OAuth tokens are cached to `~/.garmin-mcp-tokens` so subsequent launches don't require re-authentication.

To update your credentials:

```bash
# Delete old entries
security delete-generic-password -s "garmin-connect-mcp" -a "username"
security delete-generic-password -s "garmin-connect-mcp" -a "password"

# Add new ones
security add-generic-password -s "garmin-connect-mcp" -a "username" -w "new-email"
security add-generic-password -s "garmin-connect-mcp" -a "password" -w "new-password"
```

> **Note**: Garmin does not offer an official public API for consumer data. This server uses the [garmin-connect](https://www.npmjs.com/package/garmin-connect) library which reverse-engineers the Garmin Connect web endpoints. Auth may occasionally break when Garmin updates their SSO flow.

## Security

- Credentials are stored in the macOS Keychain, not in plain text files
- Environment variables supported as fallback but not recommended for daily use
- OAuth tokens are cached locally in `~/.garmin-mcp-tokens`
- The server communicates over stdio only (no network server)

## License

MIT
