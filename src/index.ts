/**
 * Entry dispatcher: loads and validates configuration, then starts the
 * server in the configured transport mode. Defaults to stdio so existing
 * Claude Code configurations keep working unchanged.
 */
import {AppConfig, ConfigError, loadConfig} from './config.js';
import {TransportMode} from './constants.js';
import {runHttp} from './entry/http.js';
import {runStdio} from './entry/stdio.js';
import {logger} from './logger.js';

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    logger.error('invalid configuration; fix the following and restart', {issues: err.issues});
    process.exit(1);
  }
  throw err;
}

if (config.transportMode === TransportMode.Http) {
  await runHttp(config);
} else {
  await runStdio(config);
}
logger.debug('server started', {mode: config.transportMode});
