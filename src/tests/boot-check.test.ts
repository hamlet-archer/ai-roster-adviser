import { describe, expect, it } from 'vitest';

import {
  BootCheckError,
  type BootCheckDeps,
  runBootCheck,
} from '../boot-check.js';
import {
  GoogleSheetsUserOauthAdapter,
  type ValuesGetOptions,
  type ValuesGetResult,
} from '../google-sheets-user-oauth-adapter.js';
import {
  hashHeaderRow,
  type SheetShapeMapping,
  SHEET_MAPPING_SCHEMA_VERSION,
  DEFAULT_STATUS_VALUE_MAP,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  ROSTER_SHEET_RANGE: 'A1:E1',
  ROSTER_SHEET_MAPPING_PATH: '/tmp/this-is-overridden-by-mappingIO',
};

describe('runBootCheck — first-boot path', () => {
  it('probes the sheet and persists a fresh mapping', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [['Name', '2026-05-13', '2026-05-14']],
    }));
    const io = memoryMappingIO();
    const result = await runBootCheck({ adapter, env: ENV, mappingIO: io });
    expect(result.sheetId).toBe('test-sheet');
    expect(result.mapping.dateColumns).toHaveLength(2);
    expect(io.saved).not.toBeNull();
    expect(io.saved!.headerHash).toBe(
      hashHeaderRow(['Name', '2026-05-13', '2026-05-14']),
    );
  });

  it('fails loud when the sheet header row is empty', async () => {
    const adapter = makeStubAdapter(() => ({ values: [] }));
    const io = memoryMappingIO();
    await expect(runBootCheck({ adapter, env: ENV, mappingIO: io })).rejects.toBeInstanceOf(
      BootCheckError,
    );
  });

  it('fails loud when no date columns are detectable', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [['Name', 'Notes', 'Other']],
    }));
    const io = memoryMappingIO();
    try {
      await runBootCheck({ adapter, env: ENV, mappingIO: io });
      expect.fail('expected BootCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootCheckError);
      expect((err as BootCheckError).diagnostic.step).toBe('sheet-shape-probe');
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
    headerHash: hashHeaderRow(['Name', '2026-05-13']),
    personColumn: 0,
    personColumnHeader: 'Name',
    dateColumns: [
      { columnIndex: 1, headerText: '2026-05-13', dateIso: '2026-05-13' },
    ],
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-13T14:11:05Z',
  };

  it('passes when the live header matches the persisted hash', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [['Name', '2026-05-13']],
    }));
    const io = memoryMappingIO(goodMapping);
    const result = await runBootCheck({ adapter, env: ENV, mappingIO: io });
    expect(result.mapping).toEqual(goodMapping);
    // No re-probe: nothing saved.
    expect(io.saved).toBeNull();
  });

  it('fails loud (AP-6, no auto-reprobe) when live hash differs', async () => {
    const adapter = makeStubAdapter(() => ({
      values: [['Name', '2026-05-14']], // different date column
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
    const adapter = makeStubAdapter(() => ({ values: [['Name', '2026-05-13']] }));
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
