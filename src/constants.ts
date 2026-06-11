/**
 * Central constants module. No magic strings/numbers elsewhere: every env var
 * name, header, route, transport name, and default value lives here.
 */

/** Environment variable names recognized by the server. */
export enum EnvVar {
  GarminUsername = 'GARMIN_USERNAME',
  GarminPassword = 'GARMIN_PASSWORD',
  Port = 'PORT',
  TransportMode = 'TRANSPORT_MODE',
  TokenCacheDir = 'TOKEN_CACHE_DIR',
  LogLevel = 'LOG_LEVEL',
  PublicUrl = 'GARMIN_MCP_PUBLIC_URL',
  ServerOwnerPasswordHash = 'SERVER_OWNER_PASSWORD_HASH',
  AuthDbPath = 'AUTH_DB_PATH',
  TrustedProxy = 'TRUSTED_PROXY',
  BindHost = 'BIND_HOST',
}

/** Supported transport modes for the server process. */
export enum TransportMode {
  Stdio = 'stdio',
  Http = 'http',
}

/** CLI flags recognized by the entry dispatcher. */
export enum CliFlag {
  Transport = '--transport',
}

/** HTTP route paths served in HTTP mode. */
export enum RoutePath {
  Mcp = '/mcp',
  Healthz = '/healthz',
}

/** HTTP header names used by the Streamable HTTP transport. */
export enum HeaderName {
  McpSessionId = 'mcp-session-id',
}

/** JSON-RPC error codes used in transport-level error responses. */
export enum JsonRpcErrorCode {
  InvalidRequest = -32600,
  SessionNotFound = -32001,
}

export const JSON_RPC_VERSION = '2.0' as const;

/** Server identity reported during MCP initialization. */
export const SERVER_INFO = {
  name: 'garmin-connect',
  version: '1.0.0',
} as const;

/** Defaults applied when optional configuration is absent. */
export const DEFAULTS = {
  /** Port the HTTP server listens on. */
  port: 8080,
  /** HTTP mode binds to loopback only; TLS termination is the proxy's job. */
  host: '127.0.0.1',
  transportMode: TransportMode.Stdio,
  /**
   * Express trust-proxy setting. 'loopback' suits a host-level reverse
   * proxy or local dev; in Docker, set TRUSTED_PROXY to the bridge
   * gateway IP so client IPs in audit logs and rate limiting are real.
   */
  trustedProxy: 'loopback',
} as const;

/** Name of the OS credential-store service entry holding Garmin credentials. */
export const CREDENTIAL_SERVICE = 'garmin-connect-mcp';

/** Directory (under the user's home) where Garmin OAuth tokens are cached. */
export const TOKEN_DIR_NAME = '.garmin-mcp-tokens';

/** Default file name (under the user's home) for the auth/token database. */
export const AUTH_DB_FILE_NAME = '.garmin-mcp-auth.db';

/** Names of every MCP tool exposed by this server. */
export enum ToolName {
  GetUserProfile = 'get-user-profile',
  GetUserSettings = 'get-user-settings',
  GetActivities = 'get-activities',
  GetActivityDetails = 'get-activity-details',
  CountActivities = 'count-activities',
  GetSteps = 'get-steps',
  GetHeartRate = 'get-heart-rate',
  GetSleepData = 'get-sleep-data',
  GetSleepDuration = 'get-sleep-duration',
  GetDailyWeight = 'get-daily-weight',
  GetDailyHydration = 'get-daily-hydration',
  GetWorkouts = 'get-workouts',
  GetGolfSummary = 'get-golf-summary',
  GetDailySummary = 'get-daily-summary',
  GetSleep = 'get-sleep',
}

/**
 * Garmin Connect API endpoints called via the library's public get()
 * escape hatch (no dedicated wrapper method exists for these).
 */
export const GARMIN_API = {
  base: 'https://connectapi.garmin.com',
  dailySummaryPath: '/usersummary-service/usersummary/daily/',
} as const;

/** Routes served by the built-in OAuth login flow (outside the SDK router). */
export enum AuthRoutePath {
  Login = '/oauth/login',
}

/** Audit event names, logged via the structured logger (tool name only — never payloads). */
export enum AuditEvent {
  LoginSuccess = 'auth.login_success',
  LoginFailure = 'auth.login_failure',
  ClientRegistered = 'auth.client_registered',
  ClientRegistrationRejected = 'auth.client_registration_rejected',
  TokenIssued = 'auth.token_issued',
  TokenRefreshed = 'auth.token_refreshed',
  TokenRevoked = 'auth.token_revoked',
  McpUnauthorized = 'auth.mcp_unauthorized',
  ToolInvoked = 'tool.invoked',
}

/**
 * OAuth 2.1 parameters. Access tokens are short-lived; refresh tokens are
 * rotated on use. Authorization codes and pending logins are single-use and
 * expire quickly.
 */
export const OAUTH = {
  accessTokenTtlSeconds: 60 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  authorizationCodeTtlSeconds: 10 * 60,
  pendingAuthorizationTtlSeconds: 10 * 60,
  scopesSupported: ['garmin:read'],
  /** bcrypt hashes start with $2a$/$2b$/$2y$ followed by the cost factor. */
  bcryptHashPattern: /^\$2[aby]\$\d{2}\$/,
  bcryptCost: 12,
  /** Random bytes per opaque token/code (hex-encoded on the wire). */
  tokenByteLength: 32,
} as const;

/**
 * MCP session reaping, designed together with token lifetimes: every request
 * re-validates the bearer token (1h TTL), and sessions idle for longer than
 * this timeout are closed so abandoned transports don't accumulate.
 */
export const SESSION_SWEEP = {
  idleTimeoutMs: 30 * 60 * 1000,
  sweepIntervalMs: 5 * 60 * 1000,
} as const;

/** Per-IP rate limits (the SDK applies its own defaults on auth endpoints). */
export const RATE_LIMIT = {
  mcp: {windowMs: 60 * 1000, limit: 120},
  login: {windowMs: 15 * 60 * 1000, limit: 10},
} as const;

/**
 * Redirect URI allowlist: claude.ai/claude.com callbacks exactly, plus
 * RFC 8252 loopback redirects for local clients (Claude Code uses
 * /callback, MCP Inspector uses /oauth/callback). Per RFC 8252 §7.3 the
 * port is variable; loopback redirects only ever reach the user's own
 * machine, so the path is not pinned — the registered URI still must match
 * exactly at authorization time.
 */
export const ALLOWED_REDIRECTS = {
  exact: [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ],
  loopbackProtocol: 'http:',
  loopbackHosts: ['localhost', '127.0.0.1'],
} as const;
