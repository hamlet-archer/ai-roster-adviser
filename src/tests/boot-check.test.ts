import { describe, expect, it } from 'vitest';

import { type BootCheckDeps, BootCheckError, runBootCheck } from '../boot-check.js';
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

interface MemoryIO {
  readonly load: () => SheetShapeMapping | null;
  readonly save: (m: SheetShapeMapping) => void;
  saved: SheetShapeMapping | null;
  initial: SheetShapeMapping | null;
}

function memoryMappingIO(initial: SheetShapeMapping | null = null): MemoryIO {
  const io: MemoryIO = {
    initial,
    saved: null,
    load: () => io.saved ?? io.initial,
    save: (m: SheetShapeMapping) => {
      io.saved = m;
    },
  };
  return io;
}

const ENV: BootCheckDeps['env'] = {
  ROSTER_SHEET_ID: 'test-sheet',
  ROSTER_SHEET_RANGE: 'A1:E200',
  ROSTER_SHEET_MAPPING_PATH: '/tmp/this-is-overridden-by-mappingIO',
};

// Minimal vertical-layout fixture used across boot-check tests.
const GOOD_GRID: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> = [
  ['', 'Sally'],
  ['Date', 'Day'],
  ['2025-11-10', 'Work'],
];

describe('runBootCheck — first-boot path', () => {
  it('probes the sheet and persists a fresh vertical mapping', async () => {
    const adapter = makeStubAdapter(() => ({ values: GOOD_GRID }));
    const io = memoryMappingIO();
    const result = await runBootCheck({ adapter, env: ENV, mappingIO: io });
    expect(result.sheetId).toBe('test-sheet');
    expect(result.mapping.dateColumn).toBe(0);
    expect(Object.keys(result.mapping.staffColumns)).toEqual(['Sally']);
    expect(io.saved).not.toBeNull();
    expect(io.saved!.headerHash).toBe(hashHeaderRows(GOOD_GRID[0], GOOD_GRID[1]));
  });

  it('fails loud when values.get returns no rows', async () => {
    const adapter = makeStubAdapter(() => ({ values: [] }));
    const io = memoryMappingIO();
    await expect(runBootCheck({ adapter, env: ENV, mappingIO: io })).rejects.toBeInstanceOf(
      BootCheckError,
    );
  });

  it('fails loud at sheet-shape-probe step when column A has no dates', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [
        ['', 'Sally'],
        ['Date', 'Day'],
        ['Not a date', 'Work'],
      ],
    }));
    const io = memoryMappingIO();
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      expect((err as BootCheckError).diagnostic.step).toBe('sheet-shape-probe');
      expect((err as BootCheckError).diagnostic.detail?.reason).toBe('no_date_rows');
    }
  });

  it('fails loud at sheet-shape-probe step when row 1 has no staff labels', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [
        ['', ''],
        ['Date', 'Day'],
        ['2025-11-10', 'Work'],
      ],
    }));
    const io = memoryMappingIO();
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      expect((err as BootCheckError).diagnostic.step).toBe('sheet-shape-probe');
      expect((err as BootCheckError).diagnostic.detail?.reason).toBe('no_staff_labels');
    }
  });

  it('fails loud with ranked causes when values.get throws', async () => {
    const adapter = makeStubAdapter(() => {
      throw new Error('forbidden: caller does not have permission');
    });
    const io = memoryMappingIO();
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      const d = (err as BootCheckError).diagnostic;
      expect(d.step).toBe('sheets-values-get');
      expect(d.ranked_causes.length).toBeGreaterThanOrEqual(3);
      expect(d.ranked_causes[0]).toMatch(/Refresh token expired or revoked/);
    }
  });
});

describe('runBootCheck — persisted-mapping path', () => {
  const goodMapping: SheetShapeMapping = {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRows(GOOD_GRID[0], GOOD_GRID[1]),
    dateColumn: 0,
    staffColumns: { Sally: { day: 1 } },
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-21T19:11:05Z',
  };

  it('passes when the live header rows match the persisted hash', async () => {
    const adapter = makeStubAdapter(() => ({ values: GOOD_GRID }));
    const io = memoryMappingIO(goodMapping);
    const result = await runBootCheck({ adapter, env: ENV, mappingIO: io });
    expect(result.mapping).toEqual(goodMapping);
    // No re-probe: nothing saved.
    expect(io.saved).toBeNull();
  });

  it('fails loud (AP-6, no auto-reprobe) when live hash differs', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [
        ['', 'Sandy'], // different staff name in row 1
        ['Date', 'Day'],
        ['2025-11-10', 'Work'],
      ],
    }));
    const io = memoryMappingIO(goodMapping);
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      const d = (err as BootCheckError).diagnostic;
      expect(d.step).toBe('sheet-shape-header-hash');
      // io.saved is still null — explicit AP-6 contract: no auto-reprobe.
      expect(io.saved).toBeNull();
    }
  });

  it('reports the mapping-load step with reason on a corrupt persisted mapping', async () => {
    const adapter = makeStubAdapter(() => ({ values: GOOD_GRID }));
    const io: BootCheckDeps['mappingIO'] = {
      load: () => {
        throw new Error('mapping YAML parse failed: line 1: malformed');
      },
      save: () => {
        throw new Error('should not have been called');
      },
    };
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      expect((err as BootCheckError).diagnostic.step).toBe('sheet-shape-mapping-load');
    }
  });
});
