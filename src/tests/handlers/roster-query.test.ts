import { describe, expect, it } from 'vitest';
import { RosterCache } from '../../cache.js';
import type { ContractEnvelope } from '../../contracts.js';
import { handleRosterQuery } from '../../handlers/roster-query.js';
import { ROSTER_CACHE_MAX_STALENESS_S, ROSTER_SYNC_SOURCE } from '../../sync-runner.js';

function envelope(overrides: Partial<Record<string, unknown>> = {}): ContractEnvelope {
  return {
    contract_id: 'roster.query.v1',
    trace_id: '01890000-0000-7000-8000-00000000aaaa',
    dedupe_key: 'sha256:k',
    source_ref: 'test',
    caller_agent_id: 'test',
    person: 'sally',
    date: '2026-05-13',
    ...overrides,
  };
}

function freshCache(): RosterCache {
  return new RosterCache({ path: ':memory:' });
}

describe('handleRosterQuery', () => {
  it('returns hardcoded working/24h for ai-doer without touching the cache', () => {
    const cache = freshCache();
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T00:00:00Z');
    const resp = handleRosterQuery(
      envelope({ person: 'ai-doer' }),
      { cache, now: () => new Date('2026-05-14T00:00:00Z') },
    );
    expect(resp).toMatchObject({
      ok: true,
      person: 'ai-doer',
      status: 'working',
      hours: 24,
      source: 'hardcoded',
      staleness_seconds: null,
      sheet_filled: true,
    });
  });

  it('returns cached row when the cache is fresh', () => {
    const cache = freshCache();
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T11:00:00Z');
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-13',
      status: 'working',
      hours: 8,
      payloadJson: '{}',
      updatedAt: '2026-05-13T11:00:00Z',
    });
    const resp = handleRosterQuery(envelope(), {
      cache,
      now: () => new Date('2026-05-13T12:00:00Z'),
    });
    expect(resp).toMatchObject({
      ok: true,
      person: 'sally',
      status: 'working',
      hours: 8,
      source: 'cache',
      sheet_filled: true,
    });
    if (resp.ok) {
      expect(resp.staleness_seconds).toBe(3600);
    }
  });

  it('collapses cache-stale rows to unknown per AP-1 (no fabricated availability)', () => {
    const cache = freshCache();
    // Sync 48h ago — > 24h threshold.
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-11T12:00:00Z');
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-13',
      status: 'leave',
      hours: null,
      payloadJson: '{}',
      updatedAt: '2026-05-11T12:00:00Z',
    });
    const resp = handleRosterQuery(envelope(), {
      cache,
      now: () => new Date('2026-05-13T12:00:00Z'),
    });
    expect(resp).toMatchObject({
      ok: true,
      status: 'unknown',
      hours: null,
      source: 'cache',
      sheet_filled: true,
    });
    if (resp.ok) {
      expect(resp.staleness_seconds).toBeGreaterThan(ROSTER_CACHE_MAX_STALENESS_S);
    }
  });

  it('returns sheet_filled=false when no row exists in cache for that date', () => {
    const cache = freshCache();
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T11:00:00Z');
    const resp = handleRosterQuery(envelope({ date: '2099-12-31' }), {
      cache,
      now: () => new Date('2026-05-13T12:00:00Z'),
    });
    expect(resp).toMatchObject({
      ok: true,
      status: 'unknown',
      hours: null,
      source: 'cache',
      sheet_filled: false,
    });
  });

  it('returns staleness_seconds=null when no sync state exists yet', () => {
    const cache = freshCache();
    const resp = handleRosterQuery(envelope(), {
      cache,
      now: () => new Date('2026-05-13T12:00:00Z'),
    });
    expect(resp).toMatchObject({
      ok: true,
      status: 'unknown',
      source: 'cache',
      staleness_seconds: null,
    });
  });
});
