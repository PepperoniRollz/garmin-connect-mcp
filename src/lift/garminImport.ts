/**
 * Pure bridge from a transformed Garmin strength session (src/strengthSets.ts)
 * into rows for the unified lift log. Maps Garmin taxonomy keys back to the
 * owner's shorthand vocabulary so imported sessions share the same lift names
 * as manually-logged ones and create-workout, merges any non-consecutive
 * repeats of the same exercise into one session, and carries reps/weight/rest
 * per set. No DB or Garmin client here — kept unit-testable.
 */
import {LIFT_EXERCISES} from '../constants.js';
import type {StrengthSession} from '../strengthSets.js';
import type {LiftSet} from './db.js';

/** Garmin exerciseName key → owner shorthand (first shorthand wins). */
const KEY_TO_SHORTHAND: ReadonlyMap<string, string> = new Map(
  // Reverse so that on duplicate exerciseName keys the FIRST-declared
  // shorthand wins (Map keeps the last entry set for a key).
  Object.entries(LIFT_EXERCISES)
    .map(([shorthand, def]): [string, string] => [def.exerciseName, shorthand])
    .reverse(),
);

/**
 * Resolve a Garmin taxonomy key to a lift-log name. Configured lifts map to
 * their shorthand (BARBELL_ROW → barbell-row); anything else is normalized to
 * lowercase-hyphenated and flagged unmapped so the caller can surface it.
 */
export function garminKeyToLiftName(garminKey: string): {
  name: string;
  mapped: boolean;
} {
  const shorthand = KEY_TO_SHORTHAND.get(garminKey);
  if (shorthand !== undefined) return {name: shorthand, mapped: true};
  return {name: garminKey.toLowerCase().replace(/_/g, '-'), mapped: false};
}

/** One lift session ready to import into the log. */
export interface ImportSession {
  date: string;
  /** Lift-log name (shorthand when mapped, normalized key otherwise). */
  lift: string;
  /** Original Garmin taxonomy key, retained for traceability. */
  garminKey: string;
  /** False when the key was not in the configured vocabulary. */
  mapped: boolean;
  sets: LiftSet[];
  activityId: number;
}

/** An exercise whose Garmin key was not in the configured vocabulary. */
export interface UnmappedExercise {
  garminKey: string;
  storedAs: string;
}

export interface ImportPlan {
  activityId: number;
  date: string;
  sessions: ImportSession[];
  unmapped: UnmappedExercise[];
}

/**
 * Build the set of lift-log sessions to import from a reviewed Garmin
 * session: one session per distinct exercise (non-consecutive repeats of the
 * same exercise merged), bodyweight sets stored as weight 0.
 */
export function buildImportPlan(session: StrengthSession): ImportPlan {
  // Merge by Garmin key, preserving first-seen order.
  const byKey = new Map<string, ImportSession>();
  for (const group of session.exercises) {
    const sets: LiftSet[] = group.sets.map(s => ({
      weight: s.weightLb ?? 0,
      reps: s.reps ?? 0,
      restSec: s.restSec,
    }));
    const existing = byKey.get(group.name);
    if (existing !== undefined) {
      existing.sets.push(...sets);
      continue;
    }
    const {name, mapped} = garminKeyToLiftName(group.name);
    byKey.set(group.name, {
      date: session.date,
      lift: name,
      garminKey: group.name,
      mapped,
      sets,
      activityId: session.activityId,
    });
  }

  const sessions = [...byKey.values()];
  const unmapped: UnmappedExercise[] = sessions
    .filter(s => !s.mapped)
    .map(s => ({garminKey: s.garminKey, storedAs: s.lift}));
  return {
    activityId: session.activityId,
    date: session.date,
    sessions,
    unmapped,
  };
}
