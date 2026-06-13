/**
 * Phase 3 acceptance: full OAuth 2.1 flow against a locally running
 * HTTP-mode server.
 *
 *   OAUTH_TEST_PASSWORD=... npx tsx scripts/oauth-flow-test.ts [baseUrl] [tokenSavePath]
 *
 * Covers: discovery (401 + WWW-Authenticate, RFC 9728, RFC 8414), DCR
 * (allowed + rejected redirect URIs), PKCE S256, wrong-password rejection,
 * code exchange, authenticated MCP session, refresh rotation. Optionally
 * saves tokens to tokenSavePath for the restart-survival check.
 */
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MCP_PATH = '/mcp';
const LOGIN_PATH = '/oauth/login';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_CALLBACK = 'http://127.0.0.1:33418/callback';
const DISALLOWED_CALLBACK = 'https://evil.example.com/callback';

const baseUrl = process.argv[2] ?? DEFAULT_BASE_URL;
const tokenSavePath = process.argv[3];
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

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// --- 1. Unauthenticated MCP request → 401 + discovery header ---
const unauth = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 't', version: '0'},
    },
  }),
});
const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
check(
  'unauthenticated MCP request returns 401',
  unauth.status === 401,
  `status ${unauth.status}`,
);
check(
  '401 carries WWW-Authenticate with resource_metadata',
  wwwAuth.includes('resource_metadata='),
  wwwAuth,
);

// --- 2. RFC 9728 protected resource metadata ---
const prmMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
const prmUrl =
  prmMatch?.[1] ??
  new URL('/.well-known/oauth-protected-resource/mcp', baseUrl).href;
const prm = (await (await fetch(prmUrl)).json()) as {
  resource: string;
  authorization_servers: string[];
};
check(
  'PRM resource exactly equals public MCP URL',
  prm.resource === mcpUrl.href,
  prm.resource,
);
check(
  'PRM lists an authorization server',
  prm.authorization_servers.length === 1,
  prm.authorization_servers[0],
);

// --- 3. RFC 8414 authorization server metadata ---
const asMetaUrl = new URL(
  '/.well-known/oauth-authorization-server',
  prm.authorization_servers[0],
);
const asMeta = (await (await fetch(asMetaUrl)).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
};
check(
  'AS metadata served',
  typeof asMeta.authorization_endpoint === 'string',
  asMeta.authorization_endpoint,
);
check(
  'PKCE S256 advertised',
  asMeta.code_challenge_methods_supported.includes('S256'),
  asMeta.code_challenge_methods_supported.join(','),
);

// --- 4. DCR: disallowed redirect URI rejected ---
const badReg = await fetch(asMeta.registration_endpoint, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    redirect_uris: [DISALLOWED_CALLBACK],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
check(
  'DCR with disallowed redirect URI rejected',
  badReg.status === 400,
  `status ${badReg.status}`,
);

// --- 5. DCR: claude.ai + loopback redirect URIs accepted ---
const reg = await fetch(asMeta.registration_endpoint, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    client_name: 'phase3-acceptance',
    redirect_uris: [CLAUDE_CALLBACK, LOOPBACK_CALLBACK],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
check('DCR registers client', reg.status === 201, `status ${reg.status}`);
const client = (await reg.json()) as {client_id: string};

// --- 6. Authorize: login page with pending id ---
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));
const authorizeUrl = new URL(asMeta.authorization_endpoint);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', client.client_id);
authorizeUrl.searchParams.set('redirect_uri', LOOPBACK_CALLBACK);
authorizeUrl.searchParams.set('code_challenge', challenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');
authorizeUrl.searchParams.set('state', state);
const authorizePage = await fetch(authorizeUrl);
const authorizeHtml = await authorizePage.text();
const pendingMatch = authorizeHtml.match(/name="pending_id" value="([^"]+)"/);
check(
  'authorize renders login page with pending id',
  authorizePage.status === 200 && pendingMatch !== null,
);
const pendingId = pendingMatch?.[1] ?? '';

// --- 7. Wrong password cannot obtain a code ---
const badLogin = await fetch(new URL(LOGIN_PATH, baseUrl), {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    pending_id: pendingId,
    password: 'wrong-password-123',
  }),
  redirect: 'manual',
});
check('wrong password rejected with 401, no redirect', badLogin.status === 401);

// --- 8. Correct password → 302 redirect with code + state ---
const goodLogin = await fetch(new URL(LOGIN_PATH, baseUrl), {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({pending_id: pendingId, password: ownerPassword}),
  redirect: 'manual',
});
const location = goodLogin.headers.get('location') ?? '';
const redirect = location !== '' ? new URL(location) : undefined;
const code = redirect?.searchParams.get('code') ?? '';
check(
  'correct password redirects with code',
  goodLogin.status === 302 && code !== '',
);
check('state round-trips', redirect?.searchParams.get('state') === state);

// --- 9. Token exchange with PKCE ---
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
const tokens = (await tokenResp.json()) as {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};
check(
  'token exchange succeeds',
  tokenResp.status === 200 && tokens.access_token !== undefined,
  `expires_in=${tokens.expires_in}`,
);

// --- 10. Code is single-use ---
const replay = await fetch(asMeta.token_endpoint, {
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
check(
  'authorization code replay rejected',
  replay.status === 400,
  `status ${replay.status}`,
);

// --- 11. Authenticated MCP session works ---
const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {headers: {authorization: `Bearer ${tokens.access_token}`}},
});
const mcpClient = new Client({name: 'phase3-acceptance', version: '0.0.0'});
await mcpClient.connect(transport);
const {tools} = await mcpClient.listTools();
check(
  'authenticated MCP session lists tools',
  tools.length === 24,
  `${tools.length} tools`,
);
await transport.terminateSession();
await mcpClient.close();

// --- 12. Garbage token rejected ---
const garbage = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer not-a-real-token',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 't', version: '0'},
    },
  }),
});
check(
  'garbage bearer token rejected with 401',
  garbage.status === 401,
  `status ${garbage.status}`,
);

// --- 13. Refresh rotation ---
const refreshResp = await fetch(asMeta.token_endpoint, {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }),
});
const refreshed = (await refreshResp.json()) as {
  access_token: string;
  refresh_token: string;
};
check(
  'refresh grant issues new tokens',
  refreshResp.status === 200 && refreshed.access_token !== tokens.access_token,
);
const reusedRefresh = await fetch(asMeta.token_endpoint, {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }),
});
check(
  'rotated (old) refresh token rejected',
  reusedRefresh.status === 400,
  `status ${reusedRefresh.status}`,
);

if (tokenSavePath !== undefined) {
  fs.writeFileSync(tokenSavePath, JSON.stringify(refreshed));
  console.log(`tokens saved to ${tokenSavePath}`);
}

console.log(
  failures === 0
    ? '\nAll OAuth flow checks passed'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
