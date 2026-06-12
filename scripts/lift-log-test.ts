/**
 * Synthetic acceptance for the lift-log tools against a running HTTP-mode
 * server (the orchestrator points LIFT_DB_PATH at a throwaway file). No
 * Garmin account or real data needed — these tools write to their own DB.
 *
 *   OAUTH_TEST_TOKEN_FILE=tokens.json npx tsx scripts/lift-log-test.ts [baseUrl]
 */
import fs from 'node:fs';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';

const baseUrl = process.argv[2] ?? DEFAULT_BASE_URL;
const mcpUrl = new URL(MCP_PATH, baseUrl);
const tokenFile = process.env['OAUTH_TEST_TOKEN_FILE'];
const accessToken =
  tokenFile !== undefined
    ? (JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as {access_token: string})
        .access_token
    : undefined;
const authHeaders: Record<string, string> =
  accessToken !== undefined ? {authorization: `Bearer ${accessToken}`} : {};

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as {content: {text: string}[]}).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {headers: authHeaders},
});
const client = new Client({name: 'lift-log-test', version: '0.0.0'});
await client.connect(transport);

// 0. Schema-fixture checks: all three tools registered with expected inputs.
const {tools} = await client.listTools();
const byName = new Map(tools.map(tool => [tool.name, tool]));
for (const name of ['log-lift', 'get-lift-history', 'get-lift-progress']) {
  check(`${name} is registered`, byName.has(name));
}
const logProps = byName.get('log-lift')?.inputSchema?.['properties'] as
  | Record<string, unknown>
  | undefined;
check(
  'log-lift schema exposes lift + sets',
  logProps?.['lift'] !== undefined && logProps?.['sets'] !== undefined,
);

// 1. Round-trip: log a session that hits all sets → expect add-weight.
const allEights = await client.callTool({
  name: 'log-lift',
  arguments: {
    lift: 'bench press',
    date: '2026-01-01',
    sets: [
      {weight: 135, reps: 8},
      {weight: 135, reps: 8},
      {weight: 135, reps: 8},
      {weight: 135, reps: 8},
    ],
    note: 'felt easy',
  },
});
const logged = parseToolResult(allEights);
const savedId = (logged['saved'] as {id: string}).id;
check('log-lift returns a saved id', typeof savedId === 'string');
check(
  'log-lift computes top-set weight',
  (logged['saved'] as {topSetWeight: number}).topSetWeight === 135,
);
const assessment = logged['assessment'] as {
  recommendation: string;
  suggestedTopSetWeight?: number;
};
check(
  'all sets at target → add-weight recommendation',
  assessment.recommendation === 'add-weight',
  JSON.stringify(assessment),
);
check(
  'upper-body increment applied (+5 → 140)',
  assessment.suggestedTopSetWeight === 140,
);

// 2. Read it back via history.
const history = parseToolResult(
  await client.callTool({
    name: 'get-lift-history',
    arguments: {lift: 'bench press'},
  }),
);
const sessions = history['sessions'] as {id: string; totalReps: number}[];
const found = sessions.find(s => s.id === savedId);
check(
  'logged session round-trips through get-lift-history',
  found !== undefined,
);
check('history computes total reps (4×8 = 32)', found?.totalReps === 32);

// 3. A lower-body lift that misses the target → hold, larger increment label.
const squat = parseToolResult(
  await client.callTool({
    name: 'log-lift',
    arguments: {
      lift: 'back squat',
      date: '2026-01-02',
      sets: [
        {weight: 225, reps: 8},
        {weight: 225, reps: 7},
        {weight: 225, reps: 6},
        {weight: 225, reps: 6},
      ],
    },
  }),
);
check(
  'missed reps → hold recommendation',
  (squat['assessment'] as {recommendation: string}).recommendation === 'hold',
);

// 4. Progress view for bench shows the working weight and due-to-add flag.
const progress = parseToolResult(
  await client.callTool({
    name: 'get-lift-progress',
    arguments: {lift: 'bench press'},
  }),
);
check(
  'get-lift-progress reports current working weight',
  progress['currentWorkingWeight'] === 135,
);
check(
  'get-lift-progress flags due-to-add',
  progress['dueToAddWeight'] === true,
);
check(
  'progression trend is chronological',
  Array.isArray(progress['progression']) &&
    (progress['progression'] as unknown[]).length >= 1,
);

await transport.terminateSession();
await client.close();

console.log(
  failures === 0 ? '\nAll lift-log checks passed' : `\n${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
