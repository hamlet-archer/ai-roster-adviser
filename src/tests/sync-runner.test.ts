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
  resolveStaffDayCell,
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

describe('resolveStaffDayCell — G6.15.2 priority rules', () => {
  // Build a fixture mapping with both Sally + Chloe, including
  // per-staff statusValueToEnumMap + the full StaffSubColumns shape.
  function staffMapping(): SheetShapeMapping {
    const row1 = ['', '', '', 'Sally', '', '', 'Chloe', '', '', '', '', '', ''];
    const row2 = [
      'Date',
      'DOW',
      '',
      'Day',
      'Night',
      'Remarks',
      'Day',
      'Night',
      'Day Value',
      'Night Value',
      'Overtime',
      'Annual Leave',
      'Remarks',
    ];
    return {
      version: SHEET_MAPPING_SCHEMA_VERSION,
      headerHash: hashHeaderRows(row1, row2),
      dateColumn: 0,
      staffColumns: {
        Sally: {
          day: 3,
          night: 4,
          remarks: 5,
          statusValueToEnumMap: {
            work: 'working',
            pet: 'leave-other',
            '-': 'not-working',
            '': 'not-working',
          },
        },
        Chloe: {
          day: 6,
          night: 7,
          dayValue: 8,
          nightValue: 9,
          overtime: 10,
          annualLeave: 11,
          remarks: 12,
          statusValueToEnumMap: {
            full: 'working',
            half: 'half-day',
            off: 'not-working',
            '-': 'not-working',
            '': 'not-working',
          },
        },
      },
      statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
      probedAt: '2026-05-21T19:11:05Z',
    };
  }

  it('Sally Work → working (per-staff map)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: 'Work' },
      staffMapping(),
    );
    expect(r.status).toBe('working');
    expect(r.hours).toBe(ROSTER_DEFAULT_HOURS_WORKING);
    expect(r.unknownText).toBe(false);
  });

  it('Sally Pet → leave-other (per-staff override of global "pet" lookup)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: 'Pet' },
      staffMapping(),
    );
    expect(r.status).toBe('leave-other');
    expect(r.hours).toBeNull();
  });

  it('Sally - → not-working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: '-' },
      staffMapping(),
    );
    expect(r.status).toBe('not-working');
    expect(r.hours).toBeNull();
  });

  it('Sally empty cell → not-working (per-staff empty-string default)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: '' },
      staffMapping(),
    );
    expect(r.status).toBe('not-working');
  });

  it('Chloe Full → working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Full' },
      staffMapping(),
    );
    expect(r.status).toBe('working');
    expect(r.hours).toBe(ROSTER_DEFAULT_HOURS_WORKING);
  });

  it('Chloe Half → half-day', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Half' },
      staffMapping(),
    );
    expect(r.status).toBe('half-day');
    expect(r.hours).toBe(ROSTER_DEFAULT_HOURS_HALF_DAY);
  });

  it('Chloe Off → not-working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Off' },
      staffMapping(),
    );
    expect(r.status).toBe('not-working');
  });

  it('Chloe numeric Day > 0 → working (numeric fallback rule)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 1 },
      staffMapping(),
    );
    expect(r.status).toBe('working');
    expect(r.hours).toBe(ROSTER_DEFAULT_HOURS_WORKING);
  });

  it('Chloe numeric Day === 0 → not-working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 0 },
      staffMapping(),
    );
    expect(r.status).toBe('not-working');
    expect(r.hours).toBeNull();
  });

  it('Annual Leave > 0 → leave (override beats Day cell)', () => {
    // Chloe's Day says "Full" → working, but Annual Leave is 1 → override.
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Full', annualLeaveCell: 1 },
      staffMapping(),
    );
    expect(r.status).toBe('leave');
    expect(r.hours).toBeNull();
  });

  it('Annual Leave 0 does NOT trigger leave override (false-zero rule)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Full', annualLeaveCell: 0 },
      staffMapping(),
    );
    expect(r.status).toBe('working');
  });

  it('Annual Leave numeric string (e.g. "5.1") still triggers leave', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Off', annualLeaveCell: '5.1' },
      staffMapping(),
    );
    expect(r.status).toBe('leave');
  });

  it('Annual Leave "-" does NOT trigger leave (sentinel "no leave")', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Full', annualLeaveCell: '-' },
      staffMapping(),
    );
    expect(r.status).toBe('working');
  });

  it('privacy: /sick/i in Day cell → sick (privacy filter beats all other rules)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'sick', annualLeaveCell: 1 },
      staffMapping(),
    );
    expect(r.status).toBe('sick');
    expect(r.hours).toBeNull();
    expect(r.sickCollapsed).toBe(true);
  });

  it('privacy: /sick/i in Remarks cell also triggers sick (heuristic)', () => {
    const r = resolveStaffDayCell(
      {
        staffName: 'Sally',
        dayCell: 'Work',
        remarksCell: 'feeling sicker today',
      },
      staffMapping(),
    );
    expect(r.status).toBe('sick');
    expect(r.sickCollapsed).toBe(true);
  });

  it('unknown staff falls back to the global statusValueToEnumMap', () => {
    const m = staffMapping();
    // Add an unknown staff with no per-staff map; "W" matches the global default.
    const m2: SheetShapeMapping = {
      ...m,
      staffColumns: {
        ...m.staffColumns,
        Unknown: { day: 99 }, // no statusValueToEnumMap
      },
    };
    const r = resolveStaffDayCell({ staffName: 'Unknown', dayCell: 'W' }, m2);
    expect(r.status).toBe('working');
  });

  it('unknown Day text (no per-staff hit, no global hit) → unknown + unknownText:true', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: 'Yetanotherthing' },
      staffMapping(),
    );
    expect(r.status).toBe('unknown');
    expect(r.unknownText).toBe(true);
    expect(r.hours).toBeNull();
  });

  it('completely-unknown staff with completely-unknown text → unknown', () => {
    const r = resolveStaffDayCell(
      { staffName: 'NeverSeenBefore', dayCell: 'wibble' },
      staffMapping(),
    );
    expect(r.status).toBe('unknown');
    expect(r.unknownText).toBe(true);
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
