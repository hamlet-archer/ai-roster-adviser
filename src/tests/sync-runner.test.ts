import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RosterCache } from '../cache.js';
import {
  GoogleSheetsUserOauthAdapter,
  type ValuesGetOptions,
  type ValuesGetResult,
} from '../google-sheets-user-oauth-adapter.js';
import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRow,
  SHEET_MAPPING_SCHEMA_VERSION,
  type SheetShapeMapping,
} from '../sheet-shape-mapping.js';
import {
  resolveCell,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function fixtureMapping(headerRow: readonly string[]): SheetShapeMapping {
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRow(headerRow),
    personColumn: 0,
    personColumnHeader: headerRow[0] ?? 'Name',
    dateColumns: headerRow.slice(1).map((h, i) => ({
      columnIndex: i + 1,
      headerText: h,
      dateIso: h,
    })),
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-13T14:11:05Z',
  };
}

describe('resolveCell — privacy filter precedence', () => {
  const mapping = fixtureMapping(['Name', '2026-05-13']);

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

describe('runSyncCycle', () => {
  let dir: string;
  let cache: RosterCache;
  const headerRow = ['Name', '2026-05-13', '2026-05-14'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-sync-'));
    cache = new RosterCache({ path: join(dir, 'roster.db') });
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts every resolvable cell from a typical W&L grid', async () => {
    const mapping = fixtureMapping(headerRow);
    const adapter = makeStubAdapter(() => ({
      values: [
        headerRow,
        ['Sally', 'W', 'L'],
        ['Chloe', 'half', 'W'],
        ['Kelvin', '', 'W'],
      ],
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(report.status).toBe('ok');
    expect(report.cellsUpserted).toBe(5); // 6 cells, 1 empty (Kelvin 2026-05-13)
    expect(report.cellsSkipped).toBe(1);
    expect(cache.getEntry({ person: 'Sally', dateIso: '2026-05-13' })?.status).toBe('working');
    expect(cache.getEntry({ person: 'Sally', dateIso: '2026-05-14' })?.status).toBe('leave');
    expect(cache.getEntry({ person: 'Chloe', dateIso: '2026-05-13' })?.status).toBe('half-day');
    expect(cache.getEntry({ person: 'Kelvin', dateIso: '2026-05-13' })).toBeNull();
    expect(cache.getEntry({ person: 'Kelvin', dateIso: '2026-05-14' })?.status).toBe('working');
  });

  it('privacy filter: cell text containing sick → status sick, never leaks notes', async () => {
    const mapping = fixtureMapping(headerRow);
    const adapter = makeStubAdapter(() => ({
      values: [headerRow, ['Sally', 'sick - migraine', 'W']],
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(report.status).toBe('ok');
    const entry = cache.getEntry({ person: 'Sally', dateIso: '2026-05-13' });
    expect(entry?.status).toBe('sick');
    expect(entry?.hours).toBeNull();
    // PRIVACY-CRITICAL ASSERTION: the cell text "migraine" must not appear
    // anywhere in the persisted payload_json or any derived field.
    expect(JSON.stringify(entry)).not.toMatch(/migraine/i);
    // The sick_collapsed flag is set as structural metadata (not free-text).
    const payload = JSON.parse(entry?.payloadJson ?? '{}') as { sick_collapsed?: boolean };
    expect(payload.sick_collapsed).toBe(true);
  });

  it('aborts with header_hash_mismatch when the live header drifts (AP-6, no auto-reprobe)', async () => {
    const mapping = fixtureMapping(['Name', '2026-05-13']);
    const adapter = makeStubAdapter(() => ({
      values: [['Name', '2026-05-14'], ['Sally', 'W']],
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(report.status).toBe('header_hash_mismatch');
    expect(report.cellsUpserted).toBe(0);
    expect(report.errorMessage).toMatch(/header hash/);
    expect(cache.getEntry({ person: 'Sally', dateIso: '2026-05-14' })).toBeNull();
  });

  it('returns sheet_error when values.get throws (AP-2 — no cache corruption)', async () => {
    const mapping = fixtureMapping(headerRow);
    const adapter = makeStubAdapter(() => {
      throw new Error('rate-limited by Google');
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(report.status).toBe('sheet_error');
    expect(report.errorMessage).toMatch(/rate-limited/);
  });

  it('skips empty rows + records unknown_text reason without leaking the cell text', async () => {
    const mapping = fixtureMapping(headerRow);
    const adapter = makeStubAdapter(() => ({
      values: [headerRow, ['Sally', 'Maybe later', 'W'], ['', '', '']],
    }));
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(report.status).toBe('ok');
    expect(report.cellsUpserted).toBe(1);
    const unknown = report.perCellOutcomes.find((o) => o.reason === 'unknown_text');
    expect(unknown).toBeDefined();
    expect(unknown?.person).toBe('Sally');
    expect(unknown?.dateIso).toBe('2026-05-13');
    // Privacy: detail must not carry the cell text.
    expect(JSON.stringify(unknown)).not.toMatch(/maybe later/i);
  });

  it('updates sync_state with the live header hash after a successful cycle', async () => {
    const mapping = fixtureMapping(headerRow);
    const adapter = makeStubAdapter(() => ({
      values: [headerRow, ['Sally', 'W', 'L']],
    }));
    const before = cache.getSyncState(ROSTER_SYNC_SOURCE);
    expect(before).toBeNull();
    await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    const after = cache.getSyncState(ROSTER_SYNC_SOURCE);
    expect(after?.headerHash).toBe(mapping.headerHash);
    expect(after?.lastSyncIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does NOT update sync_state when the cycle aborts on hash mismatch', async () => {
    const mapping = fixtureMapping(['Name', '2026-05-13']);
    const adapter = makeStubAdapter(() => ({
      values: [['Name', '2026-05-14'], ['Sally', 'W']],
    }));
    await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId: 'test',
      sheetRange: 'A1:ZZ',
    });
    expect(cache.getSyncState(ROSTER_SYNC_SOURCE)).toBeNull();
  });
});
