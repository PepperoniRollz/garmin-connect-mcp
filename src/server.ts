/**
 * Transport-agnostic MCP server factory: registers every Garmin tool on a
 * fresh McpServer instance. Entry points wire the returned server to a
 * concrete transport.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

import {SERVER_INFO} from './constants.js';
import {getClient} from './garminClient.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  // Append time to avoid UTC midnight parsing (which shifts the date in western timezones)
  return new Date(dateStr + 'T00:00:00');
}

function formatResult(data: unknown): {content: {type: 'text'; text: string}[]} {
  return {
    content: [{type: 'text' as const, text: JSON.stringify(data, null, 2)}],
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
  });

  server.registerTool(
      'get-user-profile',
      {description: 'Get the user\'s Garmin Connect profile information'},
      async () => {
        const gc = await getClient();
        const profile = await gc.getUserProfile();
        return formatResult(profile);
      },
  );

  server.registerTool(
      'get-user-settings',
      {description: 'Get the user\'s Garmin Connect settings (units, display preferences, etc.)'},
      async () => {
        const gc = await getClient();
        const settings = await gc.getUserSettings();
        return formatResult(settings);
      },
  );

  server.registerTool(
      'get-activities',
      {
        description: 'Get a list of recent activities (runs, rides, swims, etc.)',
        inputSchema: {
          start: z.number().optional().describe('Start index for pagination (default 0)'),
          limit: z.number().optional().describe('Number of activities to return (default 20)'),
          activityType: z.string().optional().describe('Filter by activity type (e.g. \'running\', \'cycling\', \'swimming\')'),
        },
      },
      async ({start, limit, activityType}) => {
        const gc = await getClient();
        // garmin-connect types the filter as its internal ActivitySubType enum;
        // we accept the equivalent string values.
        const typeFilter = activityType as Parameters<typeof gc.getActivities>[2];
        const activities = await gc.getActivities(start ?? 0, limit ?? 20, typeFilter);
        return formatResult(activities);
      },
  );

  server.registerTool(
      'get-activity-details',
      {
        description: 'Get detailed information about a specific activity',
        inputSchema: {
          activityId: z.number().describe('The activity ID'),
        },
      },
      async ({activityId}) => {
        const gc = await getClient();
        const activity = await gc.getActivity({activityId});
        return formatResult(activity);
      },
  );

  server.registerTool(
      'count-activities',
      {description: 'Get a count of all activities by type'},
      async () => {
        const gc = await getClient();
        const counts = await gc.countActivities();
        return formatResult(counts);
      },
  );

  server.registerTool(
      'get-steps',
      {
        description: 'Get step count for a specific date',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: today)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const steps = await gc.getSteps(parseDate(date));
        return formatResult({date: date ?? 'today', steps});
      },
  );

  server.registerTool(
      'get-heart-rate',
      {
        description: 'Get heart rate data for a specific date',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: today)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const hr = await gc.getHeartRate(parseDate(date));
        return formatResult(hr);
      },
  );

  server.registerTool(
      'get-sleep-data',
      {
        description: 'Get detailed sleep data for a specific date',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: last night)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const sleep = await gc.getSleepData(parseDate(date));
        return formatResult(sleep);
      },
  );

  server.registerTool(
      'get-sleep-duration',
      {
        description: 'Get sleep duration (hours and minutes) for a specific date',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: last night)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const duration = await gc.getSleepDuration(parseDate(date));
        return formatResult({date: date ?? 'last night', ...duration});
      },
  );

  server.registerTool(
      'get-daily-weight',
      {
        description: 'Get weight data for a specific date',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: today)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const weight = await gc.getDailyWeightData(parseDate(date));
        return formatResult(weight);
      },
  );

  server.registerTool(
      'get-daily-hydration',
      {
        description: 'Get hydration intake for a specific date (in ounces)',
        inputSchema: {
          date: z.string().regex(DATE_REGEX).optional().describe('Date in YYYY-MM-DD format (default: today)'),
        },
      },
      async ({date}) => {
        const gc = await getClient();
        const hydration = await gc.getDailyHydration(parseDate(date));
        return formatResult({date: date ?? 'today', hydrationOz: hydration});
      },
  );

  server.registerTool(
      'get-workouts',
      {
        description: 'Get saved workouts from Garmin Connect',
        inputSchema: {
          start: z.number().optional().describe('Start index (default 0)'),
          limit: z.number().optional().describe('Number of workouts to return (default 20)'),
        },
      },
      async ({start, limit}) => {
        const gc = await getClient();
        const workouts = await gc.getWorkouts(start ?? 0, limit ?? 20);
        return formatResult(workouts);
      },
  );

  server.registerTool(
      'get-golf-summary',
      {description: 'Get golf round summary data'},
      async () => {
        const gc = await getClient();
        const summary = await gc.getGolfSummary();
        return formatResult(summary);
      },
  );

  return server;
}
