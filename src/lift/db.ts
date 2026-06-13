/**
 * SQLite persistence for the personal lift log. Deliberately a SEPARATE
 * database from the OAuth auth store (src/auth/db.ts) so a bug in logging
 * can never corrupt or touch authentication tokens.
 *
 * Uses node:sqlite (no native build step). All queries are parameterized.
 */
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

/** Where a session's data came from: hand-logged vs imported from a watch. */
export type LiftSource = 'manual' | 'garmin';

/**
 * One working set within a session. `restSec` is preserved on Garmin imports
 * (the watch records rest per set); manual entries usually omit it.
 */
export interface LiftSet {
  weight: number;
  reps: number;
  restSec?: number;
}

/** A logged training session for a single lift. */
export interface LiftSession {
  id: string;
  date: string;
  lift: string;
  sets: LiftSet[];
  note?: string;
  createdAt: number;
  /** 'manual' for hand-logged, 'garmin' for watch imports. */
  source: LiftSource;
  /** Garmin activity id this was imported from (dedupe key); manual = null. */
  activityId?: number;
}

/** Fields supplied when inserting a session (id and createdAt are assigned). */
export interface NewLiftSession {
  date: string;
  lift: string;
  sets: LiftSet[];
  note?: string;
}

/** Fields for importing a reviewed Garmin session into the unified log. */
export interface GarminImportSession {
  date: string;
  lift: string;
  sets: LiftSet[];
  activityId: number;
  note?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  lift TEXT NOT NULL,
  sets TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  activity_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_lift_date
  ON sessions (lift, date DESC, created_at DESC);
`;

type Row = Record<string, string | number | null>;

function rowToSession(row: Row): LiftSession {
  const activityId = row['activity_id'] as number | null;
  return {
    id: row['id'] as string,
    date: row['date'] as string,
    lift: row['lift'] as string,
    sets: JSON.parse(row['sets'] as string) as LiftSet[],
    note: (row['note'] as string | null) ?? undefined,
    createdAt: row['created_at'] as number,
    source: ((row['source'] as string | null) ?? 'manual') as LiftSource,
    activityId: activityId ?? undefined,
  };
}

export class LiftDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Bring an older DB (pre-import schema) up to date: SQLite has no
   * ADD COLUMN IF NOT EXISTS, so add the source/activity_id columns only
   * when absent. New DBs already have them from SCHEMA.
   */
  private migrate(): void {
    const columns = (
      this.db.prepare('PRAGMA table_info(sessions)').all() as Row[]
    ).map(row => row['name'] as string);
    if (!columns.includes('source')) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
      );
    }
    if (!columns.includes('activity_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN activity_id INTEGER');
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_activity_lift
         ON sessions (activity_id, lift) WHERE activity_id IS NOT NULL`,
    );
  }

  /** Inserts a manual (hand-logged) session and returns the stored row. */
  insertSession(session: NewLiftSession): LiftSession {
    const stored: LiftSession = {
      id: randomUUID(),
      date: session.date,
      lift: session.lift,
      sets: session.sets,
      note: session.note,
      createdAt: nowSeconds(),
      source: 'manual',
      activityId: undefined,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, date, lift, sets, note, created_at, source, activity_id)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', NULL)`,
      )
      .run(
        stored.id,
        stored.date,
        stored.lift,
        JSON.stringify(stored.sets),
        stored.note ?? null,
        stored.createdAt,
      );
    return stored;
  }

  /**
   * Imports a reviewed Garmin session into the unified log. Garmin is the
   * source of truth, so any existing rows for the same lift that this import
   * supersedes are replaced: the same (activityId, lift) — idempotent
   * re-import — and any colliding entry on the same date+lift (a manual log
   * or a different activity). Returns the stored row plus the replaced rows
   * so the caller can note manual entries that were overwritten.
   */
  upsertGarminSession(session: GarminImportSession): {
    session: LiftSession;
    replaced: LiftSession[];
  } {
    const replaced = (
      this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE lift = ? COLLATE NOCASE
             AND (activity_id = ? OR date = ?)`,
        )
        .all(session.lift, session.activityId, session.date) as Row[]
    ).map(rowToSession);
    this.db
      .prepare(
        `DELETE FROM sessions
         WHERE lift = ? COLLATE NOCASE
           AND (activity_id = ? OR date = ?)`,
      )
      .run(session.lift, session.activityId, session.date);

    const stored: LiftSession = {
      id: randomUUID(),
      date: session.date,
      lift: session.lift,
      sets: session.sets,
      note: session.note,
      createdAt: nowSeconds(),
      source: 'garmin',
      activityId: session.activityId,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, date, lift, sets, note, created_at, source, activity_id)
         VALUES (?, ?, ?, ?, ?, ?, 'garmin', ?)`,
      )
      .run(
        stored.id,
        stored.date,
        stored.lift,
        JSON.stringify(stored.sets),
        stored.note ?? null,
        stored.createdAt,
        session.activityId,
      );
    return {session: stored, replaced};
  }

  /**
   * Sessions newest-first. Lift names are matched case-insensitively; omit
   * `lift` to return every lift.
   */
  listSessions(lift: string | undefined, limit: number): LiftSession[] {
    const rows =
      lift === undefined
        ? (this.db
            .prepare(
              `SELECT * FROM sessions
               ORDER BY date DESC, created_at DESC
               LIMIT ?`,
            )
            .all(limit) as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM sessions
               WHERE lift = ? COLLATE NOCASE
               ORDER BY date DESC, created_at DESC
               LIMIT ?`,
            )
            .all(lift, limit) as Row[]);
    return rows.map(rowToSession);
  }

  /**
   * The most recent prior session for a lift, excluding a given session id
   * (so a just-inserted row doesn't count as its own predecessor).
   */
  priorSession(lift: string, excludeId: string): LiftSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE lift = ? COLLATE NOCASE AND id != ?
         ORDER BY date DESC, created_at DESC
         LIMIT 1`,
      )
      .get(lift, excludeId) as Row | undefined;
    return row === undefined ? undefined : rowToSession(row);
  }

  getById(id: string): LiftSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Row | undefined;
    return row === undefined ? undefined : rowToSession(row);
  }

  /**
   * Applies a partial update to a session (read-modify-write, all columns
   * rebound). Returns the updated row, or undefined if the id is unknown.
   */
  updateSession(
    id: string,
    patch: Partial<NewLiftSession>,
  ): LiftSession | undefined {
    const existing = this.getById(id);
    if (existing === undefined) return undefined;
    const updated: LiftSession = {
      ...existing,
      date: patch.date ?? existing.date,
      lift: patch.lift ?? existing.lift,
      sets: patch.sets ?? existing.sets,
      note: patch.note !== undefined ? patch.note : existing.note,
    };
    this.db
      .prepare(
        'UPDATE sessions SET date = ?, lift = ?, sets = ?, note = ? WHERE id = ?',
      )
      .run(
        updated.date,
        updated.lift,
        JSON.stringify(updated.sets),
        updated.note ?? null,
        id,
      );
    return updated;
  }

  /** Deletes a session; returns true if a row was removed. */
  deleteSession(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
