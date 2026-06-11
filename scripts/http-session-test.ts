/**
 * Phase 1 acceptance: full Streamable HTTP session lifecycle against a
 * locally running HTTP-mode server (no auth yet).
 *
 *   npx tsx scripts/http-session-test.ts [baseUrl]
 */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';
const SESSION_HEADER = 'mcp-session-id';

const baseUrl = process.argv[2] ?? DEFAULT_BASE_URL;
const mcpUrl = new URL(MCP_PATH, baseUrl);

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// 1. Initialize: server must issue a session ID.
const transport = new StreamableHTTPClientTransport(mcpUrl);
const client = new Client({name: 'phase1-acceptance', version: '0.0.0'});
await client.connect(transport);
const sessionId = transport.sessionId;
check('initialize issues Mcp-Session-Id', sessionId !== undefined, sessionId);

// 2. Request on the established session.
const {tools} = await client.listTools();
check('tools/list on session returns tools', tools.length === 13, `${tools.length} tools`);

// 3. Second session is independent (per-session transport map).
const transport2 = new StreamableHTTPClientTransport(mcpUrl);
const client2 = new Client({name: 'phase1-acceptance-2', version: '0.0.0'});
await client2.connect(transport2);
check(
    'second session gets distinct ID',
    transport2.sessionId !== undefined && transport2.sessionId !== sessionId,
    transport2.sessionId);
await client2.close();

// 4. DELETE tears the session down.
await transport.terminateSession();
check('DELETE terminates session', true);
await client.close();

// 5. Stale session ID is rejected with 404.
const stale = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    [SESSION_HEADER]: sessionId ?? '',
  },
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
});
check('request on terminated session returns 404', stale.status === 404, `status ${stale.status}`);

// 6. Non-initialize request without a session is rejected with 400.
const noSession = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
  },
  body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
});
check('sessionless non-initialize returns 400', noSession.status === 400, `status ${noSession.status}`);

console.log(failures === 0 ? '\nAll lifecycle checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
