/**
 * sync-runner tests — G6.15.3 vertical-layout iteration.
 *
 * Covers:
 *   - `resolveCell` (legacy shape-agnostic resolver, kept for backwards-compat)
 *   - `resolveStaffDayCell` (G6.15.5 priority rules — privacy /
 *     per-staff map / global fallback / Chloe numeric / unknown;
 *     AL balance no longer overrides status)
 *   - `runSyncCycle` (G6.15.3 grid iteration — happy path, header hash
 *     drift, sheet error, privacy never leaks, empty rows skipped,
 *     unknown_text path, sync_state write)
 *   - `hoursForStatus`
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RosterCache } from '../cache.js';
import {
  GoogleSheetsUserOauthAdapter,
  type ValuesGetOptions,
  type ValuesGetResult,
} from '../google-sheets-user-oauth-adapter.js';
import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRows,
  SHEET_MAPPING_SCHEMA_VERSION,
  type SheetShapeMapping,
} from '../sheet-shape-mapping.js';
import {
  hoursForStatus,
  renderSyncSummary,
  resolveCell,
  resolveStaffDayCell,
  ROSTER_DEFAULT_HOURS_HALF_DAY,
  ROSTER_DEFAULT_HOURS_WORKING,
  ROSTER_SYNC_SOURCE,
  runSyncCycle,
} from '../sync-runner.js';

function makeStubAdapter(
  handler: (opts: ValuesGetOptions) => ValuesGetResult | Promise<ValuesGetResult>,
): GoogleSheetsUserOauthAdapter {
  return new GoogleSheetsUserOauthAdapter({
    spreadsheets: {
      values: {
        get: async (params: { spreadsheetId: string; range: string }) => {
          const res = await handler({
            spreadsheetId: params.spreadsheetId,
            range: params.range,
          });
          return { data: { values: res.values } };
        },
      },
    },
  } as any);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function simpleMapping(): SheetShapeMapping {
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

const WL_ROW1 = ['', '', '', 'Sally', '', '', 'Chloe', '', '', '', '', '', ''];
const WL_ROW2 = [
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

function wlMapping(): SheetShapeMapping {
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRows(WL_ROW1, WL_ROW2),
    dateColumn: 0,
    staffColumns: {
      Sally: {
        day: 3,
        night: 4,
        remarks: 5,
        statusValueToEnumMap: {
          full: 'working',
          half: 'half-day',
          off: 'not-working',
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

// ---------------------------------------------------------------------------
// resolveCell — legacy shape-agnostic resolver (kept for backwards-compat)
// ---------------------------------------------------------------------------

describe('resolveCell — privacy filter precedence', () => {
  const mapping = simpleMapping();

  it('collapses any /sick/i cell text to status sick with hours null', () => {
    expect(resolveCell('sick', mapping)).toEqual({
      status: 'sick',
      hours: null,
      sickCollapsed: true,
      unknownText: false,
    });
    expect(resolveCell('sick - migraine', mapping)).toEqual({
      status: 'sick',
      hours: null,
      sickCollapsed: true,
      unknownText: false,
    });
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

  it('returns null for non-working statuses (incl. the new leave-other / not-working)', () => {
    expect(hoursForStatus('leave')).toBeNull();
    expect(hoursForStatus('leave-other')).toBeNull();
    expect(hoursForStatus('sick')).toBeNull();
    expect(hoursForStatus('public-holiday')).toBeNull();
    expect(hoursForStatus('not-working')).toBeNull();
    expect(hoursForStatus('unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveStaffDayCell — G6.15.5 priority rules (AL override removed)
// ---------------------------------------------------------------------------

describe('resolveStaffDayCell — G6.15.5 priority rules', () => {
  it('Sally Full → working (per-staff map; 2026-05-21 rewrite — live W&L convention)', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: 'Full' }, wlMapping());
    expect(r.status).toBe('working');
    expect(r.hours).toBe(ROSTER_DEFAULT_HOURS_WORKING);
    expect(r.unknownText).toBe(false);
  });

  it('Sally Half → half-day', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: 'Half' }, wlMapping());
    expect(r.status).toBe('half-day');
  });

  it('Sally Off → not-working', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: 'Off' }, wlMapping());
    expect(r.status).toBe('not-working');
  });

  it('Sally - → not-working', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: '-' }, wlMapping());
    expect(r.status).toBe('not-working');
  });

  it('Sally empty → not-working (per-staff empty-string default)', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: '' }, wlMapping());
    expect(r.status).toBe('not-working');
  });

  it('Sally Leave → leave (falls through to global default; per-staff map does not redefine)', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: 'Leave' }, wlMapping());
    expect(r.status).toBe('leave');
  });

  it('Chloe Full → working', () => {
    const r = resolveStaffDayCell({ staffName: 'Chloe', dayCell: 'Full' }, wlMapping());
    expect(r.status).toBe('working');
  });

  it('Chloe Half → half-day', () => {
    const r = resolveStaffDayCell({ staffName: 'Chloe', dayCell: 'Half' }, wlMapping());
    expect(r.status).toBe('half-day');
  });

  it('Chloe Off → not-working', () => {
    const r = resolveStaffDayCell({ staffName: 'Chloe', dayCell: 'Off' }, wlMapping());
    expect(r.status).toBe('not-working');
  });

  it('Chloe numeric Day > 0 → working', () => {
    const r = resolveStaffDayCell({ staffName: 'Chloe', dayCell: 1 }, wlMapping());
    expect(r.status).toBe('working');
  });

  it('Chloe numeric Day === 0 → not-working', () => {
    const r = resolveStaffDayCell({ staffName: 'Chloe', dayCell: 0 }, wlMapping());
    expect(r.status).toBe('not-working');
  });

  // G6.15.5: Annual Leave is a running balance, not a per-day leave flag.
  // The Day cell drives status; the AL number is metadata only.
  it('Annual Leave > 0 does NOT override the Day cell — Day=Full + AL=5.1 → working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Full', annualLeaveCell: 5.1 },
      wlMapping(),
    );
    expect(r.status).toBe('working');
  });

  it('Annual Leave numeric-string balance does NOT trigger leave — Day=Full + AL="3.2" → working', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: 'Full', annualLeaveCell: '3.2' },
      wlMapping(),
    );
    expect(r.status).toBe('working');
  });

  it('Day=Off + AL=2 still resolves via the per-staff map (Chloe Off → not-working)', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'Off', annualLeaveCell: 2 },
      wlMapping(),
    );
    expect(r.status).toBe('not-working');
  });

  it('privacy filter beats per-staff map — /sick/i in Day cell with any AL', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Chloe', dayCell: 'sick', annualLeaveCell: 1 },
      wlMapping(),
    );
    expect(r.status).toBe('sick');
    expect(r.sickCollapsed).toBe(true);
  });

  it('privacy filter on Remarks cell also triggers sick', () => {
    const r = resolveStaffDayCell(
      { staffName: 'Sally', dayCell: 'Full', remarksCell: 'feeling sicker today' },
      wlMapping(),
    );
    expect(r.status).toBe('sick');
    expect(r.sickCollapsed).toBe(true);
  });

  it('unknown staff falls back to the global statusValueToEnumMap', () => {
    const m = wlMapping();
    const m2: SheetShapeMapping = {
      ...m,
      staffColumns: { ...m.staffColumns, Unknown: { day: 99 } },
    };
    const r = resolveStaffDayCell({ staffName: 'Unknown', dayCell: 'W' }, m2);
    expect(r.status).toBe('working');
  });

  it('unknown text → unknown + unknownText:true', () => {
    const r = resolveStaffDayCell({ staffName: 'Sally', dayCell: 'Yetanotherthing' }, wlMapping());
    expect(r.status).toBe('unknown');
    expect(r.unknownText).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSyncCycle — G6.15.3 grid iteration
// ---------------------------------------------------------------------------

describe('runSyncCycle — happy path + grid iteration', () => {
  let dir: string;
  let cache: RosterCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-sync-'));
    cache = new RosterCache({ path: join(dir, 'roster.db') });
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function gridForWl(dataRows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>) {
    return [WL_ROW1, WL_ROW2, ...dataRows];
  }

  it('upserts every resolvable (staff, date) row from a 2-day vertical grid', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
        ['2025-11-11', 'Tue', '', 'Off', '-', '', 'Half', 0, '-', 0, 0, 0, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    // 2 dates × 2 staff = 4 upserts.
    expect(report.cellsUpserted).toBe(4);
    expect(report.cellsSkipped).toBe(0);
    expect(cache.getEntry({ person: 'Sally', dateIso: '2025-11-10' })?.status).toBe('working');
    expect(cache.getEntry({ person: 'Chloe', dateIso: '2025-11-10' })?.status).toBe('working');
    expect(cache.getEntry({ person: 'Sally', dateIso: '2025-11-11' })?.status).toBe('not-working');
    expect(cache.getEntry({ person: 'Chloe', dateIso: '2025-11-11' })?.status).toBe('half-day');
  });

  it('skips rows where column A is not a parseable date (section headers etc.)', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        ['Carried Forward', '', '', '', '', '', '', '', '', '', '0.0', '5.0', ''],
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    // Carried Forward row skipped silently; only 2 upserts (1 date × 2 staff).
    expect(report.cellsUpserted).toBe(2);
  });

  it('AL balance does NOT override the Day cell at sync time — Day=Full + AL=5.1 → working', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        // Chloe Day says "Full" and Annual Leave = 5.1 (running balance); per
        // G6.15.5 the Day cell wins, and the AL value lands in payload only.
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 5.1, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    const chloe = cache.getEntry({ person: 'Chloe', dateIso: '2025-11-10' });
    expect(chloe?.status).toBe('working');
    const payload = JSON.parse(chloe?.payloadJson ?? '{}') as { annual_leave_remaining?: number };
    expect(payload.annual_leave_remaining).toBe(5.1);
  });

  it('AL balance is recorded in payload_json but absent when the cell is empty / "-"', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        // Sally AL='-' (not a number); Chloe AL=0 (still a number).
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    const sally = cache.getEntry({ person: 'Sally', dateIso: '2025-11-10' });
    const sallyPayload = JSON.parse(sally?.payloadJson ?? '{}') as {
      annual_leave_remaining?: number;
    };
    expect(sallyPayload.annual_leave_remaining).toBeUndefined();
    const chloe = cache.getEntry({ person: 'Chloe', dateIso: '2025-11-10' });
    const chloePayload = JSON.parse(chloe?.payloadJson ?? '{}') as {
      annual_leave_remaining?: number;
    };
    expect(chloePayload.annual_leave_remaining).toBe(0);
  });

  it('privacy filter — /sick/i in Remarks → status=sick, no notes leak', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        ['2025-11-10', 'Mon', '', 'Full', '-', 'sick - migraine', 'Full', 1, '-', 0, 0.3, 0, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    const sally = cache.getEntry({ person: 'Sally', dateIso: '2025-11-10' });
    expect(sally?.status).toBe('sick');
    expect(sally?.hours).toBeNull();
    // PRIVACY-CRITICAL: "migraine" must not appear in any persisted field.
    expect(JSON.stringify(sally)).not.toMatch(/migraine/i);
    const payload = JSON.parse(sally?.payloadJson ?? '{}') as { sick_collapsed?: boolean };
    expect(payload.sick_collapsed).toBe(true);
  });

  it('aborts with header_hash_mismatch when row 0 or row 1 drifts (AP-6, no auto-reprobe)', async () => {
    const mapping = wlMapping();
    // Tamper row 1: rename Chloe → Cloe; mapping hash will no longer match.
    const tamperedRow1 = [...WL_ROW1];
    const chloeIdx = tamperedRow1.indexOf('Chloe');
    tamperedRow1[chloeIdx] = 'Cloe';
    const adapter = makeStubAdapter(() => ({
      values: [
        tamperedRow1,
        WL_ROW2,
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ],
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('header_hash_mismatch');
    expect(report.cellsUpserted).toBe(0);
    expect(cache.getEntry({ person: 'Sally', dateIso: '2025-11-10' })).toBeNull();
  });

  it('returns sheet_error when values.get throws (AP-2 — no cache corruption)', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => {
      throw new Error('rate-limited by Google');
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('sheet_error');
    expect(report.errorMessage).toMatch(/rate-limited/);
  });

  it('returns sheet_error when values.get returns < 2 rows', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({ values: [['just one row']] }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('sheet_error');
    expect(report.errorMessage).toMatch(/at least 2 header rows/);
  });

  it('records unknown_text without leaking the cell text into detail', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        ['2025-11-10', 'Mon', '', 'Maybe later', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ]),
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(report.status).toBe('ok');
    const unknown = report.perCellOutcomes.find((o) => o.reason === 'unknown_text');
    expect(unknown).toBeDefined();
    expect(unknown?.person).toBe('Sally');
    expect(unknown?.dateIso).toBe('2025-11-10');
    expect(JSON.stringify(unknown)).not.toMatch(/maybe later/i);
  });

  it('updates sync_state with the live header hash after a successful cycle', async () => {
    const mapping = wlMapping();
    const adapter = makeStubAdapter(() => ({
      values: gridForWl([
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ]),
    }));
    expect(cache.getSyncState(ROSTER_SYNC_SOURCE)).toBeNull();
    await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    const after = cache.getSyncState(ROSTER_SYNC_SOURCE);
    expect(after?.headerHash).toBe(mapping.headerHash);
    expect(after?.lastSyncIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does NOT update sync_state when the cycle aborts on hash mismatch', async () => {
    const mapping = wlMapping();
    const tamperedRow1 = [...WL_ROW1];
    tamperedRow1[tamperedRow1.indexOf('Sally')] = 'Sandy';
    const adapter = makeStubAdapter(() => ({
      values: [
        tamperedRow1,
        WL_ROW2,
        ['2025-11-10', 'Mon', '', 'Full', '-', '', 'Full', 1, '-', 0, 0.3, 0, ''],
      ],
    }));
    await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
      traceId: '01900000-0000-7000-8000-000000000001',
    });
    expect(cache.getSyncState(ROSTER_SYNC_SOURCE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderSyncSummary — trace_id propagation (observability audit 2026-05-24)
// ---------------------------------------------------------------------------

describe('renderSyncSummary — trace_id field', () => {
  it('includes trace_id in the JSON output matching the report', () => {
    const traceId = '01900000-0000-7000-8000-000000000002';
    const summary = renderSyncSummary({
      traceId,
      startedAtIso: '2026-05-24T00:00:00.000Z',
      endedAtIso: '2026-05-24T00:00:01.000Z',
      status: 'ok',
      headerHashOk: true,
      cellsUpserted: 10,
      cellsSkipped: 2,
      perCellOutcomes: [],
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed.trace_id).toBe(traceId);
    expect(parsed.msg).toBe('sync_cycle_complete');
  });

  it('includes trace_id even on error status', () => {
    const traceId = '01900000-0000-7000-8000-000000000003';
    const summary = renderSyncSummary({
      traceId,
      startedAtIso: '2026-05-24T00:00:00.000Z',
      endedAtIso: '2026-05-24T00:00:01.000Z',
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      perCellOutcomes: [],
      errorMessage: 'rate-limited',
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed.trace_id).toBe(traceId);
    expect(parsed.level).toBe('error');
  });
});
