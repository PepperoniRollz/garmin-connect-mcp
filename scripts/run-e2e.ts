/**
 * End-to-end test orchestrator (used by `npm test` and CI).
 *
 * Starts the server in HTTP mode with synthetic credentials, waits for
 * /healthz, then runs the OAuth flow suite and the session lifecycle suite
 * against it. No Garmin account is contacted: the suites stop at tools/list.
 */
import {spawn, ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

import bcrypt from 'bcryptjs';

const PORT = 8099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEALTHZ_URL = `${BASE_URL}/healthz`;
const OWNER_PASSWORD = 'e2e-test-password';
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const workDir = mkdtempSync(path.join(tmpdir(), 'garmin-mcp-e2e-'));
const tokenSavePath = path.join(workDir, 'tokens.json');

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(command, args, {env, stdio: 'inherit'});
}

function runToCompletion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise(resolve => {
    const child = run(command, args, env);
    child.on('exit', code => resolve(code ?? 1));
  });
}

async function waitForHealthz(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTHZ_URL);
      if (res.ok) return;
    } catch {
      // Server not up yet.
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `server did not become healthy within ${STARTUP_TIMEOUT_MS}ms`,
  );
}

const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  TRANSPORT_MODE: 'http',
  PORT: String(PORT),
  GARMIN_USERNAME: 'e2e@example.com',
  GARMIN_PASSWORD: 'e2e-fake-password',
  GARMIN_MCP_PUBLIC_URL: `${BASE_URL}/mcp`,
  SERVER_OWNER_PASSWORD_HASH: bcrypt.hashSync(OWNER_PASSWORD, 4), // low cost: test only
  AUTH_DB_PATH: path.join(workDir, 'auth.db'),
  TOKEN_CACHE_DIR: path.join(workDir, 'tokens'),
  LIFT_DB_PATH: path.join(workDir, 'lifts.db'),
  LIFT_TIMEZONE: 'America/New_York',
  LOG_LEVEL: 'warn',
};

// Pure transform/import unit suites: no server or Garmin account needed.
console.log('e2e: running strength-sets transform suite');
const strengthSetsCode = await runToCompletion(
  'npx',
  ['tsx', 'scripts/strength-sets-test.ts'],
  process.env,
);
console.log('e2e: running strength-import suite');
const strengthImportCode = await runToCompletion(
  'npx',
  ['tsx', 'scripts/strength-import-test.ts'],
  process.env,
);

console.log('e2e: starting server in HTTP mode...');
const server = run('npx', ['tsx', 'src/index.ts'], serverEnv);

let exitCode = 1;
try {
  await waitForHealthz();
  console.log('e2e: server healthy; running OAuth flow suite');
  const oauthCode = await runToCompletion(
    'npx',
    ['tsx', 'scripts/oauth-flow-test.ts', BASE_URL, tokenSavePath],
    {...process.env, OAUTH_TEST_PASSWORD: OWNER_PASSWORD},
  );

  console.log('e2e: running session lifecycle suite');
  const sessionCode = await runToCompletion(
    'npx',
    ['tsx', 'scripts/http-session-test.ts', BASE_URL],
    {...process.env, OAUTH_TEST_TOKEN_FILE: tokenSavePath},
  );

  console.log('e2e: running lift-log suite');
  const liftCode = await runToCompletion(
    'npx',
    ['tsx', 'scripts/lift-log-test.ts', BASE_URL],
    {...process.env, OAUTH_TEST_TOKEN_FILE: tokenSavePath},
  );

  exitCode =
    strengthSetsCode === 0 &&
    strengthImportCode === 0 &&
    oauthCode === 0 &&
    sessionCode === 0 &&
    liftCode === 0
      ? 0
      : 1;
  console.log(
    exitCode === 0 ? 'e2e: ALL SUITES PASSED' : 'e2e: FAILURES (see above)',
  );
} finally {
  server.kill();
  rmSync(workDir, {recursive: true, force: true});
}
process.exit(exitCode);
