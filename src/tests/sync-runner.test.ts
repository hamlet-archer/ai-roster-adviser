/**
 * Transitional sync-runner tests for the G6.15.1 → G6.15.3 window.
 *
 * G6.15.1 (this PR) bumped `SheetShapeMapping` from horizontal to vertical
 * layout, which means the v0 horizontal-iteration body of `runSyncCycle`
 * is gone. G6.15.3 will rewrite the iteration against the new shape.
 *
 * Until then, `runSyncCycle` returns a fixed `awaiting_v2_runner` report
 * — the tests below pin that contract. The shape-agnostic helpers
 * (`resolveCell`, status enum + privacy filter) still ship value
 * standalone and are covered in full.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRows,
  SHEET_MAPPING_SCHEMA_VERSION,
  type SheetShapeMapping,
} from '../sheet-shape-mapping.js';
import {
  resolveCell,
  ROSTER_DEFAULT_HOURS_HALF_DAY,
  ROSTER_DEFAULT_HOURS_WORKING,
  hoursForStatus,
  runSyncCycle,
} from '../sync-runner.js';

function fixtureMapping(): SheetShapeMapping {
  const row1 = ['', 'Sally'];
  const row2 = ['Date', 'Day'];
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRows(row1, row2),
    dateColumn: 0,
    staffColumns: { Sally: { day: 1 } },
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-21T19:11:05Z',
  };
}

describe('resolveCell — privacy filter precedence', () => {
  const mapping = fixtureMapping();

  it('collapses any /sick/i cell text to status sick with hours null', () => {
    expect(resolveCell('sick', mapping)).toEqual({
      status: 'sick',
      hours: null,
      sickCollapsed: true,
      unknownText: false,
    });
    // Privacy load-bearing: the free-text "migraine" never appears in the
    // returned resolution.
    expect(resolveCell('sick - migraine', mapping)).toEqual({
      status: 'sick',
      hours: null,
      sickCollapsed: true,
      unknownText: false,
    });
    // Case-insensitive — both UK "Sick" and lowercase "sick" + substring
    // matches like "feeling sicker today" all collapse identically.
    expect(resolveCell('SICK', mapping).status).toBe('sick');
    expect(resolveCell('feeling sicker today', mapping).status).toBe('sick');
  });

  it('returns unknown + sickCollapsed=false for empty/null cells', () => {
    expect(resolveCell(null, mapping).status).toBe('unknown');
    expect(resolveCell('', mapping).status).toBe('unknown');
    expect(resolveCell(undefined as unknown as null, mapping).status).toBe('unknown');
  });

  it('maps known cell text via statusValueToEnumMap (case + trim)', () => {
    expect(resolveCell('W', mapping)).toEqual({
      status: 'working',
      hours: ROSTER_DEFAULT_HOURS_WORKING,
      sickCollapsed: false,
      unknownText: false,
    });
    expect(resolveCell('  half  ', mapping)).toEqual({
      status: 'half-day',
      hours: ROSTER_DEFAULT_HOURS_HALF_DAY,
      sickCollapsed: false,
      unknownText: false,
    });
    expect(resolveCell('Leave', mapping).status).toBe('leave');
    expect(resolveCell('PH', mapping).status).toBe('public-holiday');
  });

  it('returns unknownText=true for cell content not in the map', () => {
    const r = resolveCell('Maybe later', mapping);
    expect(r.status).toBe('unknown');
    expect(r.unknownText).toBe(true);
    expect(r.hours).toBeNull();
  });
});

describe('hoursForStatus', () => {
  it('returns 8 for working and 4 for half-day', () => {
    expect(hoursForStatus('working')).toBe(ROSTER_DEFAULT_HOURS_WORKING);
    expect(hoursForStatus('half-day')).toBe(ROSTER_DEFAULT_HOURS_HALF_DAY);
  });

  it('returns null for non-working statuses', () => {
    expect(hoursForStatus('leave')).toBeNull();
    expect(hoursForStatus('sick')).toBeNull();
    expect(hoursForStatus('public-holiday')).toBeNull();
    expect(hoursForStatus('unknown')).toBeNull();
  });
});

describe('runSyncCycle — transitional stub (awaiting G6.15.3)', () => {
  it('returns awaiting_v2_runner with no upserts', async () => {
    const mapping = fixtureMapping();
    const report = await runSyncCycle({
      // The stub never touches these — pass placeholders to satisfy types.
      adapter: { valuesGet: async () => ({ values: [] }) } as never,
      cache: {} as never,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      now: () => new Date('2026-05-21T19:11:05Z'),
    });
    expect(report.status).toBe('awaiting_v2_runner');
    expect(report.cellsUpserted).toBe(0);
    expect(report.cellsSkipped).toBe(0);
    expect(report.errorMessage).toMatch(/G6\.15\.3/);
  });
});
