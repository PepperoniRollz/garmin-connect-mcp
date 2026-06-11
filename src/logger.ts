/**
 * Minimal leveled logger. Always writes to stderr: stdout is the MCP
 * transport channel in stdio mode and must stay clean.
 */
import {EnvVar} from './constants.js';

export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LogLevel.Debug]: 10,
  [LogLevel.Info]: 20,
  [LogLevel.Warn]: 30,
  [LogLevel.Error]: 40,
};

function isLogLevel(value: string): value is LogLevel {
  return Object.values(LogLevel).includes(value as LogLevel);
}

function configuredLevel(): LogLevel {
  const raw = process.env[EnvVar.LogLevel]?.toLowerCase();
  return raw !== undefined && isLogLevel(raw) ? raw : LogLevel.Info;
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) {
    return;
  }
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write(LogLevel.Debug, message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write(LogLevel.Info, message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write(LogLevel.Warn, message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write(LogLevel.Error, message, fields),
};
