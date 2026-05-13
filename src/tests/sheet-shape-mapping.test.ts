import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRow,
  loadMappingFromFile,
  parseMappingYaml,
  renderMappingYaml,
  resolveMappingPath,
  saveMappingToFile,
  SHEET_MAPPING_SCHEMA_VERSION,
  SheetShapeMappingError,
  type SheetShapeMapping,
} from '../sheet-shape-mapping.js';

function mkMapping(over: Partial<SheetShapeMapping> = {}): SheetShapeMapping {
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: 'a'.repeat(64),
    personColumn: 0,
    personColumnHeader: 'Name',
    dateColumns: [
      { columnIndex: 1, headerText: '2026-05-13', dateIso: '2026-05-13' },
    ],
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: '2026-05-13T14:11:05Z',
    ...over,
  };
}

describe('hashHeaderRow', () => {
  it('produces a 64-char hex digest', () => {
    const h = hashHeaderRow(['Name', '2026-05-13']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('absorbs cosmetic edits (case + trailing spaces)', () => {
    const a = hashHeaderRow(['Name', '2026-05-13']);
    const b = hashHeaderRow(['  name  ', '  2026-05-13  ']);
    expect(a).toBe(b);
  });

  it('differs when a date column changes', () => {
    const a = hashHeaderRow(['Name', '2026-05-13']);
    const b = hashHeaderRow(['Name', '2026-05-14']);
    expect(a).not.toBe(b);
  });

  it('differs when an empty trailing column appears (column count is significant)', () => {
    const a = hashHeaderRow(['Name', '2026-05-13']);
    const b = hashHeaderRow(['Name', '2026-05-13', '']);
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

  it('rejects a version mismatch', () => {
    const m = mkMapping();
    const text = renderMappingYaml(m).replace(/version: 1/, 'version: 99');
    expect(() => parseMappingYaml(text)).toThrow(SheetShapeMappingError);
  });

  it('rejects an invalid status enum value', () => {
    const yaml = renderMappingYaml(
      mkMapping({ statusValueToEnumMap: { w: 'made-up-status' as unknown as never } }),
    );
    expect(() => parseMappingYaml(yaml)).toThrow(/invalid_status_enum|invalid status/);
  });

  it('rejects an invalid date format in a date column', () => {
    const yaml = renderMappingYaml(
      mkMapping({
        dateColumns: [
          { columnIndex: 1, headerText: 'bogus', dateIso: '13-05-2026' },
        ],
      }),
    );
    expect(() => parseMappingYaml(yaml)).toThrow(SheetShapeMappingError);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseMappingYaml('::: not yaml :::')).toThrow(SheetShapeMappingError);
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
    expect(text).toContain('version: 1');
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
