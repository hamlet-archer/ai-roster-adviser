import { describe, expect, it } from 'vitest';
import { RosterCache } from '../../cache.js';
import type { ContractEnvelope } from '../../contracts.js';
import { handleRosterRange } from '../../handlers/roster-range.js';
import { ROSTER_SYNC_SOURCE } from '../../sync-runner.js';

function envelope(overrides: Partial<Record<string, unknown>> = {}): ContractEnvelope {
  return {
    contract_id: 'roster.range.v1',
    trace_id: '01890000-0000-7000-8000-00000000bbbb',
    dedupe_key: 'sha256:k',
    source_ref: 'test',
    caller_agent_id: 'test',
    people: ['sally', 'ai-doer'],
    window: { start: '2026-05-13', end: '2026-05-15' },
    ...overrides,
  };
}

describe('handleRosterRange', () => {
  it('synthesises ai-doer rows hardcoded; reads cache for everyone else', () => {
    const cache = new RosterCache({ path: ':memory:' });
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T11:00:00Z');
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-13',
      status: 'working',
      hours: 8,
      payloadJson: '{}',
      updatedAt: '2026-05-13T11:00:00Z',
    });
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-14',
      status: 'leave',
      hours: null,
      payloadJson: '{}',
      updatedAt: '2026-05-13T11:00:00Z',
    });

    const resp = handleRosterRange(envelope(), {
      cache,
      now: () => new Date('2026-05-13T12:00:00Z'),
    });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // 2 people × 3 days = 6 entries.
    expect(resp.entries).toHaveLength(6);

    const sallyMon = resp.entries.find((e) => e.person === 'sally' && e.date === '2026-05-13');
    expect(sallyMon).toMatchObject({ status: 'working', hours: 8, source: 'cache', sheet_filled: true });

    const sallyTue = resp.entries.find((e) => e.person === 'sally' && e.date === '2026-05-14');
    expect(sallyTue).toMatchObject({ status: 'leave', hours: null, source: 'cache', sheet_filled: true });

    const sallyWed = resp.entries.find((e) => e.person === 'sally' && e.date === '2026-05-15');
    expect(sallyWed).toMatchObject({ status: 'unknown', source: 'cache', sheet_filled: false });

    for (const date of ['2026-05-13', '2026-05-14', '2026-05-15']) {
      const aiDoer = resp.entries.find((e) => e.person === 'ai-doer' && e.date === date);
      expect(aiDoer).toMatchObject({
        status: 'working',
        hours: 24,
        source: 'hardcoded',
        sheet_filled: true,
        staleness_seconds: null,
      });
    }
  });

  it('collapses every non-hardcoded row to unknown when cache is stale', () => {
    const cache = new RosterCache({ path: ':memory:' });
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-11T00:00:00Z'); // >24h
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-13',
      status: 'working',
      hours: 8,
      payloadJson: '{}',
      updatedAt: '2026-05-11T00:00:00Z',
    });
    const resp = handleRosterRange(
      envelope({ people: ['sally'] }),
      { cache, now: () => new Date('2026-05-13T12:00:00Z') },
    );
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const sally = resp.entries.find((e) => e.person === 'sally' && e.date === '2026-05-13');
    expect(sally).toMatchObject({ status: 'unknown', source: 'cache', sheet_filled: true });
  });

  it('rejects a window > 30 days as bad_query', () => {
    const cache = new RosterCache({ path: ':memory:' });
    const resp = handleRosterRange(
      envelope({ window: { start: '2026-01-01', end: '2026-03-15' } }),
      { cache, now: () => new Date('2026-05-13T12:00:00Z') },
    );
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.code).toBe('bad_query');
    expect(resp.trace_id).toBe('01890000-0000-7000-8000-00000000bbbb');
  });

  it('rejects window.end < window.start as bad_query', () => {
    const cache = new RosterCache({ path: ':memory:' });
    const resp = handleRosterRange(
      envelope({ window: { start: '2026-05-15', end: '2026-05-13' } }),
      { cache, now: () => new Date('2026-05-13T12:00:00Z') },
    );
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.code).toBe('bad_query');
  });

  it('returns one entry per (person, date) even when no cache row exists', () => {
    const cache = new RosterCache({ path: ':memory:' });
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T11:00:00Z');
    const resp = handleRosterRange(
      envelope({ people: ['chloe'], window: { start: '2026-05-13', end: '2026-05-14' } }),
      { cache, now: () => new Date('2026-05-13T12:00:00Z') },
    );
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.entries).toHaveLength(2);
    for (const e of resp.entries) {
      expect(e).toMatchObject({ status: 'unknown', sheet_filled: false });
    }
  });
});
