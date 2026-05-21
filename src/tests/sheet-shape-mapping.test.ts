import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRows,
  KNOWN_SUB_COLUMN_NAMES,
  loadMappingFromFile,
  parseMappingYaml,
  renderMappingYaml,
  resolveMappingPath,
  saveMappingToFile,
  SHEET_MAPPING_SCHEMA_VERSION,
  SheetShapeMappingError,
  SUB_COLUMN_KEYS,
  type SheetShapeMapping,
} from '../sheet-shape-mapping.js';

function mkMapping(over: Partial<SheetShapeMapping> = {}): SheetShapeMapping {
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: 'a'.repeat(64),
    dateColumn: 0,
    staffColumns: {
      Sally: { day: 3, night: 4, remarks: 5 },
      Chloe: { day: 6, night: 7, dayValue: 8, nightValue: 9, overtime: 10, annualLeave: 11, remarks: 12 },
    },
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-21T19:11:05Z',
    ...over,
  };
}

describe('schema-version constant', () => {
  it('is bumped to 2 (vertical layout)', () => {
    // G6.15.1 contract: v1 → v2 so persisted v1 mappings get re-probed.
    expect(SHEET_MAPPING_SCHEMA_VERSION).toBe(2);
  });
});

describe('KNOWN_SUB_COLUMN_NAMES + SUB_COLUMN_KEYS', () => {
  it('covers all 7 expected sub-columns', () => {
    expect(SUB_COLUMN_KEYS).toHaveLength(7);
    expect(new Set(Object.values(KNOWN_SUB_COLUMN_NAMES))).toEqual(new Set(SUB_COLUMN_KEYS));
  });

  it('uses exact-case row-2 text as keys (case-sensitive lookup)', () => {
    expect(KNOWN_SUB_COLUMN_NAMES['Day']).toBe('day');
    expect(KNOWN_SUB_COLUMN_NAMES['Annual Leave']).toBe('annualLeave');
    expect(KNOWN_SUB_COLUMN_NAMES['day']).toBeUndefined();
    expect(KNOWN_SUB_COLUMN_NAMES['annual leave']).toBeUndefined();
  });
});

describe('hashHeaderRows', () => {
  it('produces a 64-char hex digest', () => {
    const h = hashHeaderRows(['', '', '', 'Sally'], ['Date', 'DOW', '', 'Day']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('absorbs cosmetic edits (case + trailing spaces)', () => {
    const a = hashHeaderRows(['', '', '', 'Sally'], ['Date', 'DOW', '', 'Day']);
    const b = hashHeaderRows(['', '', '', '  sally  '], ['DATE', 'dow', '', 'day']);
    expect(a).toBe(b);
  });

  it('differs when a staff label changes', () => {
    const a = hashHeaderRows(['', '', '', 'Sally'], ['Date', 'DOW', '', 'Day']);
    const b = hashHeaderRows(['', '', '', 'Sandy'], ['Date', 'DOW', '', 'Day']);
    expect(a).not.toBe(b);
  });

  it('differs when row 2 picks up a new sub-header', () => {
    const a = hashHeaderRows(['', '', '', 'Sally'], ['Date', 'DOW', '', 'Day']);
    const b = hashHeaderRows(['', '', '', 'Sally'], ['Date', 'DOW', '', 'Day', 'Night']);
    expect(a).not.toBe(b);
  });

  it('differs when an empty trailing column appears (column count is significant)', () => {
    const a = hashHeaderRows(['Sally'], ['Day']);
    const b = hashHeaderRows(['Sally'], ['Day', '']);
    expect(a).not.toBe(b);
  });
});

describe('renderMappingYaml + parseMappingYaml', () => {
  it('round-trips a fixture mapping', () => {
    const m = mkMapping();
    const yaml = renderMappingYaml(m);
    const parsed = parseMappingYaml(yaml);
    expect(parsed).toEqual(m);
  });

  it('emits sub-column keys in canonical order (day, night, dayValue, …)', () => {
    // Insertion-shuffled input should still serialise in the canonical
    // SUB_COLUMN_KEYS order for diff stability.
    const m = mkMapping({
      staffColumns: {
        Sally: { remarks: 5, day: 3, night: 4 } as never,
      },
    });
    const yaml = renderMappingYaml(m);
    const idxDay = yaml.indexOf('    day: ');
    const idxNight = yaml.indexOf('    night: ');
    const idxRemarks = yaml.indexOf('    remarks: ');
    expect(idxDay).toBeGreaterThan(-1);
    expect(idxNight).toBeGreaterThan(idxDay);
    expect(idxRemarks).toBeGreaterThan(idxNight);
  });

  it('sorts statusValueToEnumMap keys for diff stability', () => {
    const m = mkMapping({
      statusValueToEnumMap: { z: 'leave', a: 'working' },
    });
    const yaml = renderMappingYaml(m);
    const aIdx = yaml.indexOf('  a: ');
    const zIdx = yaml.indexOf('  z: ');
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('rejects a v1 mapping (version mismatch — re-probe required)', () => {
    const m = mkMapping();
    const text = renderMappingYaml(m).replace(/version: 2/, 'version: 1');
    expect(() => parseMappingYaml(text)).toThrow(SheetShapeMappingError);
  });

  it('rejects an unknown sub-column key', () => {
    const m = mkMapping({
      staffColumns: {
        Sally: { day: 3, made_up_key: 99 as unknown as never } as never,
      },
    });
    const yaml = renderMappingYaml(m);
    // renderMappingYaml drops unknown keys silently (canonical order
    // emit); inject the bad key by hand to test the parser guard.
    const tampered = yaml.replace('  Sally:\n    day: 3\n', '  Sally:\n    day: 3\n    made_up_key: 99\n');
    expect(() => parseMappingYaml(tampered)).toThrow(/unknown sub-column|invalid_staff/);
  });

  it('rejects a staff entry with no sub-columns', () => {
    const tampered = renderMappingYaml(mkMapping()).replace(
      /  Sally:\n    day: 3\n    night: 4\n    remarks: 5\n/,
      '  Sally: {}\n',
    );
    expect(() => parseMappingYaml(tampered)).toThrow(/at least one sub-column|invalid_staff/);
  });

  it('rejects an invalid status enum value', () => {
    const yaml = renderMappingYaml(
      mkMapping({ statusValueToEnumMap: { w: 'made-up-status' as unknown as never } }),
    );
    expect(() => parseMappingYaml(yaml)).toThrow(/invalid_status_enum|invalid status/);
  });

  it('rejects an empty staffColumns map', () => {
    const tampered = renderMappingYaml(mkMapping()).replace(/staffColumns:\n[\s\S]*?statusValueToEnumMap:/, 'staffColumns: {}\nstatusValueToEnumMap:');
    expect(() => parseMappingYaml(tampered)).toThrow(/at least one staff/);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseMappingYaml('::: not yaml :::')).toThrow(SheetShapeMappingError);
  });

  it('rejects a negative dateColumn', () => {
    const tampered = renderMappingYaml(mkMapping()).replace(/dateColumn: 0/, 'dateColumn: -1');
    expect(() => parseMappingYaml(tampered)).toThrow(/dateColumn/);
  });
});

describe('save + load round-trip on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-mapping-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a mapping file at mode 0600', () => {
    const path = join(dir, 'sheet-mapping.yaml');
    const m = mkMapping();
    saveMappingToFile(path, m);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('version: 2');
  });

  it('loadMappingFromFile returns null when the file is missing', () => {
    expect(loadMappingFromFile(join(dir, 'absent.yaml'))).toBeNull();
  });

  it('loadMappingFromFile round-trips a saved mapping', () => {
    const path = join(dir, 'sheet-mapping.yaml');
    const m = mkMapping();
    saveMappingToFile(path, m);
    expect(loadMappingFromFile(path)).toEqual(m);
  });

  it('saveMappingToFile creates parent directories on first write', () => {
    const path = join(dir, 'nested', 'deeper', 'sheet-mapping.yaml');
    const m = mkMapping();
    saveMappingToFile(path, m);
    expect(statSync(path).isFile()).toBe(true);
  });
});

describe('resolveMappingPath', () => {
  it('honours ROSTER_SHEET_MAPPING_PATH when set', () => {
    expect(resolveMappingPath({ ROSTER_SHEET_MAPPING_PATH: '/tmp/foo.yaml' })).toBe('/tmp/foo.yaml');
  });
  it('falls back to the production default when env var is unset', () => {
    expect(resolveMappingPath({})).toBe('/etc/roster-adviser/sheet-mapping.yaml');
  });
});
