/**
 * Scope enforcement acceptance against a locally running HTTP-mode server:
 * write tools (log-lift, update-lift, delete-lift, create-workout,
 * delete-workout, confirm-strength-session) must require the garmin:write
 * scope; a read-only token must still be able to use read tools.
 *
 *   OAUTH_TEST_PASSWORD=... npx tsx scripts/scope-test.ts [baseUrl]
 *
 * Only the lift-log tools are exercised end to end (they write to the
 * orchestrator's throwaway LIFT_DB_PATH); no Garmin account is contacted.
 */
import {createHash, randomBytes} from 'node:crypto';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';
const LOGIN_PATH = '/oauth/login';
const LOOPBACK_CALLBACK = 'http://127.0.0.1:33418/callback';
const READ_SCOPE = 'garmin:read';
const WRITE_SCOPE = 'garmin:write';
const UNKNOWN_SCOPE = 'garmin:admin';

const baseUrl = process.argv[2] ?? DEFAULT_BASE_URL;
const ownerPassword = process.env['OAUTH_TEST_PASSWORD'];
if (!ownerPassword) {
  console.error(
    'Set OAUTH_TEST_PASSWORD to the owner password used for the test server.',
  );
  process.exit(1);
}
const mcpUrl = new URL(MCP_PATH, baseUrl);

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

interface ToolResult {
  isError?: boolean;
  content: {type: string; text?: string}[];
}

function resultText(result: unknown): string {
  return (result as ToolResult).content.map(item => item.text ?? '').join('\n');
}

function parseToolResult(result: unknown): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

// --- Discovery ---
const prm = (await (
  await fetch(new URL('/.well-known/oauth-protected-resource/mcp', baseUrl))
).json()) as {authorization_servers: string[]; scopes_supported?: string[]};
const asMeta = (await (
  await fetch(
    new URL(
      '/.well-known/oauth-authorization-server',
      prm.authorization_servers[0],
    ),
  )
).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
};

check(
  'AS metadata advertises garmin:read and garmin:write',
  asMeta.scopes_supported?.includes(READ_SCOPE) === true &&
    asMeta.scopes_supported?.includes(WRITE_SCOPE) === true,
  JSON.stringify(asMeta.scopes_supported),
);
check(
  'PRM advertises garmin:read and garmin:write',
  prm.scopes_supported?.includes(READ_SCOPE) === true &&
    prm.scopes_supported?.includes(WRITE_SCOPE) === true,
  JSON.stringify(prm.scopes_supported),
);

// --- One registered client for every flow below ---
const reg = await fetch(asMeta.registration_endpoint, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    client_name: 'scope-acceptance',
    redirect_uris: [LOOPBACK_CALLBACK],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
check('DCR registers client', reg.status === 201, `status ${reg.status}`);
const client = (await reg.json()) as {client_id: string};

interface AuthorizeOutcome {
  status: number;
  html: string;
  pendingId: string;
  location: string;
}

/** Drive /authorize for the given scope string (undefined = omit `scope`). */
async function authorize(
  scope: string | undefined,
  challenge: string,
): Promise<AuthorizeOutcome> {
  const url = new URL(asMeta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', LOOPBACK_CALLBACK);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', randomBytes(8).toString('base64url'));
  if (scope !== undefined) url.searchParams.set('scope', scope);
  const res = await fetch(url, {redirect: 'manual'});
  const html = res.status === 200 ? await res.text() : '';
  return {
    status: res.status,
    html,
    pendingId: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '',
    location: res.headers.get('location') ?? '',
  };
}

interface IssuedToken {
  access_token: string;
  refresh_token: string;
  scope?: string;
  consentHtml: string;
}

/** Full PKCE flow: authorize → owner login → code exchange. */
async function obtainToken(scope: string | undefined): Promise<IssuedToken> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64url');
  const page = await authorize(scope, challenge);
  if (page.pendingId === '') {
    throw new Error(`authorize did not render a login page (${page.status})`);
  }
  const login = await fetch(new URL(LOGIN_PATH, baseUrl), {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      pending_id: page.pendingId,
      password: ownerPassword as string,
    }),
    redirect: 'manual',
  });
  const code =
    new URL(login.headers.get('location') ?? 'http://x').searchParams.get(
      'code',
    ) ?? '';
  const tokenResp = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: LOOPBACK_CALLBACK,
      client_id: client.client_id,
    }),
  });
  if (tokenResp.status !== 200) {
    throw new Error(`token exchange failed (${tokenResp.status})`);
  }
  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    scope?: string;
  };
  return {...tokens, consentHtml: page.html};
}

async function connect(accessToken: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {headers: {authorization: `Bearer ${accessToken}`}},
  });
  const mcp = new Client({name: 'scope-acceptance', version: '0.0.0'});
  await mcp.connect(transport);
  return {client: mcp, transport};
}

const LIFT_NAME = `scope probe ${randomBytes(4).toString('hex')}`;
const liftArgs = {
  lift: LIFT_NAME,
  date: '2026-01-03',
  sets: [{weight: 100, reps: 8}],
};

// --- 1. Read-only token ---
const readOnly = await obtainToken(READ_SCOPE);
check(
  'read-only grant echoes scope=garmin:read only',
  readOnly.scope === READ_SCOPE,
  readOnly.scope,
);
check(
  'consent page names the requested scope',
  readOnly.consentHtml.includes(READ_SCOPE) &&
    !readOnly.consentHtml.includes(WRITE_SCOPE),
);

const ro = await connect(readOnly.access_token);

const roHistoryBefore = await ro.client.callTool({
  name: 'get-lift-history',
  arguments: {lift: LIFT_NAME},
});
check(
  'read tool works with garmin:read only',
  (roHistoryBefore as ToolResult).isError !== true &&
    Array.isArray(parseToolResult(roHistoryBefore)['sessions']),
  resultText(roHistoryBefore).slice(0, 120),
);

const roLog = await ro.client.callTool({name: 'log-lift', arguments: liftArgs});
check(
  'log-lift with garmin:read only is rejected as a tool error',
  (roLog as ToolResult).isError === true,
  resultText(roLog).slice(0, 160),
);
check(
  'rejection names the missing garmin:write scope',
  resultText(roLog).includes(WRITE_SCOPE),
);
const roHistoryAfter = parseToolResult(
  await ro.client.callTool({
    name: 'get-lift-history',
    arguments: {lift: LIFT_NAME},
  }),
);
check(
  'rejected log-lift wrote nothing',
  (roHistoryAfter['sessions'] as unknown[]).length === 0,
  `${(roHistoryAfter['sessions'] as unknown[]).length} sessions`,
);

const roDelete = await ro.client.callTool({
  name: 'delete-lift',
  arguments: {id: 'does-not-exist'},
});
check(
  'delete-lift with garmin:read only is rejected',
  (roDelete as ToolResult).isError === true &&
    resultText(roDelete).includes(WRITE_SCOPE),
  resultText(roDelete).slice(0, 160),
);

// --- 2. Read + write token ---
const readWrite = await obtainToken(`${READ_SCOPE} ${WRITE_SCOPE}`);
check(
  'read+write grant echoes both scopes',
  readWrite.scope?.split(' ').sort().join(' ') ===
    [READ_SCOPE, WRITE_SCOPE].sort().join(' '),
  readWrite.scope,
);
check(
  'consent page shows the write scope when requested',
  readWrite.consentHtml.includes(WRITE_SCOPE),
);

const rw = await connect(readWrite.access_token);
const rwLog = await rw.client.callTool({name: 'log-lift', arguments: liftArgs});
check(
  'log-lift succeeds with garmin:write',
  (rwLog as ToolResult).isError !== true,
  resultText(rwLog).slice(0, 160),
);
const savedId =
  (rwLog as ToolResult).isError === true
    ? ''
    : (parseToolResult(rwLog)['saved'] as {id: string}).id;

// The read-only token can still read what the write token wrote.
const roSees = parseToolResult(
  await ro.client.callTool({
    name: 'get-lift-history',
    arguments: {lift: LIFT_NAME},
  }),
);
check(
  'read-only token reads the session the write token logged',
  (roSees['sessions'] as {id: string}[]).some(s => s.id === savedId),
);

// A read-only token cannot delete it either.
const roDeleteReal = await ro.client.callTool({
  name: 'delete-lift',
  arguments: {id: savedId},
});
const stillThere = (
  parseToolResult(
    await rw.client.callTool({
      name: 'get-lift-history',
      arguments: {lift: LIFT_NAME},
    }),
  )['sessions'] as {id: string}[]
).some(s => s.id === savedId);
check(
  'read-only delete-lift rejected and row untouched',
  (roDeleteReal as ToolResult).isError === true && stillThere,
);

const rwDelete = await rw.client.callTool({
  name: 'delete-lift',
  arguments: {id: savedId},
});
check(
  'delete-lift succeeds with garmin:write',
  (rwDelete as ToolResult).isError !== true &&
    parseToolResult(rwDelete)['deleted'] === true,
  resultText(rwDelete).slice(0, 160),
);

await ro.transport.terminateSession();
await ro.client.close();
await rw.transport.terminateSession();
await rw.client.close();

// --- 3. No scope requested → read-only by default ---
const defaulted = await obtainToken(undefined);
check(
  'omitting scope defaults to garmin:read',
  defaulted.scope === READ_SCOPE,
  defaulted.scope,
);
const def = await connect(defaulted.access_token);
const defLog = await def.client.callTool({
  name: 'log-lift',
  arguments: liftArgs,
});
check(
  'default (no scope) token cannot write',
  (defLog as ToolResult).isError === true,
);
await def.transport.terminateSession();
await def.client.close();

// --- 4. Unknown scope is refused with invalid_scope ---
const unknown = await authorize(
  `${READ_SCOPE} ${UNKNOWN_SCOPE}`,
  createHash('sha256').update('x').digest().toString('base64url'),
);
const unknownError =
  unknown.location !== ''
    ? new URL(unknown.location).searchParams.get('error')
    : null;
check(
  'unknown scope redirects with error=invalid_scope',
  unknown.status === 302 && unknownError === 'invalid_scope',
  `status ${unknown.status} error=${unknownError}`,
);

// --- 5. Blank scope entries are separator noise, not unknown scopes ---
const blank = await authorize(
  '',
  createHash('sha256').update('y').digest().toString('base64url'),
);
check(
  'empty scope parameter renders the login page (defaults to read)',
  blank.status === 200 && blank.pendingId !== '',
  `status ${blank.status}`,
);
const doubled = await authorize(
  `${READ_SCOPE}  ${WRITE_SCOPE}`,
  createHash('sha256').update('z').digest().toString('base64url'),
);
check(
  'doubled space between scopes is accepted',
  doubled.status === 200 && doubled.html.includes(WRITE_SCOPE),
  `status ${doubled.status}`,
);

// --- 6. Refresh scope handling (RFC 6749 §6) ---
interface RefreshOutcome {
  status: number;
  body: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
  };
}

async function refresh(
  refreshToken: string,
  scope?: string,
): Promise<RefreshOutcome> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
  });
  if (scope !== undefined) params.set('scope', scope);
  const res = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: params,
  });
  return {
    status: res.status,
    body: (await res.json()) as RefreshOutcome['body'],
  };
}

const widen = await refresh(readOnly.refresh_token, WRITE_SCOPE);
check(
  'refresh asking beyond the grant fails with invalid_scope',
  widen.status === 400 && widen.body.error === 'invalid_scope',
  `status ${widen.status} error=${widen.body.error}`,
);

const narrowed = await refresh(readWrite.refresh_token, READ_SCOPE);
check(
  'narrowed refresh issues a read-only access token',
  narrowed.status === 200 && narrowed.body.scope === READ_SCOPE,
  `status ${narrowed.status} scope=${narrowed.body.scope}`,
);
const restored = await refresh(narrowed.body.refresh_token ?? '');
check(
  'rotated refresh token keeps the full original grant',
  restored.status === 200 &&
    restored.body.scope?.split(' ').includes(WRITE_SCOPE) === true,
  `status ${restored.status} scope=${restored.body.scope}`,
);

// --- 7. Wrong password on an expired/unknown pending id ---
const stale = await fetch(new URL(LOGIN_PATH, baseUrl), {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    pending_id: 'no-such-pending-id',
    password: 'definitely-wrong',
  }),
  redirect: 'manual',
});
const staleHtml = await stale.text();
check(
  'wrong password on an expired sign-in shows the expired page, not a form',
  stale.status === 400 &&
    staleHtml.includes('expired') &&
    !staleHtml.includes('name="password"'),
  `status ${stale.status}`,
);

console.log(
  failures === 0
    ? '\nAll scope checks passed'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
