import { describe, expect, it } from 'vitest';

import { headerCellToIsoDate, probeSheetShape, SheetShapeProbeError } from '../sheet-shape-probe.js';
import { SHEET_MAPPING_SCHEMA_VERSION } from '../sheet-shape-mapping.js';

describe('headerCellToIsoDate', () => {
  it('parses ISO date strings', () => {
    expect(headerCellToIsoDate('2026-05-13')).toBe('2026-05-13');
  });

  it('parses UK-style DD/MM/YYYY', () => {
    expect(headerCellToIsoDate('13/05/2026')).toBe('2026-05-13');
  });

  it('parses UK-style DD/MM/YY (assumes 2000+)', () => {
    expect(headerCellToIsoDate('13/05/26')).toBe('2026-05-13');
  });

  it('falls back to US-style when UK-style is invalid', () => {
    // 13/13/2026 → UK reads "13th of month 13" (invalid); fallback flips to MM/DD.
    expect(headerCellToIsoDate('13/13/2026')).toBeNull(); // both interpretations invalid
    expect(headerCellToIsoDate('05/13/2026')).toBe('2026-05-13'); // UK valid as 5th of May
  });

  it('parses Sheets date-serial numbers (1899-12-30 epoch)', () => {
    // 2026-05-13 - 1899-12-30 = 46155 days.
    const serial = Math.floor(
      (Date.UTC(2026, 4, 13) - Date.UTC(1899, 11, 30)) / 86_400_000,
    );
    expect(headerCellToIsoDate(serial)).toBe('2026-05-13');
  });

  it('returns null for empty / null / boolean / nonsense strings', () => {
    expect(headerCellToIsoDate(null)).toBeNull();
    expect(headerCellToIsoDate('')).toBeNull();
    expect(headerCellToIsoDate(true)).toBeNull();
    expect(headerCellToIsoDate('not a date')).toBeNull();
    expect(headerCellToIsoDate('Mon')).toBeNull();
  });

  it('rejects Feb 30 / month 13 (round-trip validation)', () => {
    expect(headerCellToIsoDate('2026-02-30')).toBeNull();
    expect(headerCellToIsoDate('2026-13-01')).toBeNull();
  });
});

describe('probeSheetShape', () => {
  it('builds a mapping from a typical W&L header row', () => {
    const headerRow = ['Name', '2026-05-13', '2026-05-14', '2026-05-15'];
    const mapping = probeSheetShape({ headerRow, probedAt: '2026-05-13T14:11:05Z' });
    expect(mapping.version).toBe(SHEET_MAPPING_SCHEMA_VERSION);
    expect(mapping.personColumn).toBe(0);
    expect(mapping.personColumnHeader).toBe('Name');
    expect(mapping.dateColumns).toHaveLength(3);
    expect(mapping.dateColumns[0]).toEqual({
      columnIndex: 1,
      headerText: '2026-05-13',
      dateIso: '2026-05-13',
    });
    expect(mapping.headerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mapping.statusValueToEnumMap.w).toBe('working');
    expect(mapping.probedAt).toBe('2026-05-13T14:11:05Z');
  });

  it('skips non-date columns silently', () => {
    const mapping = probeSheetShape({
      headerRow: ['Name', '2026-05-13', 'Notes', '2026-05-14'],
    });
    expect(mapping.dateColumns.map((d) => d.columnIndex)).toEqual([1, 3]);
  });

  it('throws when the header row is empty', () => {
    expect(() => probeSheetShape({ headerRow: [] })).toThrow(SheetShapeProbeError);
  });

  it('throws when no date columns are found', () => {
    expect(() => probeSheetShape({ headerRow: ['Name', 'Notes', 'Other'] })).toThrow(
      /no_date_columns|no recognisable/,
    );
  });

  it('handles a mix of string and numeric date headers', () => {
    const serial = Math.floor(
      (Date.UTC(2026, 4, 14) - Date.UTC(1899, 11, 30)) / 86_400_000,
    );
    const mapping = probeSheetShape({
      headerRow: ['Name', '2026-05-13', serial],
    });
    expect(mapping.dateColumns).toHaveLength(2);
    expect(mapping.dateColumns[1]!.dateIso).toBe('2026-05-14');
  });
});
