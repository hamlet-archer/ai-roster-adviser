import { describe, expect, it } from 'vitest';

import { cellToIsoDate, probeSheetShape, SheetShapeProbeError } from '../sheet-shape-probe.js';
import {
  hashHeaderRows,
  SHEET_MAPPING_SCHEMA_VERSION,
} from '../sheet-shape-mapping.js';

describe('cellToIsoDate', () => {
  it('parses ISO date strings', () => {
    expect(cellToIsoDate('2026-05-13')).toBe('2026-05-13');
  });

  it('parses YYYY/MM/DD (the format the W&L sheet uses in column A)', () => {
    expect(cellToIsoDate('2025/11/10')).toBe('2025-11-10');
    expect(cellToIsoDate('2025/1/3')).toBe('2025-01-03');
  });

  it('parses UK-style DD/MM/YYYY', () => {
    expect(cellToIsoDate('13/05/2026')).toBe('2026-05-13');
  });

  it('parses UK-style DD/MM/YY (assumes 2000+)', () => {
    expect(cellToIsoDate('13/05/26')).toBe('2026-05-13');
  });

  it('falls back to US-style when UK-style is invalid', () => {
    expect(cellToIsoDate('13/13/2026')).toBeNull();
    expect(cellToIsoDate('05/13/2026')).toBe('2026-05-13');
  });

  it('parses Sheets date-serial numbers (1899-12-30 epoch)', () => {
    const serial = Math.floor(
      (Date.UTC(2026, 4, 13) - Date.UTC(1899, 11, 30)) / 86_400_000,
    );
    expect(cellToIsoDate(serial)).toBe('2026-05-13');
  });

  it('returns null for empty / null / boolean / nonsense strings', () => {
    expect(cellToIsoDate(null)).toBeNull();
    expect(cellToIsoDate('')).toBeNull();
    expect(cellToIsoDate(true)).toBeNull();
    expect(cellToIsoDate('not a date')).toBeNull();
    expect(cellToIsoDate('Mon')).toBeNull();
  });

  it('rejects Feb 30 / month 13 (round-trip validation)', () => {
    expect(cellToIsoDate('2026-02-30')).toBeNull();
    expect(cellToIsoDate('2026-13-01')).toBeNull();
  });
});

describe('probeSheetShape — happy path', () => {
  // Fixture inspired by the actual W&L Log row 4 evidence
  // (`Log!A3:N5`, per the parent G6.15 backlog annotation):
  //   row 4 = [2025/11/10, Mon, "", Work, -, "IB access\nPond filter",
  //            Full, 1, -, 0, 0.3, 5.1, ...]
  // The probe needs to recognise:
  //   • date column = 0 (column A)
  //   • Sally at row1[3], owning columns 3..5 with sub-headers
  //     Day / Night / Remarks in row 2 (the sub-columns Sally
  //     actually uses)
  //   • Chloe at row1[6], owning columns 6..12 with the full 7
  //     sub-headers in row 2.
  const ROW1 = [
    '', '', '',
    'Sally', '', '',
    'Chloe', '', '', '', '', '', '',
  ];
  const ROW2 = [
    'Date', 'DOW', '',
    'Day', 'Night', 'Remarks',
    'Day', 'Night', 'Day Value', 'Night Value', 'Overtime', 'Annual Leave', 'Remarks',
  ];
  const ROW3_SAMPLE = [
    'Carried Forward', '', '',
    '', '', '',
    '', '', '', '', '', '0.0', '5.0',
  ];
  const ROW4_SAMPLE = [
    '2025/11/10', 'Mon', '',
    'Work', '-', 'IB access\nPond filter',
    'Full', 1, '-', 0, 0.3, 5.1, '',
  ];

  it('parses the row-3/row-4 evidence into dateColumn:0 + per-staff sub-columns', () => {
    const mapping = probeSheetShape({
      values: [ROW1, ROW2, ROW3_SAMPLE, ROW4_SAMPLE],
      probedAt: '2026-05-21T19:11:05Z',
    });
    expect(mapping.version).toBe(SHEET_MAPPING_SCHEMA_VERSION);
    expect(mapping.dateColumn).toBe(0);
    // G6.15.2: known staff (Sally / Chloe) carry seeded
    // statusValueToEnumMap defaults; sub-column indices are unchanged.
    expect(mapping.staffColumns.Sally).toMatchObject({ day: 3, night: 4, remarks: 5 });
    expect(mapping.staffColumns.Chloe).toMatchObject({
      day: 6,
      night: 7,
      dayValue: 8,
      nightValue: 9,
      overtime: 10,
      annualLeave: 11,
      remarks: 12,
    });
    expect(mapping.staffColumns.Sally?.statusValueToEnumMap?.work).toBe('working');
    expect(mapping.staffColumns.Sally?.statusValueToEnumMap?.pet).toBe('leave-other');
    expect(mapping.staffColumns.Chloe?.statusValueToEnumMap?.full).toBe('working');
    expect(mapping.staffColumns.Chloe?.statusValueToEnumMap?.half).toBe('half-day');
    expect(mapping.headerHash).toBe(hashHeaderRows(ROW1, ROW2));
    expect(mapping.probedAt).toBe('2026-05-21T19:11:05Z');
    expect(mapping.statusValueToEnumMap.w).toBe('working');
  });

  it('accepts dates in DD/MM/YYYY in column A too', () => {
    const mapping = probeSheetShape({
      values: [
        ['', 'Sally'],
        ['Date', 'Day'],
        ['10/11/2025', 'Work'],
      ],
    });
    expect(mapping.staffColumns.Sally).toMatchObject({ day: 1 });
  });

  it('default probedAt is a fresh ISO timestamp when omitted', () => {
    const mapping = probeSheetShape({
      values: [['', 'Sally'], ['Date', 'Day'], ['2025-11-10', 'Work']],
    });
    expect(mapping.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('probeSheetShape — fail-loud cases', () => {
  it('throws empty_header when the value grid has fewer than 2 rows', () => {
    expect(() => probeSheetShape({ values: [] })).toThrow(SheetShapeProbeError);
    expect(() => probeSheetShape({ values: [['Sally']] })).toThrow(/empty_header|at least 2 header/);
  });

  it('throws empty_header when both header rows are empty', () => {
    expect(() => probeSheetShape({ values: [[], []] })).toThrow(/header rows are empty|empty_header/);
  });

  it('throws no_date_rows when column A has no parseable dates (the 2026-05-18 failure mode)', () => {
    try {
      probeSheetShape({
        values: [
          ['', 'Sally'],
          ['Date', 'Day'],
          ['Not a date', 'Work'],
          ['Also not', 'Work'],
        ],
      });
      expect.fail('expected SheetShapeProbeError');
    } catch (err) {
      expect(err).toBeInstanceOf(SheetShapeProbeError);
      expect((err as SheetShapeProbeError).reason).toBe('no_date_rows');
    }
  });

  it('throws no_staff_labels when row 1 is all blank', () => {
    try {
      probeSheetShape({
        values: [
          ['', '', ''],
          ['Date', 'DOW', 'Day'],
          ['2025-11-10', 'Mon', 'Work'],
        ],
      });
      expect.fail('expected SheetShapeProbeError');
    } catch (err) {
      expect(err).toBeInstanceOf(SheetShapeProbeError);
      expect((err as SheetShapeProbeError).reason).toBe('no_staff_labels');
    }
  });

  it('throws unexpected_subcolumn_count for an unknown sub-header under a staff', () => {
    try {
      probeSheetShape({
        values: [
          ['', 'Sally'],
          ['Date', 'Wibble'],
          ['2025-11-10', 'Work'],
        ],
      });
      expect.fail('expected SheetShapeProbeError');
    } catch (err) {
      expect(err).toBeInstanceOf(SheetShapeProbeError);
      expect((err as SheetShapeProbeError).reason).toBe('unexpected_subcolumn_count');
    }
  });

  it('throws unexpected_subcolumn_count for duplicate sub-headers under one staff', () => {
    try {
      probeSheetShape({
        values: [
          ['', 'Sally', '', ''],
          ['Date', 'Day', 'Night', 'Day'],
          ['2025-11-10', 'Work', '-', 'Work'],
        ],
      });
      expect.fail('expected SheetShapeProbeError');
    } catch (err) {
      expect(err).toBeInstanceOf(SheetShapeProbeError);
      expect((err as SheetShapeProbeError).reason).toBe('unexpected_subcolumn_count');
    }
  });

  it('throws unexpected_subcolumn_count when a staff has zero recognised sub-columns', () => {
    try {
      probeSheetShape({
        values: [
          ['', 'Sally', '', 'Chloe'],
          ['Date', '', '', 'Day'],
          ['2025-11-10', 'Work', '-', 'Full'],
        ],
      });
      expect.fail('expected SheetShapeProbeError');
    } catch (err) {
      expect(err).toBeInstanceOf(SheetShapeProbeError);
      expect((err as SheetShapeProbeError).reason).toBe('unexpected_subcolumn_count');
    }
  });
});

describe('probeSheetShape — edge cases', () => {
  it('treats every non-empty row-1 cell as a staff boundary (consecutive labels supported)', () => {
    const mapping = probeSheetShape({
      values: [
        ['', 'Sally', 'Chloe'],
        ['Date', 'Day', 'Day'],
        ['2025-11-10', 'Work', 'Full'],
      ],
    });
    expect(Object.keys(mapping.staffColumns)).toEqual(['Sally', 'Chloe']);
    expect(mapping.staffColumns.Sally).toMatchObject({ day: 1 });
    expect(mapping.staffColumns.Chloe).toMatchObject({ day: 2 });
  });

  it('trims whitespace from staff names + sub-header text', () => {
    const mapping = probeSheetShape({
      values: [
        ['', '  Sally  '],
        ['Date', '  Day  '],
        ['2025-11-10', 'Work'],
      ],
    });
    expect(Object.keys(mapping.staffColumns)).toEqual(['Sally']);
    expect(mapping.staffColumns.Sally).toMatchObject({ day: 1 });
  });

  it('silently skips empty row-2 cells inside a staff span (spacer columns OK)', () => {
    const mapping = probeSheetShape({
      values: [
        ['', 'Sally', '', '', '', '', '', '', 'Chloe'],
        ['Date', 'Day', '', 'Night', '', 'Remarks', '', '', 'Day'],
        ['2025-11-10', 'Work', '', '-', '', 'IB access', '', '', 'Full'],
      ],
    });
    expect(mapping.staffColumns.Sally).toMatchObject({ day: 1, night: 3, remarks: 5 });
    expect(mapping.staffColumns.Chloe).toMatchObject({ day: 8 });
  });

  it('does NOT seed per-staff statusValueToEnumMap for unknown staff names', () => {
    const mapping = probeSheetShape({
      values: [
        ['', 'NotSallyOrChloe'],
        ['Date', 'Day'],
        ['2025-11-10', 'Work'],
      ],
    });
    expect(mapping.staffColumns.NotSallyOrChloe).toEqual({ day: 1 });
    expect(mapping.staffColumns.NotSallyOrChloe?.statusValueToEnumMap).toBeUndefined();
  });
});
