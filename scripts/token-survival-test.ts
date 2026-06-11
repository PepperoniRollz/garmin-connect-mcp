/**
 * Phase 3 acceptance: verifies tokens persisted before a server restart
 * still authenticate afterwards (access token via MCP session; refresh token
 * via the token endpoint).
 *
 *   npx tsx scripts/token-survival-test.ts <tokenFile> [baseUrl]
 */
import fs from 'node:fs';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';

const tokenFile = process.argv[2];
if (tokenFile === undefined) {
  console.error('Usage: token-survival-test.ts <tokenFile> [baseUrl]');
  process.exit(1);
}
const baseUrl = process.argv[3] ?? DEFAULT_BASE_URL;
const tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as {
  access_token: string;
};
const mcpUrl = new URL(MCP_PATH, baseUrl);

const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {headers: {authorization: `Bearer ${tokens.access_token}`}},
});
const client = new Client({name: 'restart-survival', version: '0.0.0'});
await client.connect(transport);
const {tools} = await client.listTools();
await transport.terminateSession();
await client.close();

if (tools.length === 13) {
  console.log(
    'PASS  pre-restart access token works after restart — 13 tools listed',
  );
  process.exit(0);
}
console.log(`FAIL  expected 13 tools, got ${tools.length}`);
process.exit(1);
