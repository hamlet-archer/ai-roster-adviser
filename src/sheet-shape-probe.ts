/**
 * First-boot sheet-shape probe — vertical layout.
 *
 * The W&L Log uses a vertical layout: dates run down column A, staff-name
 * spanning labels sit in row 1, sub-headers (`Day` / `Night` / `Day Value` /
 * `Night Value` / `Overtime` / `Annual Leave` / `Remarks`) sit in row 2.
 * Each staff owns columns from their row-1 label up to (but not including)
 * the next staff label.
 *
 * v2 (G6.15.1, 2026-05-21) replaces the v1 horizontal probe that shipped
 * in v0 of this agent. v1 looked for date headers in row 1 + person names
 * in column A — the inverse of the live sheet's actual layout, which is
 * why deploy on 2026-05-18 fatalled with `no_date_columns`. This rewrite
 * is the structural fix.
 *
 * Heuristics (deliberate; documented so operators know what to edit):
 *
 *   1. The date column is column 0 (column A in Sheets). The probe verifies
 *      at least one data row has a parseable date in column 0; otherwise it
 *      throws `no_date_rows`.
 *   2. Row 1 carries staff spanning labels. Any non-empty cell in row 1 is
 *      treated as the start of a staff region; that region runs to the
 *      column before the next staff label (or the end of row 1).
 *   3. Within a staff region, each row-2 cell is matched against
 *      `KNOWN_SUB_COLUMN_NAMES`. Empty row-2 cells are silently skipped
 *      (spacer columns are common). Any non-empty row-2 cell that doesn't
 *      match one of the 7 known names throws `unexpected_subcolumn_count`
 *      — operators must rename the cell or extend the known set.
 *   4. Date parsing reuses the v0 cell-to-ISO helper (ISO / UK-style /
 *      US-style / Sheets-serial-numeric) so the column-A dates can be in
 *      any format the operator types.
 *
 * The probe MUST find at least one staff with at least one matched
 * sub-column — emitting an empty `staffColumns` would yield a useless
 * mapping that the sync runner (G6.15.3) couldn't iterate.
 */

import {
  DEFAULT_STATUS_VALUE_MAP,
  hashHeaderRows,
  KNOWN_SUB_COLUMN_NAMES,
  SHEET_MAPPING_SCHEMA_VERSION,
  type SheetShapeMapping,
  type StaffSubColumns,
} from './sheet-shape-mapping.js';

/**
 * Google Sheets stores dates as days since 1899-12-30 (the "Lotus 1-2-3"
 * epoch, kept for Excel compatibility). Convert serial → ISO date.
 */
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30); // 1899-12-30 UTC
const DAY_MS = 24 * 60 * 60 * 1000;

function sheetsSerialToIso(serial: number): string | null {
  // Sheets serials for dates are non-negative integers (real numbers
  // represent time-of-day fractions; we round to the day). Reject
  // anything outside a sensible roster window (1990 → 2100).
  if (!Number.isFinite(serial) || serial < 32874 || serial > 73415) {
    return null;
  }
  const ms = SHEETS_EPOCH_MS + Math.floor(serial) * DAY_MS;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseDateString(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // YYYY-MM-DD.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const yyyy = Number(m[1]!);
    const mm = Number(m[2]!);
    const dd = Number(m[3]!);
    if (validateYmd(yyyy, mm, dd)) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }
  // YYYY/MM/DD — the W&L Log uses this in column A (e.g. `2025/11/10`).
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) {
    const yyyy = Number(m[1]!);
    const mm = Number(m[2]!);
    const dd = Number(m[3]!);
    if (validateYmd(yyyy, mm, dd)) return `${m[1]!.padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
    return null;
  }
  // DD/MM/YYYY or DD/MM/YY (UK-style, deliberately first).
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (m) {
    let dd = Number(m[1]!);
    let mm = Number(m[2]!);
    let yyyy = Number(m[3]!);
    if (m[3]!.length === 2) yyyy = yyyy + 2000;
    if (validateYmd(yyyy, mm, dd)) return `${String(yyyy).padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
    // Fall back to US-style if UK-style was invalid.
    dd = Number(m[2]!);
    mm = Number(m[1]!);
    if (validateYmd(yyyy, mm, dd)) return `${String(yyyy).padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
    return null;
  }
  return null;
}

function validateYmd(yyyy: number, mm: number, dd: number): boolean {
  if (yyyy < 1990 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    d.getUTCFullYear() === yyyy &&
    d.getUTCMonth() === mm - 1 &&
    d.getUTCDate() === dd
  );
}

/** Convert one cell to an ISO date (or null if not a date). */
export function cellToIsoDate(cell: string | number | boolean | null | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') {
    return sheetsSerialToIso(cell);
  }
  if (typeof cell === 'boolean') return null;
  return parseDateString(String(cell));
}

export type ProbeReason =
  | 'empty_header'
  | 'no_date_rows'
  | 'no_staff_labels'
  | 'unexpected_subcolumn_count';

export class SheetShapeProbeError extends Error {
  constructor(
    message: string,
    public readonly reason: ProbeReason,
  ) {
    super(message);
    this.name = 'SheetShapeProbeError';
  }
}

export interface ProbeInput {
  /**
   * The first ~N rows of the sheet (row 0 = staff labels, row 1 = sub-headers,
   * rows 2+ = data rows with dates in column 0). The probe needs at least
   * two header rows plus one data row to verify date presence.
   */
  readonly values: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  /** ISO timestamp of the probe — defaults to `new Date().toISOString()`. */
  readonly probedAt?: string;
}

interface StaffStart {
  readonly name: string;
  readonly startCol: number;
}

function findStaffStarts(row1: ReadonlyArray<string | number | boolean | null>): StaffStart[] {
  const starts: StaffStart[] = [];
  for (let i = 0; i < row1.length; i++) {
    const raw = row1[i];
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (text === '') continue;
    starts.push({ name: text, startCol: i });
  }
  return starts;
}

/**
 * Build a `SheetShapeMapping` from a value grid. Throws
 * `SheetShapeProbeError` when the grid is too small, column A has no
 * dates, row 1 has no staff labels, or any staff region carries an
 * unrecognised sub-header.
 */
export function probeSheetShape(input: ProbeInput): SheetShapeMapping {
  if (input.values.length < 2) {
    throw new SheetShapeProbeError(
      'value grid needs at least 2 header rows (row 1 = staff labels, row 2 = sub-headers)',
      'empty_header',
    );
  }
  const row1 = input.values[0] ?? [];
  const row2 = input.values[1] ?? [];
  if (row1.length === 0 || row2.length === 0) {
    throw new SheetShapeProbeError('header rows are empty', 'empty_header');
  }
  const dataRows = input.values.slice(2);

  // 1. Verify column A carries dates in the data rows.
  const datesFound = dataRows.some((r) => cellToIsoDate(r[0] ?? null) !== null);
  if (!datesFound) {
    throw new SheetShapeProbeError(
      'column A has no parseable date cells in the sampled data rows; check the sheet layout (dates should be in column A, ISO / UK-style / numeric)',
      'no_date_rows',
    );
  }

  // 2. Find staff spanning labels in row 1.
  const staffStarts = findStaffStarts(row1);
  if (staffStarts.length === 0) {
    throw new SheetShapeProbeError(
      'row 1 has no staff spanning labels — sheet should carry a staff name (Sally, Chloe, …) over each group of sub-columns',
      'no_staff_labels',
    );
  }

  // 3. Map each staff's sub-columns via row 2.
  const staffColumns: Record<string, StaffSubColumns> = {};
  for (let i = 0; i < staffStarts.length; i++) {
    const { name, startCol } = staffStarts[i]!;
    const endCol = i + 1 < staffStarts.length ? staffStarts[i + 1]!.startCol : row2.length;
    const cols: Record<string, number> = {};
    for (let c = startCol; c < endCol; c++) {
      const sub = row2[c];
      if (sub === null || sub === undefined) continue;
      const text = String(sub).trim();
      if (text === '') continue;
      const key = KNOWN_SUB_COLUMN_NAMES[text];
      if (!key) {
        throw new SheetShapeProbeError(
          `sub-header "${text}" under staff "${name}" at column ${c} is not one of the 7 known names (Day / Night / Day Value / Night Value / Overtime / Annual Leave / Remarks)`,
          'unexpected_subcolumn_count',
        );
      }
      if (key in cols) {
        throw new SheetShapeProbeError(
          `duplicate sub-header "${text}" under staff "${name}" at column ${c}`,
          'unexpected_subcolumn_count',
        );
      }
      cols[key] = c;
    }
    if (Object.keys(cols).length === 0) {
      throw new SheetShapeProbeError(
        `staff "${name}" has no recognised sub-columns in row 2 between columns ${startCol} and ${endCol - 1}`,
        'unexpected_subcolumn_count',
      );
    }
    staffColumns[name] = cols as StaffSubColumns;
  }

  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRows(row1, row2),
    dateColumn: 0,
    staffColumns,
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: input.probedAt ?? new Date().toISOString(),
  };
}
