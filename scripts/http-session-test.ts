/**
 * Phase 1 acceptance: full Streamable HTTP session lifecycle against a
 * locally running HTTP-mode server. Since Phase 3 the MCP endpoint requires
 * a bearer token; pass one via the OAUTH_TEST_TOKEN_FILE env var (a JSON
 * file with an access_token field, as written by oauth-flow-test.ts).
 *
 *   [OAUTH_TEST_TOKEN_FILE=tokens.json] npx tsx scripts/http-session-test.ts [baseUrl]
 */
import fs from 'node:fs';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';
const SESSION_HEADER = 'mcp-session-id';

const baseUrl = process.argv[2] ?? DEFAULT_BASE_URL;
const mcpUrl = new URL(MCP_PATH, baseUrl);

const tokenFile = process.env['OAUTH_TEST_TOKEN_FILE'];
const accessToken =
  tokenFile !== undefined
    ? (
        JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as {
          access_token: string;
        }
      ).access_token
    : undefined;
const authHeaders: Record<string, string> =
  accessToken !== undefined ? {authorization: `Bearer ${accessToken}`} : {};

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(
    `${status}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

// 1. Initialize: server must issue a session ID.
const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {headers: authHeaders},
});
const client = new Client({name: 'phase1-acceptance', version: '0.0.0'});
await client.connect(transport);
const sessionId = transport.sessionId;
check('initialize issues Mcp-Session-Id', sessionId !== undefined, sessionId);

// 2. Request on the established session.
const {tools} = await client.listTools();
check(
  'tools/list on session returns tools',
  tools.length === 24,
  `${tools.length} tools`,
);

// 2b. Wellness tool schemas (synthetic fixture check, no Garmin account).
const dailySummary = tools.find(tool => tool.name === 'get-daily-summary');
const condensedSleep = tools.find(tool => tool.name === 'get-sleep');
const dateProperty = (tool: typeof dailySummary) =>
  (tool?.inputSchema?.['properties'] as Record<string, unknown> | undefined)?.[
    'date'
  ];
check(
  'get-daily-summary registered with optional date schema',
  dailySummary !== undefined && dateProperty(dailySummary) !== undefined,
);
check(
  'get-sleep registered with optional date schema',
  condensedSleep !== undefined && dateProperty(condensedSleep) !== undefined,
);

// 2c. Garmin workout tool schemas (synthetic fixture check, no Garmin
// account): create-workout exercises items must accept BOTH input forms —
// a known `exercise` key and a raw {category, exerciseName} pair — which
// zod's union compiles to a JSON-schema anyOf.
const createWorkout = tools.find(tool => tool.name === 'create-workout');
const deleteWorkout = tools.find(tool => tool.name === 'delete-workout');
const createProps = createWorkout?.inputSchema?.['properties'] as
  | Record<string, Record<string, unknown>>
  | undefined;
check(
  'create-workout registered with name + exercises + scheduleDate schema',
  createProps?.['name'] !== undefined &&
    createProps?.['exercises'] !== undefined &&
    createProps?.['scheduleDate'] !== undefined,
);
const exerciseItemForms = (
  createProps?.['exercises']?.['items'] as
    | {anyOf?: Array<{properties?: Record<string, unknown>}>}
    | undefined
)?.anyOf;
check(
  'create-workout exercise items accept known-key form',
  exerciseItemForms?.some(form => form.properties?.['exercise']) === true,
  `${exerciseItemForms?.length ?? 0} forms`,
);
check(
  'create-workout exercise items accept raw category/exerciseName form',
  exerciseItemForms?.some(
    form =>
      form.properties?.['category'] !== undefined &&
      form.properties?.['exerciseName'] !== undefined,
  ) === true,
);
const deleteWorkoutSchema = deleteWorkout?.inputSchema as
  | {properties?: Record<string, unknown>; required?: string[]}
  | undefined;
check(
  'delete-workout registered and requires workoutId',
  deleteWorkoutSchema?.properties?.['workoutId'] !== undefined &&
    deleteWorkoutSchema?.required?.includes('workoutId') === true,
);

// 3. Second session is independent (per-session transport map).
const transport2 = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {headers: authHeaders},
});
const client2 = new Client({name: 'phase1-acceptance-2', version: '0.0.0'});
await client2.connect(transport2);
check(
  'second session gets distinct ID',
  transport2.sessionId !== undefined && transport2.sessionId !== sessionId,
  transport2.sessionId,
);
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
    accept: 'application/json, text/event-stream',
    ...authHeaders,
    [SESSION_HEADER]: sessionId ?? '',
  },
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
});
check(
  'request on terminated session returns 404',
  stale.status === 404,
  `status ${stale.status}`,
);

// 6. Non-initialize request without a session is rejected with 400.
const noSession = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...authHeaders,
  },
  body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
});
check(
  'sessionless non-initialize returns 400',
  noSession.status === 400,
  `status ${noSession.status}`,
);

console.log(
  failures === 0
    ? '\nAll lifecycle checks passed'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
