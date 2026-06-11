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
} as const;

/** Name of the OS credential-store service entry holding Garmin credentials. */
export const CREDENTIAL_SERVICE = 'garmin-connect-mcp';

/** Directory (under the user's home) where Garmin OAuth tokens are cached. */
export const TOKEN_DIR_NAME = '.garmin-mcp-tokens';
