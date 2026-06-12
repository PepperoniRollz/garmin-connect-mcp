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
for (const name of [
  'log-lift',
  'get-lift-history',
  'get-lift-progress',
  'update-lift',
  'delete-lift',
]) {
  check(`${name} is registered`, byName.has(name));
}
const deleteProps = byName.get('delete-lift')?.inputSchema?.['properties'] as
  | Record<string, unknown>
  | undefined;
check('delete-lift schema requires id', deleteProps?.['id'] !== undefined);
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

// 5. update-lift: change weight + note, verify it took effect.
const updated = parseToolResult(
  await client.callTool({
    name: 'update-lift',
    arguments: {id: savedId, weight: 145, note: 'corrected load'},
  }),
);
check('update-lift reports success', updated['updated'] === true);
const updatedSession = updated['session'] as {
  topSetWeight: number;
  note?: string;
  totalReps: number;
};
check(
  'update-lift applied new weight to all sets',
  updatedSession.topSetWeight === 145,
);
check('update-lift preserved reps (still 32)', updatedSession.totalReps === 32);
check(
  'update-lift saved the corrected note',
  updatedSession.note === 'corrected load',
);

// Confirm the change is visible on read-back.
const afterUpdate = parseToolResult(
  await client.callTool({
    name: 'get-lift-history',
    arguments: {lift: 'bench press'},
  }),
);
const reread = (
  afterUpdate['sessions'] as {id: string; topSetWeight: number}[]
).find(s => s.id === savedId);
check(
  'updated weight round-trips through history',
  reread?.topSetWeight === 145,
);

// 6. update-lift on an unknown id reports failure cleanly.
const missingUpdate = parseToolResult(
  await client.callTool({
    name: 'update-lift',
    arguments: {id: 'does-not-exist', note: 'noop'},
  }),
);
check(
  'update-lift on unknown id → updated:false',
  missingUpdate['updated'] === false,
);

// 7. delete-lift removes the row; verify it's gone.
const deleted = parseToolResult(
  await client.callTool({name: 'delete-lift', arguments: {id: savedId}}),
);
check('delete-lift reports success', deleted['deleted'] === true);
const afterDelete = parseToolResult(
  await client.callTool({
    name: 'get-lift-history',
    arguments: {lift: 'bench press'},
  }),
);
const stillThere = (afterDelete['sessions'] as {id: string}[]).some(
  s => s.id === savedId,
);
check('deleted session is gone from history', !stillThere);

// 8. delete-lift on an already-gone id reports failure cleanly.
const missingDelete = parseToolResult(
  await client.callTool({name: 'delete-lift', arguments: {id: savedId}}),
);
check(
  'delete-lift on unknown id → deleted:false',
  missingDelete['deleted'] === false,
);

// 9. Timezone: a default-dated log lands on the configured local day
//    (the suite server runs with LIFT_TIMEZONE=America/New_York), which can
//    differ from the UTC calendar day late at night.
const nyToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const defaultDated = parseToolResult(
  await client.callTool({
    name: 'log-lift',
    arguments: {lift: 'tz probe', sets: [{weight: 1, reps: 1}]},
  }),
);
const defaultDate = (defaultDated['saved'] as {date: string; id: string}).date;
check(
  'default date uses configured timezone, not UTC',
  defaultDate === nyToday,
  `${defaultDate} (NY today ${nyToday})`,
);
await client.callTool({
  name: 'delete-lift',
  arguments: {id: (defaultDated['saved'] as {id: string}).id},
});

await transport.terminateSession();
await client.close();

console.log(
  failures === 0 ? '\nAll lift-log checks passed' : `\n${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
