/**
 * Transport-agnostic MCP server factory: registers every Garmin tool on a
 * fresh McpServer instance. Entry points wire the returned server to a
 * concrete transport.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

import {
  AuditEvent,
  GARMIN_API,
  LIFT_PROGRESSION,
  SERVER_INFO,
  ToolName,
} from './constants.js';
import {getClient, getDisplayName} from './garminClient.js';
import {LiftSession, LiftSet} from './lift/db.js';
import {getLiftStore} from './lift/store.js';
import {logger} from './logger.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fields picked from the daily-summary payload (91 keys total; the rest are
 * goal/internal bookkeeping). Calories are kilocalories (dietary Calories).
 *
 * Nutrition: consumedKilocalories syncs from MyFitnessPal;
 * includesCalorieConsumedData flags whether intake was logged that day.
 * remainingKilocalories = netCalorieGoal - consumed + activeKilocalories
 * (Garmin credits activity back against the goal). Macro grams are NOT in
 * this payload — MFP does not propagate them to Garmin.
 */
const DAILY_SUMMARY_FIELDS = [
  'calendarDate',
  'totalKilocalories',
  'activeKilocalories',
  'bmrKilocalories',
  'consumedKilocalories',
  'netCalorieGoal',
  'remainingKilocalories',
  'includesCalorieConsumedData',
  'totalSteps',
  'totalDistanceMeters',
  'moderateIntensityMinutes',
  'vigorousIntensityMinutes',
  'intensityMinutesGoal',
  'restingHeartRate',
  'minHeartRate',
  'maxHeartRate',
  'averageStressLevel',
  'bodyBatteryHighestValue',
  'bodyBatteryLowestValue',
  'sleepingSeconds',
] as const;

function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  // Append time to avoid UTC midnight parsing (which shifts the date in western timezones)
  return new Date(dateStr + 'T00:00:00');
}

/** Local-timezone YYYY-MM-DD, matching the library's own date formatting. */
function toDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatResult(data: unknown): {
  content: {type: 'text'; text: string}[];
} {
  return {
    content: [{type: 'text' as const, text: JSON.stringify(data, null, 2)}],
  };
}

/** Heaviest single set in a session (0 if no sets). */
function topSetWeight(sets: LiftSet[]): number {
  return sets.reduce((max, set) => Math.max(max, set.weight), 0);
}

/** Total reps across all sets in a session. */
function totalReps(sets: LiftSet[]): number {
  return sets.reduce((sum, set) => sum + set.reps, 0);
}

/** True when every working set met the rep target (double-progression trigger). */
function hitAllReps(sets: LiftSet[]): boolean {
  return (
    sets.length >= LIFT_PROGRESSION.setCount &&
    sets.every(set => set.reps >= LIFT_PROGRESSION.repTarget)
  );
}

function isLowerBody(lift: string): boolean {
  const name = lift.toLowerCase();
  return LIFT_PROGRESSION.lowerBodyKeywords.some(keyword =>
    name.includes(keyword),
  );
}

interface ProgressionAssessment {
  /** 'add-weight' when the rep target was met on every set, else 'hold'. */
  recommendation: 'add-weight' | 'hold';
  reason: string;
  suggestedIncrement?: number;
  suggestedTopSetWeight?: number;
}

/**
 * Double-progression: if every set hit the rep target this session, suggest
 * a load increase (lower body gets the larger jump); otherwise hold the
 * weight and aim to beat the logbook on reps.
 */
function assessProgression(session: LiftSession): ProgressionAssessment {
  if (hitAllReps(session.sets)) {
    const increment = isLowerBody(session.lift)
      ? LIFT_PROGRESSION.lowerIncrement
      : LIFT_PROGRESSION.upperIncrement;
    return {
      recommendation: 'add-weight',
      reason: `All ${session.sets.length} sets hit ${LIFT_PROGRESSION.repTarget}+ reps — add weight next session.`,
      suggestedIncrement: increment,
      suggestedTopSetWeight: topSetWeight(session.sets) + increment,
    };
  }
  return {
    recommendation: 'hold',
    reason: `Not all sets reached ${LIFT_PROGRESSION.repTarget} reps — hold ${topSetWeight(session.sets)} and beat the logbook on reps next session.`,
  };
}

// `any` justified: the wrapper must be transparent to registerTool's
// per-overload callback inference; only the tool NAME is logged, never args.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function audited<F extends (...args: any[]) => any>(
  toolName: ToolName,
  handler: F,
): F {
  return ((...args: Parameters<F>) => {
    logger.info('audit', {event: AuditEvent.ToolInvoked, tool: toolName});
    return handler(...args);
  }) as F;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
  });

  server.registerTool(
    ToolName.GetUserProfile,
    {description: "Get the user's Garmin Connect profile information"},
    audited(ToolName.GetUserProfile, async () => {
      const gc = await getClient();
      const profile = await gc.getUserProfile();
      return formatResult(profile);
    }),
  );

  server.registerTool(
    ToolName.GetUserSettings,
    {
      description:
        "Get the user's Garmin Connect settings (units, display preferences, etc.)",
    },
    audited(ToolName.GetUserSettings, async () => {
      const gc = await getClient();
      const settings = await gc.getUserSettings();
      return formatResult(settings);
    }),
  );

  server.registerTool(
    ToolName.GetActivities,
    {
      description: 'Get a list of recent activities (runs, rides, swims, etc.)',
      inputSchema: {
        start: z
          .number()
          .optional()
          .describe('Start index for pagination (default 0)'),
        limit: z
          .number()
          .optional()
          .describe('Number of activities to return (default 20)'),
        activityType: z
          .string()
          .optional()
          .describe(
            "Filter by activity type (e.g. 'running', 'cycling', 'swimming')",
          ),
      },
    },
    audited(ToolName.GetActivities, async ({start, limit, activityType}) => {
      const gc = await getClient();
      // garmin-connect types the filter as its internal ActivitySubType enum;
      // we accept the equivalent string values.
      const typeFilter = activityType as Parameters<typeof gc.getActivities>[2];
      const activities = await gc.getActivities(
        start ?? 0,
        limit ?? 20,
        typeFilter,
      );
      return formatResult(activities);
    }),
  );

  server.registerTool(
    ToolName.GetActivityDetails,
    {
      description: 'Get detailed information about a specific activity',
      inputSchema: {
        activityId: z.number().describe('The activity ID'),
      },
    },
    audited(ToolName.GetActivityDetails, async ({activityId}) => {
      const gc = await getClient();
      const activity = await gc.getActivity({activityId});
      return formatResult(activity);
    }),
  );

  server.registerTool(
    ToolName.CountActivities,
    {description: 'Get a count of all activities by type'},
    audited(ToolName.CountActivities, async () => {
      const gc = await getClient();
      const counts = await gc.countActivities();
      return formatResult(counts);
    }),
  );

  server.registerTool(
    ToolName.GetSteps,
    {
      description: 'Get step count for a specific date',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
      },
    },
    audited(ToolName.GetSteps, async ({date}) => {
      const gc = await getClient();
      const steps = await gc.getSteps(parseDate(date));
      return formatResult({date: date ?? 'today', steps});
    }),
  );

  server.registerTool(
    ToolName.GetHeartRate,
    {
      description: 'Get heart rate data for a specific date',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
      },
    },
    audited(ToolName.GetHeartRate, async ({date}) => {
      const gc = await getClient();
      const hr = await gc.getHeartRate(parseDate(date));
      return formatResult(hr);
    }),
  );

  server.registerTool(
    ToolName.GetSleepData,
    {
      description: 'Get detailed sleep data for a specific date',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: last night)'),
      },
    },
    audited(ToolName.GetSleepData, async ({date}) => {
      const gc = await getClient();
      const sleep = await gc.getSleepData(parseDate(date));
      return formatResult(sleep);
    }),
  );

  server.registerTool(
    ToolName.GetSleepDuration,
    {
      description: 'Get sleep duration (hours and minutes) for a specific date',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: last night)'),
      },
    },
    audited(ToolName.GetSleepDuration, async ({date}) => {
      const gc = await getClient();
      const duration = await gc.getSleepDuration(parseDate(date));
      return formatResult({date: date ?? 'last night', ...duration});
    }),
  );

  server.registerTool(
    ToolName.GetDailyWeight,
    {
      description: 'Get weight data for a specific date',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
      },
    },
    audited(ToolName.GetDailyWeight, async ({date}) => {
      const gc = await getClient();
      const weight = await gc.getDailyWeightData(parseDate(date));
      return formatResult(weight);
    }),
  );

  server.registerTool(
    ToolName.GetDailyHydration,
    {
      description: 'Get hydration intake for a specific date (in ounces)',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
      },
    },
    audited(ToolName.GetDailyHydration, async ({date}) => {
      const gc = await getClient();
      const hydration = await gc.getDailyHydration(parseDate(date));
      return formatResult({date: date ?? 'today', hydrationOz: hydration});
    }),
  );

  server.registerTool(
    ToolName.GetWorkouts,
    {
      description: 'Get saved workouts from Garmin Connect',
      inputSchema: {
        start: z.number().optional().describe('Start index (default 0)'),
        limit: z
          .number()
          .optional()
          .describe('Number of workouts to return (default 20)'),
      },
    },
    audited(ToolName.GetWorkouts, async ({start, limit}) => {
      const gc = await getClient();
      const workouts = await gc.getWorkouts(start ?? 0, limit ?? 20);
      return formatResult(workouts);
    }),
  );

  server.registerTool(
    ToolName.GetGolfSummary,
    {description: 'Get golf round summary data'},
    audited(ToolName.GetGolfSummary, async () => {
      const gc = await getClient();
      const summary = await gc.getGolfSummary();
      return formatResult(summary);
    }),
  );

  server.registerTool(
    ToolName.GetDailySummary,
    {
      description:
        'Get the daily wellness summary: total, active, and resting (BMR) calories burned, calories consumed (synced from MyFitnessPal) with goal and remaining, steps, distance, intensity minutes, heart rate range, stress, Body Battery, and sleep seconds',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
      },
    },
    audited(ToolName.GetDailySummary, async ({date}) => {
      const gc = await getClient();
      const displayName = await getDisplayName();
      const calendarDate = date ?? toDateString(new Date());
      const url = `${GARMIN_API.base}${GARMIN_API.dailySummaryPath}${encodeURIComponent(displayName)}`;
      // No library wrapper exists for this endpoint; use its public get()
      // escape hatch and pick the stable fields.
      const summary = await gc.get<Record<string, unknown>>(url, {
        params: {calendarDate},
      });
      const picked: Record<string, unknown> = {};
      for (const field of DAILY_SUMMARY_FIELDS) {
        picked[field] = summary[field] ?? null;
      }
      return formatResult(picked);
    }),
  );

  server.registerTool(
    ToolName.GetSleep,
    {
      description:
        'Get a condensed sleep summary: duration, stage breakdown (deep/light/REM/awake), sleep score, overnight HRV, resting heart rate, and Body Battery change',
      inputSchema: {
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe(
            'Date the sleep ended, in YYYY-MM-DD format (default: last night)',
          ),
      },
    },
    audited(ToolName.GetSleep, async ({date}) => {
      const gc = await getClient();
      const sleep = await gc.getSleepData(parseDate(date));
      const dto = sleep?.dailySleepDTO;
      return formatResult({
        date: dto?.calendarDate ?? date ?? toDateString(new Date()),
        sleepTimeSeconds: dto?.sleepTimeSeconds ?? null,
        napTimeSeconds: dto?.napTimeSeconds ?? null,
        stages: {
          deepSleepSeconds: dto?.deepSleepSeconds ?? null,
          lightSleepSeconds: dto?.lightSleepSeconds ?? null,
          remSleepSeconds: dto?.remSleepSeconds ?? null,
          awakeSleepSeconds: dto?.awakeSleepSeconds ?? null,
        },
        overallSleepScore: dto?.sleepScores?.overall?.value ?? null,
        avgSleepStress: dto?.avgSleepStress ?? null,
        avgOvernightHrv: sleep?.avgOvernightHrv ?? null,
        hrvStatus: sleep?.hrvStatus ?? null,
        restingHeartRate: sleep?.restingHeartRate ?? null,
        bodyBatteryChange: sleep?.bodyBatteryChange ?? null,
      });
    }),
  );

  // --- Lift log (personal, user-written; stored in the separate lift DB) ---

  const setSchema = z.object({
    weight: z.number().describe('Load for the set (in your logged unit)'),
    reps: z.number().int().describe('Reps completed'),
  });

  server.registerTool(
    ToolName.LogLift,
    {
      description:
        'Log a completed lifting session and get a double-progression assessment (add weight when all sets hit the rep target, otherwise hold and beat the logbook)',
      inputSchema: {
        lift: z.string().describe("Lift name, e.g. 'bench press', 'squat'"),
        sets: z
          .array(setSchema)
          .min(1)
          .describe('Working sets, each {weight, reps}'),
        date: z
          .string()
          .regex(DATE_REGEX)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today)'),
        note: z.string().optional().describe('Optional free-text note'),
      },
    },
    audited(ToolName.LogLift, async ({lift, sets, date, note}) => {
      const store = getLiftStore();
      const saved = store.insertSession({
        date: date ?? toDateString(new Date()),
        lift,
        sets,
        note,
      });
      const prior = store.priorSession(lift, saved.id);
      return formatResult({
        saved: {
          ...saved,
          topSetWeight: topSetWeight(saved.sets),
          totalReps: totalReps(saved.sets),
        },
        previousSession:
          prior === undefined
            ? null
            : {
                date: prior.date,
                topSetWeight: topSetWeight(prior.sets),
                totalReps: totalReps(prior.sets),
              },
        assessment: assessProgression(saved),
      });
    }),
  );

  server.registerTool(
    ToolName.GetLiftHistory,
    {
      description:
        'Get logged lift sessions newest-first, with each session top-set weight and total reps',
      inputSchema: {
        lift: z
          .string()
          .optional()
          .describe('Filter by lift name (default: all lifts)'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Number of sessions to return (default 20)'),
      },
    },
    audited(ToolName.GetLiftHistory, async ({lift, limit}) => {
      const store = getLiftStore();
      const sessions = store.listSessions(lift, limit ?? 20);
      return formatResult({
        count: sessions.length,
        sessions: sessions.map(session => ({
          ...session,
          topSetWeight: topSetWeight(session.sets),
          totalReps: totalReps(session.sets),
        })),
      });
    }),
  );

  server.registerTool(
    ToolName.GetLiftProgress,
    {
      description:
        'Get the weight progression for one lift over time (date, top-set weight, reps), plus the current working weight and whether you are due to add weight',
      inputSchema: {
        lift: z.string().describe('Lift name to chart progression for'),
      },
    },
    audited(ToolName.GetLiftProgress, async ({lift}) => {
      const store = getLiftStore();
      // Pull the full history for this lift (newest-first), then chart it
      // oldest-first for a trend view.
      const sessions = store.listSessions(lift, Number.MAX_SAFE_INTEGER);
      if (sessions.length === 0) {
        return formatResult({
          lift,
          sessionCount: 0,
          progression: [],
          currentWorkingWeight: null,
          dueToAddWeight: false,
          message: `No sessions logged for "${lift}".`,
        });
      }
      const progression = sessions
        .slice()
        .reverse()
        .map(session => ({
          date: session.date,
          topSetWeight: topSetWeight(session.sets),
          totalReps: totalReps(session.sets),
        }));
      const latest = sessions[0];
      const assessment = assessProgression(latest);
      return formatResult({
        lift,
        sessionCount: sessions.length,
        progression,
        currentWorkingWeight: topSetWeight(latest.sets),
        dueToAddWeight: assessment.recommendation === 'add-weight',
        assessment,
      });
    }),
  );

  return server;
}
