/**
 * SQLite cache for roster entries + per-source sync state.
 *
 * Sub-item 1 of roster-adviser v1 (ai-ops-meta architect-backlog.md). Pure
 * local code — no Google Sheets round-trip yet. The adapter that fills this
 * cache lands in sub-item 2 (sheet-shape probe + boot self-check); the
 * 15-min sync runner + privacy filter lands in sub-item 3.
 *
 * Privacy invariant (project_roster_semantics): the cache schema does NOT
 * have a `notes` column anywhere. The adapter (sub-item 2) decides what to
 * persist; this layer enforces the no-`notes` rule at the row schema level
 * so a future writer cannot accidentally leak free-text health/leave detail.
 *
 * Schema is idempotent (`CREATE TABLE IF NOT EXISTS`) so reopening an
 * existing DB file is a no-op.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type RosterStatus =
  | 'working'
  | 'leave'
  | 'half-day'
  | 'public-holiday'
  | 'sick'
  | 'unknown';

export const ROSTER_STATUS_VALUES: readonly RosterStatus[] = [
  'working',
  'leave',
  'half-day',
  'public-holiday',
  'sick',
  'unknown',
];

export interface RosterEntryRow {
  readonly person: string;
  /** ISO date `YYYY-MM-DD` (no time component — roster is day-grain). */
  readonly dateIso: string;
  readonly status: RosterStatus;
  readonly hours: number | null;
  /** Stable JSON blob for any non-sensitive auxiliary fields the adapter
   *  carries forward (`source_row`, `confidence`, etc.). MUST NOT contain
   *  the original `notes` column from the W&L sheet — see privacy invariant
   *  in the file header. */
  readonly payloadJson: string;
  readonly updatedAt: string;
}

export interface SyncStateRow {
  readonly source: string;
  readonly headerHash: string;
  readonly lastSyncIso: string;
}

export interface RosterRangeQuery {
  readonly people: readonly string[];
  /** ISO date `YYYY-MM-DD`, inclusive. */
  readonly startIso: string;
  /** ISO date `YYYY-MM-DD`, inclusive (rosters are day-grain). */
  readonly endIso: string;
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS roster_entries (
  person TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  status TEXT NOT NULL,
  hours REAL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person, date_iso)
);

CREATE INDEX IF NOT EXISTS roster_entries_date ON roster_entries (date_iso);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  header_hash TEXT NOT NULL,
  last_sync_iso TEXT NOT NULL
);
`;

export interface RosterCacheOptions {
  /** Filesystem path to the SQLite DB. Use `:memory:` in tests. */
  readonly path: string;
}

export class RosterCache {
  private readonly db: DatabaseType;

  constructor(opts: RosterCacheOptions) {
    const created = opts.path !== ':memory:' && !existsSync(opts.path);
    if (created) {
      const dir = dirname(opts.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_DDL);
    if (created) {
      try {
        chmodSync(opts.path, 0o600);
      } catch {
        // Best-effort on POSIX-permission filesystems; tests on tmpfs may
        // not support chmod and that's fine for the in-process round-trip.
      }
    }
  }

  upsertEntry(row: RosterEntryRow): void {
    this.db
      .prepare(
        `INSERT INTO roster_entries
         (person, date_iso, status, hours, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(person, date_iso) DO UPDATE SET
           status=excluded.status,
           hours=excluded.hours,
           payload_json=excluded.payload_json,
           updated_at=excluded.updated_at`,
      )
      .run(
        row.person,
        row.dateIso,
        row.status,
        row.hours,
        row.payloadJson,
        row.updatedAt,
      );
  }

  getEntry(args: { person: string; dateIso: string }): RosterEntryRow | null {
    const row = this.db
      .prepare(
        `SELECT person, date_iso AS dateIso, status, hours, payload_json AS payloadJson,
                updated_at AS updatedAt
         FROM roster_entries WHERE person = ? AND date_iso = ?`,
      )
      .get(args.person, args.dateIso) as RosterEntryRow | undefined;
    return row ?? null;
  }

  entriesForRange(query: RosterRangeQuery): RosterEntryRow[] {
    if (query.people.length === 0) {
      return [];
    }
    const placeholders = query.people.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT person, date_iso AS dateIso, status, hours, payload_json AS payloadJson,
                updated_at AS updatedAt
         FROM roster_entries
         WHERE person IN (${placeholders})
           AND date_iso >= ?
           AND date_iso <= ?
         ORDER BY person, date_iso`,
      )
      .all(...query.people, query.startIso, query.endIso) as RosterEntryRow[];
  }

  getSyncState(source: string): SyncStateRow | null {
    const row = this.db
      .prepare(
        `SELECT source, header_hash AS headerHash, last_sync_iso AS lastSyncIso
         FROM sync_state WHERE source = ?`,
      )
      .get(source) as SyncStateRow | undefined;
    return row ?? null;
  }

  setSyncState(source: string, headerHash: string, lastSyncIso: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (source, header_hash, last_sync_iso)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           header_hash=excluded.header_hash,
           last_sync_iso=excluded.last_sync_iso`,
      )
      .run(source, headerHash, lastSyncIso);
  }

  close(): void {
    this.db.close();
  }
}
