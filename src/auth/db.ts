/**
 * SQLite persistence for the built-in OAuth authorization server: registered
 * clients, pending logins, authorization codes, and access/refresh tokens.
 *
 * Uses node:sqlite (no native build step). Codes and tokens are stored as
 * SHA-256 hashes so the database never contains usable bearer secrets.
 */
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {OAuthClientInformationFull} from '@modelcontextprotocol/sdk/shared/auth.js';

import {OAUTH} from '../constants.js';

export enum TokenKind {
  Access = 'access',
  Refresh = 'refresh',
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  kind: TokenKind;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function newOpaqueToken(): string {
  return randomBytes(OAUTH.tokenByteLength).toString('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function serializeScopes(scopes: string[]): string {
  return scopes.join(' ');
}

function deserializeScopes(value: string): string[] {
  return value === '' ? [] : value.split(' ');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class AuthDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  // --- Clients ---

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT data FROM clients WHERE client_id = ?').get(clientId) as
        {data: string} | undefined;
    return row === undefined ? undefined : JSON.parse(row.data) as OAuthClientInformationFull;
  }

  putClient(client: OAuthClientInformationFull): void {
    this.db.prepare('INSERT OR REPLACE INTO clients (client_id, data, created_at) VALUES (?, ?, ?)')
        .run(client.client_id, JSON.stringify(client), nowSeconds());
  }

  // --- Pending authorizations (login page shown, password not yet checked) ---

  createPendingAuthorization(pending: PendingAuthorization): void {
    this.db.prepare(
        `INSERT INTO pending_authorizations
         (id, client_id, code_challenge, redirect_uri, scopes, state, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pending.id, pending.clientId, pending.codeChallenge, pending.redirectUri,
            serializeScopes(pending.scopes), pending.state ?? null, pending.resource ?? null,
            pending.expiresAt);
  }

  getPendingAuthorization(id: string): PendingAuthorization | undefined {
    const row = this.db.prepare('SELECT * FROM pending_authorizations WHERE id = ? AND expires_at > ?')
        .get(id, nowSeconds()) as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    return {
      id: row['id'] as string,
      clientId: row['client_id'] as string,
      codeChallenge: row['code_challenge'] as string,
      redirectUri: row['redirect_uri'] as string,
      scopes: deserializeScopes(row['scopes'] as string),
      state: (row['state'] as string | null) ?? undefined,
      resource: (row['resource'] as string | null) ?? undefined,
      expiresAt: row['expires_at'] as number,
    };
  }

  deletePendingAuthorization(id: string): void {
    this.db.prepare('DELETE FROM pending_authorizations WHERE id = ?').run(id);
  }

  // --- Authorization codes ---

  createAuthorizationCode(code: string, record: AuthorizationCodeRecord): void {
    this.db.prepare(
        `INSERT INTO authorization_codes
         (code_hash, client_id, code_challenge, redirect_uri, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sha256Hex(code), record.clientId, record.codeChallenge, record.redirectUri,
            serializeScopes(record.scopes), record.resource ?? null, record.expiresAt);
  }

  getAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM authorization_codes WHERE code_hash = ? AND expires_at > ?')
        .get(sha256Hex(code), nowSeconds()) as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    return {
      clientId: row['client_id'] as string,
      codeChallenge: row['code_challenge'] as string,
      redirectUri: row['redirect_uri'] as string,
      scopes: deserializeScopes(row['scopes'] as string),
      resource: (row['resource'] as string | null) ?? undefined,
      expiresAt: row['expires_at'] as number,
    };
  }

  deleteAuthorizationCode(code: string): void {
    this.db.prepare('DELETE FROM authorization_codes WHERE code_hash = ?').run(sha256Hex(code));
  }

  // --- Access / refresh tokens ---

  insertToken(token: string, record: TokenRecord): void {
    this.db.prepare(
        `INSERT INTO tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sha256Hex(token), record.kind, record.clientId, serializeScopes(record.scopes),
            record.resource ?? null, record.expiresAt, nowSeconds());
  }

  getToken(token: string, kind: TokenKind): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?')
        .get(sha256Hex(token), kind, nowSeconds()) as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    return {
      kind: row['kind'] as TokenKind,
      clientId: row['client_id'] as string,
      scopes: deserializeScopes(row['scopes'] as string),
      resource: (row['resource'] as string | null) ?? undefined,
      expiresAt: row['expires_at'] as number,
    };
  }

  deleteToken(token: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(sha256Hex(token));
  }

  deleteTokensForClient(clientId: string): void {
    this.db.prepare('DELETE FROM tokens WHERE client_id = ?').run(clientId);
  }

  /** Removes expired rows; returns the number deleted (for sweep logging). */
  deleteExpired(): number {
    const now = nowSeconds();
    let deleted = 0;
    for (const table of ['pending_authorizations', 'authorization_codes', 'tokens']) {
      const result = this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
      deleted += Number(result.changes);
    }
    return deleted;
  }

  close(): void {
    this.db.close();
  }
}
