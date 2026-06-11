/**
 * Centralized configuration: parses and validates everything the server
 * reads from the environment (plus the --transport CLI flag) in one place.
 *
 * Validation is fail-fast and exhaustive: every missing or invalid variable
 * is collected and reported together, not just the first one found.
 */
import os from 'os';
import path from 'path';

import {z} from 'zod';

import {
  AUTH_DB_FILE_NAME,
  CliFlag,
  DEFAULTS,
  EnvVar,
  OAUTH,
  RoutePath,
  TOKEN_DIR_NAME,
  TransportMode,
} from './constants.js';
import {LogLevel} from './logger.js';

/** Settings that only exist in HTTP (remote connector) mode. */
export interface HttpConfig {
  /** Full public URL of the MCP endpoint; OAuth `resource` equals this exactly. */
  publicUrl: URL;
  /** bcrypt hash of the server owner's login password. */
  serverOwnerPasswordHash: string;
  /** SQLite file persisting OAuth clients, codes, and tokens. */
  authDbPath: string;
  /**
   * Express trust-proxy setting: 'loopback', an IP, a CIDR, or a
   * comma-separated list of those.
   */
  trustedProxy: string | string[];
  /**
   * Interface the HTTP server binds to. Loopback by default; inside a
   * container set 0.0.0.0 (the port publish controls outside exposure).
   */
  bindHost: string;
}

export interface AppConfig {
  transportMode: TransportMode;
  /** Port the HTTP server listens on (HTTP mode only). */
  port: number;
  /** Directory where the Garmin OAuth token cache is persisted. */
  tokenCacheDir: string;
  /** Present only when transportMode is http. */
  http?: HttpConfig;
}

/** Thrown when configuration is invalid; carries one entry per problem. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map(issue => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

const transportModeSchema = z.enum(TransportMode);
const portSchema = z.coerce.number().int().min(1).max(65535);
const logLevelSchema = z.enum(LogLevel);
const nonEmptyStringSchema = z.string().min(1);

type Env = Record<string, string | undefined>;

function resolveTransportMode(
  env: Env,
  argv: readonly string[],
  issues: string[],
): TransportMode {
  const flagIndex = argv.indexOf(CliFlag.Transport);
  const fromFlag = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  const source =
    fromFlag !== undefined ? CliFlag.Transport : EnvVar.TransportMode;
  const raw = fromFlag ?? env[EnvVar.TransportMode];
  if (raw === undefined) return DEFAULTS.transportMode;

  const parsed = transportModeSchema.safeParse(raw);
  if (!parsed.success) {
    const valid = Object.values(TransportMode).join(', ');
    issues.push(`${source}: invalid value "${raw}" (valid: ${valid})`);
    return DEFAULTS.transportMode;
  }
  return parsed.data;
}

function resolvePort(env: Env, issues: string[]): number {
  const raw = env[EnvVar.Port];
  if (raw === undefined) return DEFAULTS.port;

  const parsed = portSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(
      `${EnvVar.Port}: invalid value "${raw}" (must be an integer between 1 and 65535)`,
    );
    return DEFAULTS.port;
  }
  return parsed.data;
}

function resolveTokenCacheDir(env: Env, issues: string[]): string {
  const raw = env[EnvVar.TokenCacheDir];
  if (raw === undefined) return path.join(os.homedir(), TOKEN_DIR_NAME);

  const parsed = nonEmptyStringSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(`${EnvVar.TokenCacheDir}: must not be empty when set`);
    return path.join(os.homedir(), TOKEN_DIR_NAME);
  }
  return path.resolve(parsed.data);
}

function checkLogLevel(env: Env, issues: string[]): void {
  const raw = env[EnvVar.LogLevel];
  if (raw === undefined) return;

  const parsed = logLevelSchema.safeParse(raw.toLowerCase());
  if (!parsed.success) {
    const valid = Object.values(LogLevel).join(', ');
    issues.push(`${EnvVar.LogLevel}: invalid value "${raw}" (valid: ${valid})`);
  }
}

function checkHttpCredentials(env: Env, issues: string[]): void {
  for (const name of [EnvVar.GarminUsername, EnvVar.GarminPassword]) {
    const parsed = nonEmptyStringSchema.safeParse(env[name]);
    if (!parsed.success) {
      issues.push(
        `${name}: required in http mode (env vars are the canonical credential source for remote deployments)`,
      );
    }
  }
}

function resolvePublicUrl(env: Env, issues: string[]): URL | undefined {
  const raw = env[EnvVar.PublicUrl];
  if (raw === undefined || raw === '') {
    issues.push(
      `${EnvVar.PublicUrl}: required in http mode (full public MCP endpoint URL, e.g. https://garmin-mcp.example.com${RoutePath.Mcp})`,
    );
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push(`${EnvVar.PublicUrl}: invalid URL "${raw}"`);
    return undefined;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    issues.push(`${EnvVar.PublicUrl}: must be http(s), got "${url.protocol}"`);
    return undefined;
  }
  if (url.pathname !== RoutePath.Mcp || url.search !== '' || url.hash !== '') {
    issues.push(
      `${EnvVar.PublicUrl}: path must be exactly "${RoutePath.Mcp}" with no query or fragment (the OAuth resource identifier must match the MCP endpoint URL exactly), got "${raw}"`,
    );
    return undefined;
  }
  return url;
}

function resolveOwnerPasswordHash(
  env: Env,
  issues: string[],
): string | undefined {
  const raw = env[EnvVar.ServerOwnerPasswordHash];
  if (raw === undefined || raw === '') {
    issues.push(
      `${EnvVar.ServerOwnerPasswordHash}: required in http mode (generate with: npm run hash-password)`,
    );
    return undefined;
  }
  if (!OAUTH.bcryptHashPattern.test(raw)) {
    issues.push(
      `${EnvVar.ServerOwnerPasswordHash}: not a bcrypt hash (expected $2a$/$2b$/$2y$ prefix; generate with: npm run hash-password)`,
    );
    return undefined;
  }
  return raw;
}

function resolveAuthDbPath(env: Env, issues: string[]): string {
  const raw = env[EnvVar.AuthDbPath];
  if (raw === undefined) return path.join(os.homedir(), AUTH_DB_FILE_NAME);

  const parsed = nonEmptyStringSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(`${EnvVar.AuthDbPath}: must not be empty when set`);
    return path.join(os.homedir(), AUTH_DB_FILE_NAME);
  }
  return path.resolve(parsed.data);
}

function resolveTrustedProxy(env: Env, issues: string[]): string | string[] {
  const raw = env[EnvVar.TrustedProxy];
  if (raw === undefined) return DEFAULTS.trustedProxy;

  const parsed = nonEmptyStringSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(`${EnvVar.TrustedProxy}: must not be empty when set`);
    return DEFAULTS.trustedProxy;
  }
  const values = parsed.data
    .split(',')
    .map(value => value.trim())
    .filter(value => value !== '');
  return values.length === 1 ? values[0] : values;
}

function resolveBindHost(env: Env, issues: string[]): string {
  const raw = env[EnvVar.BindHost];
  if (raw === undefined) return DEFAULTS.host;

  const parsed = nonEmptyStringSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(`${EnvVar.BindHost}: must not be empty when set`);
    return DEFAULTS.host;
  }
  return parsed.data;
}

function resolveHttpConfig(env: Env, issues: string[]): HttpConfig | undefined {
  checkHttpCredentials(env, issues);
  const publicUrl = resolvePublicUrl(env, issues);
  const serverOwnerPasswordHash = resolveOwnerPasswordHash(env, issues);
  const authDbPath = resolveAuthDbPath(env, issues);
  const trustedProxy = resolveTrustedProxy(env, issues);
  const bindHost = resolveBindHost(env, issues);
  if (publicUrl === undefined || serverOwnerPasswordHash === undefined)
    return undefined;
  return {
    publicUrl,
    serverOwnerPasswordHash,
    authDbPath,
    trustedProxy,
    bindHost,
  };
}

/**
 * Parses configuration from the environment and CLI flags.
 *
 * @throws ConfigError listing every missing or invalid variable.
 */
export function loadConfig(
  env: Env = process.env,
  argv: readonly string[] = process.argv,
): AppConfig {
  const issues: string[] = [];

  const transportMode = resolveTransportMode(env, argv, issues);
  const port = resolvePort(env, issues);
  const tokenCacheDir = resolveTokenCacheDir(env, issues);
  checkLogLevel(env, issues);
  const http =
    transportMode === TransportMode.Http
      ? resolveHttpConfig(env, issues)
      : undefined;

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {transportMode, port, tokenCacheDir, http};
}
