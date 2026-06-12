/**
 * Pure builders for Garmin workout-service strength-workout payloads.
 * The DTO shapes (and the fact that weight is sent in display units, not
 * normalized kg) were pinned by round-tripping a Connect-web-UI-built
 * workout through getWorkoutDetail(); the vocabulary lives in
 * STRENGTH_WORKOUT in constants.ts. Garmin assigns stepIds server-side,
 * so every stepId is sent null; stepOrder increments globally across
 * nesting (a repeat group and its children share the running counter).
 */
import {
  LIFT_EXERCISES,
  LiftExerciseKey,
  STRENGTH_WORKOUT,
} from './constants.js';

export interface ExerciseInput {
  exercise: LiftExerciseKey;
  sets: number;
  reps: number;
  /** Load in the unit given to buildStrengthWorkout (the user's display unit). */
  targetWeight?: number;
  /** Timed rest between sets; omitted = press-lap-to-continue rest. */
  restSeconds?: number;
}

export type WeightUnit =
  (typeof STRENGTH_WORKOUT.weightUnit)[keyof typeof STRENGTH_WORKOUT.weightUnit];

interface StepCommon {
  type: string;
  stepId: null;
  stepOrder: number;
  childStepId: number | null;
  stepType: {stepTypeId: number; stepTypeKey: string};
}

interface ExecutableStep extends StepCommon {
  description: null;
  endCondition: {conditionTypeId: number; conditionTypeKey: string};
  endConditionValue: number;
  targetType: {workoutTargetTypeId: number; workoutTargetTypeKey: string};
  category: string | null;
  exerciseName: string | null;
  weightValue: number | null;
  weightUnit: WeightUnit | null;
}

interface RepeatGroup extends StepCommon {
  numberOfIterations: number;
  smartRepeat: boolean;
  endCondition: {conditionTypeId: number; conditionTypeKey: string};
  endConditionValue: number;
  workoutSteps: ExecutableStep[];
}

export interface StrengthWorkoutPayload {
  workoutName: string;
  description: string;
  sportType: typeof STRENGTH_WORKOUT.sportType;
  workoutSegments: [
    {
      segmentOrder: 1;
      sportType: typeof STRENGTH_WORKOUT.sportType;
      workoutSteps: Array<ExecutableStep | RepeatGroup>;
    },
  ];
}

/** Mutable global step-order counter shared across one build. */
class StepCounter {
  private next = 1;
  take(): number {
    return this.next++;
  }
}

function workStep(
  order: StepCounter,
  childStepId: number | null,
  input: ExerciseInput,
  unit: WeightUnit,
): ExecutableStep {
  const taxonomy = LIFT_EXERCISES[input.exercise];
  return {
    type: STRENGTH_WORKOUT.stepDtoType.executable,
    stepId: null,
    stepOrder: order.take(),
    childStepId,
    stepType: STRENGTH_WORKOUT.stepType.interval,
    description: null,
    endCondition: STRENGTH_WORKOUT.endCondition.reps,
    endConditionValue: input.reps,
    targetType: STRENGTH_WORKOUT.noTarget,
    category: taxonomy.category,
    exerciseName: taxonomy.exerciseName,
    weightValue: input.targetWeight ?? null,
    weightUnit: input.targetWeight === undefined ? null : unit,
  };
}

function restStep(
  order: StepCounter,
  childStepId: number | null,
  restSeconds: number | undefined,
): ExecutableStep {
  return {
    type: STRENGTH_WORKOUT.stepDtoType.executable,
    stepId: null,
    stepOrder: order.take(),
    childStepId,
    stepType: STRENGTH_WORKOUT.stepType.rest,
    description: null,
    endCondition:
      restSeconds === undefined
        ? STRENGTH_WORKOUT.endCondition.lapButton
        : STRENGTH_WORKOUT.endCondition.time,
    endConditionValue: restSeconds ?? 0,
    targetType: STRENGTH_WORKOUT.noTarget,
    category: null,
    exerciseName: null,
    weightValue: null,
    weightUnit: null,
  };
}

/**
 * One exercise becomes either a bare work step (a single set, mirroring
 * what the Connect UI produces) or a RepeatGroupDTO of work + rest
 * iterated `sets` times. childStepId ties a group to its children and is
 * unique per group within the workout.
 */
export function buildStrengthWorkout(
  name: string,
  exercises: readonly ExerciseInput[],
  unit: WeightUnit,
  description?: string,
): StrengthWorkoutPayload {
  const order = new StepCounter();
  let groupCount = 0;
  const steps: Array<ExecutableStep | RepeatGroup> = [];

  for (const input of exercises) {
    if (input.sets === 1) {
      steps.push(workStep(order, null, input, unit));
      if (input.restSeconds !== undefined) {
        steps.push(restStep(order, null, input.restSeconds));
      }
      continue;
    }
    groupCount += 1;
    steps.push({
      type: STRENGTH_WORKOUT.stepDtoType.repeatGroup,
      stepId: null,
      stepOrder: order.take(),
      childStepId: groupCount,
      stepType: STRENGTH_WORKOUT.stepType.repeat,
      numberOfIterations: input.sets,
      smartRepeat: false,
      endCondition: STRENGTH_WORKOUT.endCondition.iterations,
      endConditionValue: input.sets,
      workoutSteps: [
        workStep(order, groupCount, input, unit),
        restStep(order, groupCount, input.restSeconds),
      ],
    });
  }

  return {
    workoutName: name,
    description: description ?? STRENGTH_WORKOUT.defaultDescription,
    sportType: STRENGTH_WORKOUT.sportType,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: STRENGTH_WORKOUT.sportType,
        workoutSteps: steps,
      },
    ],
  };
}
