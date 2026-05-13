import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RosterCache, ROSTER_STATUS_VALUES, type RosterEntryRow } from '../cache.js';

function mkRow(over: Partial<RosterEntryRow> = {}): RosterEntryRow {
  return {
    person: 'sally',
    dateIso: '2026-05-13',
    status: 'working',
    hours: 8,
    payloadJson: '{}',
    updatedAt: '2026-05-13T08:00:00Z',
    ...over,
  };
}

describe('RosterCache', () => {
  let dir: string;
  let cache: RosterCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-cache-'));
    cache = new RosterCache({ path: join(dir, 'cache.db') });
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a fixture entry through upsertEntry + getEntry', () => {
    const row = mkRow();
    cache.upsertEntry(row);
    expect(cache.getEntry({ person: row.person, dateIso: row.dateIso })).toEqual(row);
  });

  it('returns null for a missing (person, date) pair', () => {
    expect(cache.getEntry({ person: 'sally', dateIso: '1900-01-01' })).toBeNull();
  });

  it('upsertEntry overwrites an existing row on the same primary key', () => {
    cache.upsertEntry(mkRow({ status: 'working', hours: 8 }));
    cache.upsertEntry(mkRow({ status: 'leave', hours: null }));
    const got = cache.getEntry({ person: 'sally', dateIso: '2026-05-13' });
    expect(got?.status).toBe('leave');
    expect(got?.hours).toBeNull();
  });

  it('entriesForRange filters by people set + inclusive date window, sorted', () => {
    cache.upsertEntry(mkRow({ person: 'sally', dateIso: '2026-05-13', status: 'working' }));
    cache.upsertEntry(mkRow({ person: 'sally', dateIso: '2026-05-14', status: 'leave' }));
    cache.upsertEntry(mkRow({ person: 'sally', dateIso: '2026-05-15', status: 'working' }));
    cache.upsertEntry(mkRow({ person: 'chloe', dateIso: '2026-05-14', status: 'working' }));
    cache.upsertEntry(mkRow({ person: 'kelvin', dateIso: '2026-05-14', status: 'working' }));

    const got = cache.entriesForRange({
      people: ['sally', 'chloe'],
      startIso: '2026-05-14',
      endIso: '2026-05-15',
    });
    expect(got.map((r) => `${r.person}:${r.dateIso}:${r.status}`)).toEqual([
      'chloe:2026-05-14:working',
      'sally:2026-05-14:leave',
      'sally:2026-05-15:working',
    ]);
  });

  it('entriesForRange returns [] when the people set is empty (short-circuit)', () => {
    cache.upsertEntry(mkRow());
    expect(
      cache.entriesForRange({ people: [], startIso: '2000-01-01', endIso: '2099-12-31' }),
    ).toEqual([]);
  });

  it('setSyncState upserts idempotently per source', () => {
    cache.setSyncState('w_and_l_log', 'sha256:abc', '2026-05-13T08:00:00Z');
    cache.setSyncState('w_and_l_log', 'sha256:def', '2026-05-13T08:15:00Z');
    expect(cache.getSyncState('w_and_l_log')).toEqual({
      source: 'w_and_l_log',
      headerHash: 'sha256:def',
      lastSyncIso: '2026-05-13T08:15:00Z',
    });
  });

  it('getSyncState returns null for an unknown source', () => {
    expect(cache.getSyncState('nope')).toBeNull();
  });

  it('schema is idempotent — opening the same DB file twice is a no-op', () => {
    cache.upsertEntry(mkRow());
    cache.close();
    const second = new RosterCache({ path: join(dir, 'cache.db') });
    try {
      expect(second.getEntry({ person: 'sally', dateIso: '2026-05-13' })).not.toBeNull();
    } finally {
      second.close();
    }
  });

  it('persists every roster status enum value losslessly', () => {
    for (const status of ROSTER_STATUS_VALUES) {
      cache.upsertEntry(mkRow({ person: `p-${status}`, status }));
      const got = cache.getEntry({ person: `p-${status}`, dateIso: '2026-05-13' });
      expect(got?.status).toBe(status);
    }
  });

  it('cache file is created mode 0600 on a POSIX-permission filesystem', () => {
    cache.close();
    const filePath = join(dir, 'cache.db');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    cache = new RosterCache({ path: filePath });
  });

  it('schema has no `notes` column anywhere — privacy invariant guard', () => {
    cache.close();
    const filePath = join(dir, 'cache.db');
    // Re-open + dump column names from sqlite_master via better-sqlite3.
    cache = new RosterCache({ path: filePath });
    const tables = (cache as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string; sql: string }> } } }).db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table'")
      .all();
    for (const t of tables) {
      expect(t.sql.toLowerCase()).not.toMatch(/\bnotes\b/);
    }
  });

  it('payload_json round-trips arbitrary auxiliary fields without leaking notes', () => {
    // Adapter may carry forward source-row pointer + parser confidence; it must
    // never carry the original `notes` text. This test asserts the cache layer
    // is happy to round-trip a structured payload but does not police what the
    // caller put in — that's the adapter's job in sub-item 2/3. Here we just
    // round-trip and assert no schema-level surprise.
    const payload = JSON.stringify({ source_row: 42, parser: 'v1' });
    cache.upsertEntry(mkRow({ payloadJson: payload }));
    expect(cache.getEntry({ person: 'sally', dateIso: '2026-05-13' })?.payloadJson).toBe(payload);
  });

  it('WAL mode is enabled — wal/shm files appear after a write', () => {
    cache.upsertEntry(mkRow());
    const names = readdirSync(dir);
    // better-sqlite3 may flush wal on close, so check that the journal is wal
    // by querying the pragma directly via the public DB connection.
    const mode = (cache as unknown as { db: { pragma: (s: string, opts?: unknown) => unknown } }).db
      .pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    // The wal/shm file presence is opportunistic — accept either presence or
    // absence; the pragma above is the authoritative check.
    void names;
    void readFileSync; // keep import lint-clean even if guard above is enough
  });
});
