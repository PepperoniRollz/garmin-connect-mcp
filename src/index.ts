import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// CJS interop: garmin-connect doesn't export ESM named exports
import pkg from "garmin-connect";
const { GarminConnect } = pkg;
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const TOKEN_DIR = path.join(os.homedir(), ".garmin-mcp-tokens");
const KEYCHAIN_SERVICE = "garmin-connect-mcp";

async function getKeychainValue(account: string): Promise<string> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", account,
    "-w",
  ]);
  return stdout.trim();
}

async function getCredentials(): Promise<{ username: string; password: string }> {
  // Prefer env vars if set (for CI or manual override)
  if (process.env.GARMIN_USERNAME && process.env.GARMIN_PASSWORD) {
    return {
      username: process.env.GARMIN_USERNAME,
      password: process.env.GARMIN_PASSWORD,
    };
  }

  // Otherwise read from macOS Keychain
  try {
    const [username, password] = await Promise.all([
      getKeychainValue("username"),
      getKeychainValue("password"),
    ]);
    return { username, password };
  } catch {
    throw new Error(
      "Garmin credentials not found. Store them in macOS Keychain:\n" +
      `  security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "username" -w "your-email"\n` +
      `  security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "password" -w "your-password"`
    );
  }
}

let clientPromise: Promise<InstanceType<typeof GarminConnect>> | null = null;

function getClient(): Promise<InstanceType<typeof GarminConnect>> {
  if (!clientPromise) {
    clientPromise = initClient().catch((err) => {
      clientPromise = null; // allow retry on failure
      throw err;
    });
  }
  return clientPromise;
}

async function initClient(): Promise<InstanceType<typeof GarminConnect>> {
  const { username, password } = await getCredentials();
  const gc = new GarminConnect({ username, password });

  // Try loading saved tokens first
  try {
    gc.loadTokenByFile(TOKEN_DIR);
    await gc.getUserProfile();
  } catch {
    // Token expired or missing, do a fresh login
    await gc.login();
    gc.exportTokenToFile(TOKEN_DIR);
  }

  return gc;
}

function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  // Append time to avoid UTC midnight parsing (which shifts the date in western timezones)
  return new Date(dateStr + "T00:00:00");
}

function formatResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// --- Server setup ---

const server = new McpServer({
  name: "garmin-connect",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "get-user-profile",
  "Get the user's Garmin Connect profile information",
  {},
  async () => {
    const gc = await getClient();
    const profile = await gc.getUserProfile();
    return formatResult(profile);
  }
);

server.tool(
  "get-user-settings",
  "Get the user's Garmin Connect settings (units, display preferences, etc.)",
  {},
  async () => {
    const gc = await getClient();
    const settings = await gc.getUserSettings();
    return formatResult(settings);
  }
);

server.tool(
  "get-activities",
  "Get a list of recent activities (runs, rides, swims, etc.)",
  {
    start: z.number().optional().describe("Start index for pagination (default 0)"),
    limit: z.number().optional().describe("Number of activities to return (default 20)"),
    activityType: z.string().optional().describe("Filter by activity type (e.g. 'running', 'cycling', 'swimming')"),
  },
  async ({ start, limit, activityType }) => {
    const gc = await getClient();
    const activities = await gc.getActivities(start ?? 0, limit ?? 20, activityType as any);
    return formatResult(activities);
  }
);

server.tool(
  "get-activity-details",
  "Get detailed information about a specific activity",
  {
    activityId: z.number().describe("The activity ID"),
  },
  async ({ activityId }) => {
    const gc = await getClient();
    const activity = await gc.getActivity({ activityId });
    return formatResult(activity);
  }
);

server.tool(
  "count-activities",
  "Get a count of all activities by type",
  {},
  async () => {
    const gc = await getClient();
    const counts = await gc.countActivities();
    return formatResult(counts);
  }
);

server.tool(
  "get-steps",
  "Get step count for a specific date",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const steps = await gc.getSteps(parseDate(date));
    return formatResult({ date: date ?? "today", steps });
  }
);

server.tool(
  "get-heart-rate",
  "Get heart rate data for a specific date",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const hr = await gc.getHeartRate(parseDate(date));
    return formatResult(hr);
  }
);

server.tool(
  "get-sleep-data",
  "Get detailed sleep data for a specific date",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: last night)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const sleep = await gc.getSleepData(parseDate(date));
    return formatResult(sleep);
  }
);

server.tool(
  "get-sleep-duration",
  "Get sleep duration (hours and minutes) for a specific date",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: last night)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const duration = await gc.getSleepDuration(parseDate(date));
    return formatResult({ date: date ?? "last night", ...duration });
  }
);

server.tool(
  "get-daily-weight",
  "Get weight data for a specific date",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const weight = await gc.getDailyWeightData(parseDate(date));
    return formatResult(weight);
  }
);

server.tool(
  "get-daily-hydration",
  "Get hydration intake for a specific date (in ounces)",
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  async ({ date }) => {
    const gc = await getClient();
    const hydration = await gc.getDailyHydration(parseDate(date));
    return formatResult({ date: date ?? "today", hydrationOz: hydration });
  }
);

server.tool(
  "get-workouts",
  "Get saved workouts from Garmin Connect",
  {
    start: z.number().optional().describe("Start index (default 0)"),
    limit: z.number().optional().describe("Number of workouts to return (default 20)"),
  },
  async ({ start, limit }) => {
    const gc = await getClient();
    const workouts = await gc.getWorkouts(start ?? 0, limit ?? 20);
    return formatResult(workouts);
  }
);

server.tool(
  "get-golf-summary",
  "Get golf round summary data",
  {},
  async () => {
    const gc = await getClient();
    const summary = await gc.getGolfSummary();
    return formatResult(summary);
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
