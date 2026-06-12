/**
 * Lazy fetch-and-cache of Garmin's public exercise taxonomy, used to
 * validate raw {category, exerciseName} pairs passed to create-workout.
 * Validation is advisory by design: when the taxonomy can't be fetched the
 * pair is accepted with a logged warning — creating a workout must never
 * fail because a validation file was unreachable. A successful fetch is
 * cached for the process lifetime (the file is static); a failed fetch is
 * not cached, so the next call retries.
 */
import {EXERCISE_TAXONOMY_URL} from './constants.js';
import {logger} from './logger.js';

interface ExerciseTaxonomy {
  categories: Record<string, {exercises: Record<string, unknown>}>;
}

let taxonomyPromise: Promise<ExerciseTaxonomy | null> | null = null;

async function fetchTaxonomy(): Promise<ExerciseTaxonomy | null> {
  try {
    const response = await fetch(EXERCISE_TAXONOMY_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const taxonomy = (await response.json()) as ExerciseTaxonomy;
    if (typeof taxonomy?.categories !== 'object') {
      throw new Error('unexpected shape: missing categories');
    }
    logger.debug('exercise taxonomy fetched', {
      categories: Object.keys(taxonomy.categories).length,
    });
    return taxonomy;
  } catch (err) {
    taxonomyPromise = null; // retry on the next call
    logger.warn(
      'exercise taxonomy fetch failed; raw pairs accepted unverified',
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

function getTaxonomy(): Promise<ExerciseTaxonomy | null> {
  if (!taxonomyPromise) {
    taxonomyPromise = fetchTaxonomy();
  }
  return taxonomyPromise;
}

export type RawExerciseVerdict =
  | {valid: true; verified: boolean}
  | {valid: false; reason: string};

/**
 * Checks a raw pair against the taxonomy. `verified: false` means the
 * taxonomy was unreachable and the pair is being trusted as given.
 */
export async function validateRawExercise(
  category: string,
  exerciseName: string,
): Promise<RawExerciseVerdict> {
  const taxonomy = await getTaxonomy();
  if (taxonomy === null) {
    return {valid: true, verified: false};
  }
  const categoryEntry = taxonomy.categories[category];
  if (categoryEntry === undefined) {
    return {
      valid: false,
      reason: `Unknown Garmin exercise category "${category}". Valid keys are in ${EXERCISE_TAXONOMY_URL}`,
    };
  }
  if (!(exerciseName in categoryEntry.exercises)) {
    return {
      valid: false,
      reason: `Garmin category "${category}" has no exercise "${exerciseName}". Valid keys are in ${EXERCISE_TAXONOMY_URL}`,
    };
  }
  return {valid: true, verified: true};
}
