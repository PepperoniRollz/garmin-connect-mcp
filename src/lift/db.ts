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

/** One working set within a session. */
export interface LiftSet {
  weight: number;
  reps: number;
}

/** A logged training session for a single lift. */
export interface LiftSession {
  id: string;
  date: string;
  lift: string;
  sets: LiftSet[];
  note?: string;
  createdAt: number;
}

/** Fields supplied when inserting a session (id and createdAt are assigned). */
export interface NewLiftSession {
  date: string;
  lift: string;
  sets: LiftSet[];
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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_lift_date
  ON sessions (lift, date DESC, created_at DESC);
`;

type Row = Record<string, string | number | null>;

function rowToSession(row: Row): LiftSession {
  return {
    id: row['id'] as string,
    date: row['date'] as string,
    lift: row['lift'] as string,
    sets: JSON.parse(row['sets'] as string) as LiftSet[],
    note: (row['note'] as string | null) ?? undefined,
    createdAt: row['created_at'] as number,
  };
}

export class LiftDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /** Inserts a session and returns the stored row. */
  insertSession(session: NewLiftSession): LiftSession {
    const stored: LiftSession = {
      id: randomUUID(),
      date: session.date,
      lift: session.lift,
      sets: session.sets,
      note: session.note,
      createdAt: nowSeconds(),
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, date, lift, sets, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
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
