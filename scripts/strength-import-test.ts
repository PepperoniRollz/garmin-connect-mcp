/**
 * Synthetic acceptance for the Garmin → lift-log import path (Approach B).
 * Covers the pure import builder (name mapping, same-name merge, gram→lb,
 * rest preservation, unmapped-key flagging) and the store's upsert/dedup
 * behavior (idempotent re-import, manual-collision supersede). Uses a
 * throwaway SQLite file — no Garmin account.
 *
 *   npx tsx scripts/strength-import-test.ts
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {
  transformStrengthSession,
  type RawExerciseSetsResponse,
  type StrengthSessionMeta,
} from '../src/strengthSets.js';
import {
  buildImportPlan,
  garminKeyToLiftName,
} from '../src/lift/garminImport.js';
import {LiftDb} from '../src/lift/db.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

const META: StrengthSessionMeta = {
  activityId: 999,
  name: 'Pull — Test',
  date: '2026-06-13',
  startTime: '2026-06-13T17:08:03.0',
  avgHR: 125,
  maxHR: 145,
  minHR: 103,
  calories: 238,
  durationSeconds: 1691,
  movingDurationSeconds: 490,
};

function active(
  name: string,
  category: string,
  reps: number,
  weight: number | null,
  probability: number,
) {
  return {
    exercises: [{category, name, probability}],
    duration: 30,
    repetitionCount: reps,
    weight,
    setType: 'ACTIVE',
    startTime: '2026-06-13T21:08:03.0',
    wktStepIndex: 0,
    messageIndex: null,
  };
}

function rest(duration: number) {
  return {
    exercises: [],
    duration,
    repetitionCount: null,
    weight: null,
    setType: 'REST',
    startTime: '2026-06-13T21:08:36.0',
    wktStepIndex: 1,
    messageIndex: null,
  };
}

// --- garminKeyToLiftName -----------------------------------------------------
const mapped = garminKeyToLiftName('BARBELL_ROW');
check(
  'mapped taxonomy key resolves to its shorthand',
  mapped.name === 'barbell-row' && mapped.mapped === true,
  JSON.stringify(mapped),
);
const unmapped = garminKeyToLiftName('SOME_WEIRD_LIFT');
check(
  'unmapped key normalized and flagged',
  unmapped.name === 'some-weird-lift' && unmapped.mapped === false,
  JSON.stringify(unmapped),
);

// --- buildImportPlan ---------------------------------------------------------
const raw: RawExerciseSetsResponse = {
  activityId: 999,
  exerciseSets: [
    active('BARBELL_ROW', 'ROW', 8, 52187, 99.6),
    rest(150),
    active('BARBELL_ROW', 'ROW', 8, 52187, 99.6),
    rest(120),
    active('DUMBBELL_BICEPS_CURL', 'CURL', 15, 9062, 99.6),
    rest(75),
    // Non-consecutive repeat of barbell row → must merge into one session.
    active('BARBELL_ROW', 'ROW', 7, 52187, 99.6),
    active('SOME_WEIRD_LIFT', 'UNKNOWN', 10, 20000, 95.0),
  ],
};
const session = transformStrengthSession(raw, META);
const plan = buildImportPlan(session);

check(
  'one import session per distinct exercise name',
  plan.sessions.length === 3,
  `got ${plan.sessions.map(s => s.lift).join(',')}`,
);

const rowSession = plan.sessions.find(s => s.garminKey === 'BARBELL_ROW');
check(
  'non-consecutive same-name sets merged into one session',
  rowSession?.sets.length === 3,
  `got ${rowSession?.sets.length}`,
);
check(
  'import preserves gram→lb weight',
  rowSession?.sets[0]?.weight === 115,
  `got ${rowSession?.sets[0]?.weight}`,
);
check(
  'import preserves per-set reps',
  rowSession?.sets[2]?.reps === 7,
  `got ${rowSession?.sets[2]?.reps}`,
);
check(
  'import preserves per-set rest',
  rowSession?.sets[0]?.restSec === 150,
  `got ${rowSession?.sets[0]?.restSec}`,
);
check(
  'import carries activityId',
  rowSession?.activityId === 999 && plan.activityId === 999,
);

const weird = plan.sessions.find(s => s.garminKey === 'SOME_WEIRD_LIFT');
check(
  'unmapped exercise flagged in plan',
  weird?.mapped === false &&
    plan.unmapped.some(u => u.garminKey === 'SOME_WEIRD_LIFT'),
  JSON.stringify(plan.unmapped),
);

// --- store: upsertGarminSession ---------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), 'lift-import-'));
const db = new LiftDb(path.join(dir, 'lifts.db'));
try {
  // Pre-existing MANUAL entry on the same date+lift → Garmin must supersede.
  const manual = db.insertSession({
    date: '2026-06-13',
    lift: 'barbell-row',
    sets: [{weight: 110, reps: 8}],
  });
  check('manual seed inserted', db.getById(manual.id) !== undefined);

  const first = db.upsertGarminSession({
    date: '2026-06-13',
    lift: 'barbell-row',
    activityId: 999,
    sets: [
      {weight: 115, reps: 8, restSec: 150},
      {weight: 115, reps: 8, restSec: 120},
      {weight: 115, reps: 7, restSec: 0},
    ],
  });
  check(
    'garmin import supersedes colliding manual row',
    first.replaced.some(r => r.id === manual.id),
    `replaced=${first.replaced.length}`,
  );
  check('superseded manual row is gone', db.getById(manual.id) === undefined);

  const afterFirst = db.listSessions('barbell-row', 100);
  check(
    'unified log holds exactly one barbell-row row after import',
    afterFirst.length === 1 &&
      afterFirst[0]?.source === 'garmin' &&
      afterFirst[0]?.activityId === 999,
    JSON.stringify(afterFirst.map(s => ({src: s.source, act: s.activityId}))),
  );

  // Re-import the SAME activity → idempotent, no duplicate.
  db.upsertGarminSession({
    date: '2026-06-13',
    lift: 'barbell-row',
    activityId: 999,
    sets: [
      {weight: 115, reps: 8, restSec: 150},
      {weight: 115, reps: 8, restSec: 120},
      {weight: 115, reps: 7, restSec: 0},
    ],
  });
  const afterReimport = db.listSessions('barbell-row', 100);
  check(
    're-confirming the same activity does not double-import',
    afterReimport.length === 1,
    `got ${afterReimport.length} rows`,
  );

  check(
    'imported row preserves rest on its sets',
    afterReimport[0]?.sets[0]?.restSec === 150,
    JSON.stringify(afterReimport[0]?.sets[0]),
  );
} finally {
  db.close();
  rmSync(dir, {recursive: true, force: true});
}

// --- migration: opening a pre-import-schema DB upgrades it in place --------
const oldDir = mkdtempSync(path.join(tmpdir(), 'lift-old-'));
const oldPath = path.join(oldDir, 'lifts.db');
try {
  // Seed a DB with the ORIGINAL schema (no source/activity_id columns).
  const legacy = new DatabaseSync(oldPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      lift TEXT NOT NULL,
      sets TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );`);
  legacy
    .prepare(
      `INSERT INTO sessions (id, date, lift, sets, note, created_at)
       VALUES ('legacy1', '2026-06-01', 'barbell-row', '[{"weight":110,"reps":8}]', NULL, 1)`,
    )
    .run();
  legacy.close();

  // Opening through LiftDb must migrate (add columns + index) without error.
  const migrated = new LiftDb(oldPath);
  const legacyRow = migrated.getById('legacy1');
  check(
    'legacy row survives migration as source=manual',
    legacyRow?.source === 'manual' && legacyRow?.activityId === undefined,
    JSON.stringify(legacyRow),
  );
  const up = migrated.upsertGarminSession({
    date: '2026-06-02',
    lift: 'barbell-row',
    activityId: 555,
    sets: [{weight: 115, reps: 8, restSec: 90}],
  });
  check(
    'garmin import works against a migrated DB',
    up.session.source === 'garmin' && up.session.activityId === 555,
  );
  migrated.close();
} finally {
  rmSync(oldDir, {recursive: true, force: true});
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
