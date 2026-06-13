/**
 * Synthetic unit acceptance for the strength-sets transform (pure, no
 * Garmin account). Feeds hand-built exerciseSets fixtures through
 * transformStrengthSession() and asserts the active+rest folding,
 * gram→lb conversion, low-confidence flagging, and same-name grouping.
 *
 *   npx tsx scripts/strength-sets-test.ts
 */
import {
  transformStrengthSession,
  type RawExerciseSetsResponse,
  type StrengthSessionMeta,
} from '../src/strengthSets.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

const META: StrengthSessionMeta = {
  activityId: 1,
  name: 'Test Session',
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
  duration = 30,
) {
  return {
    exercises: [{category, name, probability}],
    duration,
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

// --- Fixture 1: two barbell-row sets with a rest between, high confidence ---
const rowFixture: RawExerciseSetsResponse = {
  activityId: 1,
  exerciseSets: [
    active('BARBELL_ROW', 'ROW', 8, 52187, 99.6),
    rest(150),
    active('BARBELL_ROW', 'ROW', 8, 52187, 99.6),
    rest(120),
  ],
};

const row = transformStrengthSession(rowFixture, META);

// 1. Same-name grouping: both active sets collapse into one exercise group.
check(
  'consecutive same-name actives form one exercise group',
  row.exercises.length === 1 && row.exercises[0].name === 'BARBELL_ROW',
  `got ${row.exercises.length} groups`,
);
check(
  'group keeps both working sets',
  row.exercises[0]?.sets.length === 2,
  `got ${row.exercises[0]?.sets.length} sets`,
);

// 2. gram→lb conversion: 52187 g → 115.0 lb, raw grams retained.
check(
  'gram→lb conversion 52187 → 115.0',
  row.exercises[0]?.sets[0]?.weightLb === 115.0,
  `got ${row.exercises[0]?.sets[0]?.weightLb}`,
);
check(
  'raw weightGrams retained',
  row.exercises[0]?.sets[0]?.weightGrams === 52187,
  `got ${row.exercises[0]?.sets[0]?.weightGrams}`,
);

// 3. Active+rest folding: the REST after each active set becomes its restSec.
check(
  'first set folds the following 150s rest',
  row.exercises[0]?.sets[0]?.restSec === 150,
  `got ${row.exercises[0]?.sets[0]?.restSec}`,
);
check(
  'second set folds the following 120s rest',
  row.exercises[0]?.sets[1]?.restSec === 120,
  `got ${row.exercises[0]?.sets[1]?.restSec}`,
);

// 4. High confidence is NOT flagged.
check(
  'high-confidence exercise not flagged',
  row.exercises[0]?.lowConfidence === false &&
    row.lowConfidenceFlags.length === 0,
  `flags=${row.lowConfidenceFlags.length}`,
);

// 5. Conditioning context derived + carried from meta.
check(
  'conditioning totals derived from sets',
  row.conditioning.totalReps === 16 &&
    row.conditioning.totalActiveSets === 2 &&
    row.conditioning.totalRestSeconds === 270 &&
    row.conditioning.exerciseCount === 1,
  JSON.stringify(row.conditioning),
);
check(
  'conditioning HR/calories carried from meta',
  row.conditioning.avgHR === 125 &&
    row.conditioning.maxHR === 145 &&
    row.conditioning.calories === 238,
);

// --- Fixture 2: grouping change + low confidence + bodyweight ---
const mixedFixture: RawExerciseSetsResponse = {
  activityId: 2,
  exerciseSets: [
    active('BARBELL_ROW', 'ROW', 8, 52187, 99.6),
    rest(150),
    active('LAT_PULLDOWN', 'PULL_UP', 10, 45000, 78.2), // low confidence
    rest(120),
    active('PULL_UP', 'PULL_UP', 6, null, 99.0), // bodyweight
    active('UNKNOWN', 'UNKNOWN', 12, 20000, 95.0), // unknown name/category
  ],
};

const mixed = transformStrengthSession(mixedFixture, {...META, activityId: 2});

// 6. Different exercise names start new groups (no merging across names).
check(
  'distinct exercise names form distinct groups',
  mixed.exercises.length === 4,
  `got ${mixed.exercises.length} groups: ${mixed.exercises
    .map(e => e.name)
    .join(',')}`,
);

// 7. Low-confidence (<90%) flagged prominently.
const latFlag = mixed.lowConfidenceFlags.find(f => f.name === 'LAT_PULLDOWN');
check(
  'sub-90% probability flagged',
  latFlag !== undefined && mixed.exercises[1]?.lowConfidence === true,
  JSON.stringify(mixed.lowConfidenceFlags),
);

// 8. UNKNOWN name/category flagged even at high probability.
const unknownFlag = mixed.lowConfidenceFlags.find(f => f.name === 'UNKNOWN');
check(
  'UNKNOWN exercise flagged despite high probability',
  unknownFlag !== undefined,
);

// 9. Bodyweight set: weight null → weightLb null, weightGrams null.
const pullup = mixed.exercises.find(e => e.name === 'PULL_UP');
check(
  'bodyweight set has null weightLb and weightGrams',
  pullup?.sets[0]?.weightLb === null && pullup?.sets[0]?.weightGrams === null,
  JSON.stringify(pullup?.sets[0]),
);

// 10. Human-readable review summary is present and mentions the lifts.
check(
  'review summary text present',
  typeof mixed.summary === 'string' &&
    mixed.summary.includes('BARBELL_ROW') &&
    mixed.summary.length > 0,
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
