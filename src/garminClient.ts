/**
 * Lazily-initialized Garmin Connect client singleton with OAuth token
 * caching. Shared by every tool regardless of transport.
 */
import os from 'os';
import path from 'path';

import pkg from 'garmin-connect';

import {TOKEN_DIR_NAME} from './constants.js';
import {getCredentials} from './credentials.js';

const {GarminConnect} = pkg;

export type GarminClient = InstanceType<typeof GarminConnect>;

const TOKEN_DIR = path.join(os.homedir(), TOKEN_DIR_NAME);

let clientPromise: Promise<GarminClient> | null = null;

export function getClient(): Promise<GarminClient> {
  if (!clientPromise) {
    clientPromise = initClient().catch((err) => {
      clientPromise = null; // allow retry on failure
      throw err;
    });
  }
  return clientPromise;
}

async function initClient(): Promise<GarminClient> {
  const {username, password} = await getCredentials();
  const gc = new GarminConnect({username, password});

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
