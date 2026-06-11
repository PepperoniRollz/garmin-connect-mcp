/**
 * Entry dispatcher: selects the transport mode from the --transport CLI flag
 * or the TRANSPORT_MODE env var. Defaults to stdio so existing Claude Code
 * configurations keep working unchanged.
 */
import {CliFlag, DEFAULTS, EnvVar, TransportMode} from './constants.js';
import {runHttp} from './entry/http.js';
import {runStdio} from './entry/stdio.js';
import {logger} from './logger.js';

function isTransportMode(value: string): value is TransportMode {
  return Object.values(TransportMode).includes(value as TransportMode);
}

function resolveTransportMode(): TransportMode {
  const flagIndex = process.argv.indexOf(CliFlag.Transport);
  const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  const raw = fromFlag ?? process.env[EnvVar.TransportMode];
  if (raw === undefined) return DEFAULTS.transportMode;
  if (!isTransportMode(raw)) {
    const valid = Object.values(TransportMode).join(', ');
    throw new Error(`Invalid transport mode "${raw}". Valid modes: ${valid}`);
  }
  return raw;
}

const mode = resolveTransportMode();
if (mode === TransportMode.Http) {
  await runHttp();
} else {
  await runStdio();
}
logger.debug('server started', {mode});
