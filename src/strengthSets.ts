/**
 * Pure transform from Garmin's raw per-set strength payload
 * (/activity-service/activity/{id}/exerciseSets) into a clean, review-ready
 * session: consecutive same-name ACTIVE sets grouped per exercise, each REST
 * folded onto the preceding working set as restSec, weights converted from
 * integer grams to pounds (raw grams retained), and the watch's per-set
 * auto-detect probability surfaced — low-confidence guesses flagged for the
 * user to verify rather than trusted silently.
 *
 * The user validates reps (and weight when needed) on the watch during each
 * set, so these values are user-confirmed truth, not passive ML output. No
 * Garmin client here: callers pass the raw payload plus session metadata, so
 * this stays unit-testable without an account.
 */
import {STRENGTH_SETS} from './constants.js';

/** One detected exercise within a raw set (watch ML guess + confidence). */
export interface RawExercise {
  category: string | null;
  name: string | null;
  probability: number | null;
}

/** A single raw set row from the exerciseSets endpoint. */
export interface RawExerciseSet {
  exercises: RawExercise[];
  /** Seconds: time-under-tension for ACTIVE, rest length for REST. */
  duration: number | null;
  repetitionCount: number | null;
  /** Load in integer grams; null for bodyweight or REST rows. */
  weight: number | null;
  setType: string;
  startTime: string | null;
  wktStepIndex: number | null;
  messageIndex: number | null;
}

export interface RawExerciseSetsResponse {
  activityId: number;
  exerciseSets: RawExerciseSet[];
}

/** Session-level context the transform cannot derive from the sets alone. */
export interface StrengthSessionMeta {
  activityId: number;
  name: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  startTime: string | null;
  avgHR: number | null;
  maxHR: number | null;
  minHR: number | null;
  calories: number | null;
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
}

export interface WorkingSet {
  setNumber: number;
  reps: number | null;
  /** Pounds, snapped to weightStepLb; null for bodyweight. */
  weightLb: number | null;
  /** Raw integer grams as stored by Garmin; null for bodyweight. */
  weightGrams: number | null;
  /** Rest after this set in seconds (folded from the following REST row). */
  restSec: number;
}

export interface ExerciseGroup {
  /** Garmin taxonomy name key, e.g. 'BARBELL_ROW'. */
  name: string;
  category: string;
  /** Lowest per-set auto-detect confidence in the group (percent). */
  probability: number | null;
  /** True when probability is sub-threshold or the exercise is UNKNOWN. */
  lowConfidence: boolean;
  sets: WorkingSet[];
  topWeightLb: number | null;
  totalReps: number;
}

export interface LowConfidenceFlag {
  name: string;
  category: string;
  probability: number | null;
  reason: string;
}

export interface SessionConditioning {
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
  avgHR: number | null;
  maxHR: number | null;
  minHR: number | null;
  calories: number | null;
  totalRestSeconds: number;
  totalActiveSets: number;
  totalReps: number;
  exerciseCount: number;
}

export interface StrengthSession {
  activityId: number;
  name: string;
  date: string;
  startTime: string | null;
  conditioning: SessionConditioning;
  /** Surfaced prominently so a post-workout review can verify these first. */
  lowConfidenceFlags: LowConfidenceFlag[];
  exercises: ExerciseGroup[];
  /** Human-readable digest for a post-workout review chat. */
  summary: string;
}

/** Integer grams → pounds, snapped to weightStepLb. Null passes through. */
export function gramsToPounds(grams: number | null): number | null {
  if (grams === null) return null;
  const pounds = grams / STRENGTH_SETS.gramsPerPound;
  const step = STRENGTH_SETS.weightStepLb;
  return Math.round(pounds / step) * step;
}

function isUnknown(value: string | null): boolean {
  return (
    value === null || value.toUpperCase().includes(STRENGTH_SETS.unknownToken)
  );
}

/** Build the "verify" reason string for a flagged exercise. */
function lowConfidenceReason(
  name: string,
  category: string,
  probability: number | null,
): string | null {
  if (isUnknown(name) || isUnknown(category)) {
    return 'unrecognized exercise (UNKNOWN) — verify the lift name';
  }
  if (
    probability !== null &&
    probability < STRENGTH_SETS.lowConfidencePercent
  ) {
    return `auto-detect confidence ${probability.toFixed(
      1,
    )}% < ${STRENGTH_SETS.lowConfidencePercent}% — verify the lift`;
  }
  return null;
}

function roundSeconds(value: number | null): number {
  return value === null ? 0 : Math.round(value);
}

/**
 * Group consecutive same-name ACTIVE sets into exercises, folding each REST
 * onto the preceding working set, and convert weights to pounds.
 */
export function transformStrengthSession(
  raw: RawExerciseSetsResponse,
  meta: StrengthSessionMeta,
): StrengthSession {
  const groups: ExerciseGroup[] = [];
  let current: ExerciseGroup | undefined;
  let lastSet: WorkingSet | undefined;
  let totalRestSeconds = 0;

  for (const row of raw.exerciseSets) {
    if (row.setType === STRENGTH_SETS.restSetType) {
      // Fold rest onto the preceding working set; drop leading/orphan rests.
      const seconds = roundSeconds(row.duration);
      totalRestSeconds += seconds;
      if (lastSet !== undefined) lastSet.restSec += seconds;
      continue;
    }
    if (row.setType !== STRENGTH_SETS.activeSetType) continue;

    const detected = row.exercises[0];
    const name = detected?.name ?? STRENGTH_SETS.unknownToken;
    const category = detected?.category ?? STRENGTH_SETS.unknownToken;
    const probability = detected?.probability ?? null;

    // Start a new group when the exercise name changes.
    if (current === undefined || current.name !== name) {
      current = {
        name,
        category,
        probability,
        lowConfidence: false,
        sets: [],
        topWeightLb: null,
        totalReps: 0,
      };
      groups.push(current);
    } else if (probability !== null) {
      // Keep the most conservative confidence seen across the group's sets.
      current.probability =
        current.probability === null
          ? probability
          : Math.min(current.probability, probability);
    }

    const set: WorkingSet = {
      setNumber: current.sets.length + 1,
      reps: row.repetitionCount,
      weightLb: gramsToPounds(row.weight),
      weightGrams: row.weight,
      restSec: 0,
    };
    current.sets.push(set);
    current.totalReps += set.reps ?? 0;
    if (set.weightLb !== null) {
      current.topWeightLb = Math.max(current.topWeightLb ?? 0, set.weightLb);
    }
    lastSet = set;
  }

  // Resolve confidence flags now that each group's min probability is known.
  const lowConfidenceFlags: LowConfidenceFlag[] = [];
  for (const group of groups) {
    const reason = lowConfidenceReason(
      group.name,
      group.category,
      group.probability,
    );
    if (reason !== null) {
      group.lowConfidence = true;
      lowConfidenceFlags.push({
        name: group.name,
        category: group.category,
        probability: group.probability,
        reason,
      });
    }
  }

  const totalActiveSets = groups.reduce((n, g) => n + g.sets.length, 0);
  const totalReps = groups.reduce((n, g) => n + g.totalReps, 0);

  const conditioning: SessionConditioning = {
    durationSeconds: meta.durationSeconds,
    movingDurationSeconds: meta.movingDurationSeconds,
    avgHR: meta.avgHR,
    maxHR: meta.maxHR,
    minHR: meta.minHR,
    calories: meta.calories,
    totalRestSeconds,
    totalActiveSets,
    totalReps,
    exerciseCount: groups.length,
  };

  return {
    activityId: meta.activityId,
    name: meta.name,
    date: meta.date,
    startTime: meta.startTime,
    conditioning,
    lowConfidenceFlags,
    exercises: groups,
    summary: buildSummary(meta, groups, conditioning, lowConfidenceFlags),
  };
}

/** Compact, human-readable digest for a post-workout review chat. */
function buildSummary(
  meta: StrengthSessionMeta,
  groups: ExerciseGroup[],
  conditioning: SessionConditioning,
  flags: LowConfidenceFlag[],
): string {
  const lines: string[] = [];
  lines.push(`${meta.name} — ${meta.date}`);
  for (const group of groups) {
    const setText = group.sets
      .map(s => {
        const load = s.weightLb === null ? 'BW' : `${s.weightLb}lb`;
        return `${load}×${s.reps ?? '?'}`;
      })
      .join(', ');
    const flag = group.lowConfidence ? '  ⚠ verify' : '';
    lines.push(`  ${group.name}: ${setText}${flag}`);
  }
  const mins = conditioning.durationSeconds
    ? Math.round(conditioning.durationSeconds / 60)
    : null;
  lines.push(
    `  conditioning: ${mins ?? '?'} min, HR ${conditioning.avgHR ?? '?'}avg/${
      conditioning.maxHR ?? '?'
    }max, ${conditioning.calories ?? '?'} kcal, ${
      conditioning.totalReps
    } reps over ${conditioning.totalActiveSets} sets`,
  );
  if (flags.length > 0) {
    lines.push(
      `  ⚠ ${flags.length} low-confidence exercise(s) to verify: ${flags
        .map(f => f.name)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
