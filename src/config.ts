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

import {CliFlag, DEFAULTS, EnvVar, TOKEN_DIR_NAME, TransportMode} from './constants.js';
import {LogLevel} from './logger.js';

export interface AppConfig {
  transportMode: TransportMode;
  /** Port the HTTP server listens on (HTTP mode only). */
  port: number;
  /** Directory where the Garmin OAuth token cache is persisted. */
  tokenCacheDir: string;
}

/** Thrown when configuration is invalid; carries one entry per problem. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const transportModeSchema = z.enum(TransportMode);
const portSchema = z.coerce.number().int().min(1).max(65535);
const logLevelSchema = z.enum(LogLevel);
const nonEmptyStringSchema = z.string().min(1);

type Env = Record<string, string | undefined>;

function resolveTransportMode(env: Env, argv: readonly string[], issues: string[]): TransportMode {
  const flagIndex = argv.indexOf(CliFlag.Transport);
  const fromFlag = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  const source = fromFlag !== undefined ? CliFlag.Transport : EnvVar.TransportMode;
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
    issues.push(`${EnvVar.Port}: invalid value "${raw}" (must be an integer between 1 and 65535)`);
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
      issues.push(`${name}: required in http mode (env vars are the canonical credential source for remote deployments)`);
    }
  }
}

/**
 * Parses configuration from the environment and CLI flags.
 *
 * @throws ConfigError listing every missing or invalid variable.
 */
export function loadConfig(env: Env = process.env, argv: readonly string[] = process.argv): AppConfig {
  const issues: string[] = [];

  const transportMode = resolveTransportMode(env, argv, issues);
  const port = resolvePort(env, issues);
  const tokenCacheDir = resolveTokenCacheDir(env, issues);
  checkLogLevel(env, issues);
  if (transportMode === TransportMode.Http) {
    checkHttpCredentials(env, issues);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {transportMode, port, tokenCacheDir};
}
