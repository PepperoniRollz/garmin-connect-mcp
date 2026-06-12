/**
 * Lift-log store singleton, mirroring the Garmin client pattern: entry
 * points call configureLiftStore() at startup; tools call getLiftStore().
 */
import {LiftDb} from './db.js';

let liftDb: LiftDb | null = null;

export function configureLiftStore(dbPath: string): void {
  liftDb = new LiftDb(dbPath);
}

export function getLiftStore(): LiftDb {
  if (!liftDb) {
    throw new Error(
      'Lift store not configured: configureLiftStore() must be called at startup',
    );
  }
  return liftDb;
}
