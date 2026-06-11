/**
 * Transport-agnostic MCP server factory: registers every Garmin tool on a
 * fresh McpServer instance. Entry points wire the returned server to a
 * concrete transport.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

import {AuditEvent, SERVER_INFO, ToolName} from './constants.js';
import {getClient} from './garminClient.js';
import {logger} from './logger.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  // Append time to avoid UTC midnight parsing (which shifts the date in western timezones)
  return new Date(dateStr + 'T00:00:00');
}

function formatResult(data: unknown): {
  content: {type: 'text'; text: string}[];
} {
  return {
    content: [{type: 'text' as const, text: JSON.stringify(data, null, 2)}],
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

  return server;
}
