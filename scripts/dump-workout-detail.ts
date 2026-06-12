/**
 * TEMPORARY payload probe for the create-workout feature (Step 1).
 * Fetches a workout by name (or workoutId) from Garmin Connect and dumps
 * the full IWorkoutDetail JSON so we can pin the exact strength-step
 * shape (weight units, RepeatGroup structure) before building the tool.
 *
 *   npx tsx scripts/dump-workout-detail.ts [name-substring | workoutId]
 *
 * Standalone on purpose: scripts/tsconfig.json forbids ../src imports, and
 * this probe is deleted once create-workout ships. Credentials come from
 * GARMIN_USERNAME/GARMIN_PASSWORD env vars, else the macOS Keychain entries
 * used by stdio mode (service 'garmin-connect-mcp'). Tokens are read from
 * the same cache dir the server uses, so no fresh login is needed.
 */
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import pkg from 'garmin-connect';

const {GarminConnect} = pkg;
const execFileAsync = promisify(execFile);

// Mirrors src/constants.ts (CREDENTIAL_SERVICE, TOKEN_DIR_NAME) — keep in
// sync; not imported because of the scripts/ rootDir boundary.
const CREDENTIAL_SERVICE = 'garmin-connect-mcp';
const TOKEN_DIR_NAME = '.garmin-mcp-tokens';
const DEFAULT_QUERY = 'mcp payload probe';
const WORKOUT_LIST_LIMIT = 50;

async function keychain(account: string): Promise<string> {
  const {stdout} = await execFileAsync('security', [
    'find-generic-password',
    '-s',
    CREDENTIAL_SERVICE,
    '-a',
    account,
    '-w',
  ]);
  return stdout.trim();
}

async function getCredentials(): Promise<{username: string; password: string}> {
  const envUser = process.env['GARMIN_USERNAME'];
  const envPass = process.env['GARMIN_PASSWORD'];
  if (envUser && envPass) return {username: envUser, password: envPass};
  return {
    username: await keychain('username'),
    password: await keychain('password'),
  };
}

const query = process.argv[2] ?? DEFAULT_QUERY;
const tokenCacheDir =
  process.env['TOKEN_CACHE_DIR'] ?? path.join(os.homedir(), TOKEN_DIR_NAME);

const gc = new GarminConnect(await getCredentials());
try {
  gc.loadTokenByFile(tokenCacheDir);
  await gc.getUserProfile();
} catch {
  await gc.login();
  gc.exportTokenToFile(tokenCacheDir);
}

let workoutId: string;
if (/^\d+$/.test(query)) {
  workoutId = query;
} else {
  const workouts = await gc.getWorkouts(0, WORKOUT_LIST_LIMIT);
  const match = workouts.find(w =>
    w.workoutName.toLowerCase().includes(query.toLowerCase()),
  );
  if (!match || match.workoutId === undefined) {
    console.error(
      `No workout matching "${query}" in the first ${WORKOUT_LIST_LIMIT}. Found:`,
    );
    for (const w of workouts) {
      console.error(`  ${w.workoutId}  ${w.workoutName}`);
    }
    process.exit(1);
  }
  workoutId = String(match.workoutId);
}

const detail = await gc.getWorkoutDetail({workoutId});
console.log(JSON.stringify(detail, null, 2));
