/**
 * Lazily-initialized Garmin Connect client singleton with OAuth token
 * caching. Shared by every tool regardless of transport. Entry points must
 * call configureGarminClient() before the first tool invocation.
 */
import pkg from 'garmin-connect';

import {CredentialProvider} from './credentials.js';
import {logger} from './logger.js';

const {GarminConnect} = pkg;

export type GarminClient = InstanceType<typeof GarminConnect>;

export interface GarminClientConfig {
  credentialProvider: CredentialProvider;
  /** Directory where Garmin OAuth tokens are cached across restarts. */
  tokenCacheDir: string;
}

let clientConfig: GarminClientConfig | null = null;
let clientPromise: Promise<GarminClient> | null = null;
let displayNamePromise: Promise<string> | null = null;

export function configureGarminClient(config: GarminClientConfig): void {
  clientConfig = config;
  clientPromise = null;
  displayNamePromise = null;
}

/** The Garmin display name (user hash), cached for direct API calls. */
export function getDisplayName(): Promise<string> {
  if (!displayNamePromise) {
    displayNamePromise = getClient()
      .then(gc => gc.getUserProfile())
      .then(profile => profile.displayName)
      .catch(err => {
        displayNamePromise = null; // allow retry on failure
        throw err;
      });
  }
  return displayNamePromise;
}

export function getClient(): Promise<GarminClient> {
  if (!clientConfig) {
    throw new Error(
      'Garmin client not configured: configureGarminClient() must be called at startup',
    );
  }
  if (!clientPromise) {
    clientPromise = initClient(clientConfig).catch(err => {
      clientPromise = null; // allow retry on failure
      throw err;
    });
  }
  return clientPromise;
}

async function initClient(config: GarminClientConfig): Promise<GarminClient> {
  const {username, password} = await config.credentialProvider.getCredentials();
  const gc = new GarminConnect({username, password});

  // Try loading saved tokens first
  try {
    gc.loadTokenByFile(config.tokenCacheDir);
    await gc.getUserProfile();
    logger.debug('garmin token cache hit', {
      tokenCacheDir: config.tokenCacheDir,
    });
  } catch {
    // Token expired or missing, do a fresh login
    await gc.login();
    gc.exportTokenToFile(config.tokenCacheDir);
    logger.info('garmin fresh login; token cache written', {
      tokenCacheDir: config.tokenCacheDir,
    });
  }

  return gc;
}
