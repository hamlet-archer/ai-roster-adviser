/**
 * First-boot sheet-shape probe.
 *
 * Reads the W&L Log header row, identifies the person column + date
 * columns, and emits a typed `SheetShapeMapping` ready to persist.
 *
 * Heuristics (deliberate; documented so operators know what to edit):
 *
 *   1. The FIRST column is assumed to be the person column. Override
 *      by editing `personColumn` in the persisted mapping after the
 *      probe.
 *   2. Date columns are identified by parsing each header cell against
 *      a small set of date formats common in Google Sheets:
 *         - `YYYY-MM-DD` (ISO; the canonical form)
 *         - `DD/MM/YYYY` and `DD/MM/YY` (UK-style; the W&L log uses this)
 *         - `MM/DD/YYYY` and `MM/DD/YY` (US-style; deliberately listed
 *           AFTER UK-style so ambiguous values like `04/05/2026` resolve
 *           the way Kelvin's W&L sheet uses them)
 *         - A Sheets date-serial number (Sheets stores dates as days
 *           since 1899-12-30 when `valueRenderOption=UNFORMATTED_VALUE`).
 *           This is the most reliable form when the operator hasn't
 *           formatted the header row as text.
 *   3. The status-value-to-enum map is seeded from the defaults in
 *      `sheet-shape-mapping.ts`. The probe does NOT inspect cell values;
 *      operators extend the map by hand after first deploy.
 *
 * The probe MUST find at least one date column — emitting zero dates
 * would yield a useless mapping that the boot self-check should reject
 * (the alternative is silently producing a degenerate roster).
 */

import {
  DEFAULT_STATUS_VALUE_MAP,
  SHEET_MAPPING_SCHEMA_VERSION,
  hashHeaderRow,
  type DateColumnEntry,
  type SheetShapeMapping,
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
  // DD/MM/YYYY or DD/MM/YY (UK-style, deliberately first).
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (m) {
    let dd = Number(m[1]!);
    let mm = Number(m[2]!);
    let yyyy = Number(m[3]!);
    if (m[3]!.length === 2) yyyy = yyyy + 2000;
    if (validateYmd(yyyy, mm, dd)) return `${pad2(yyyy).padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
    // Fall back to US-style if UK-style was invalid.
    dd = Number(m[2]!);
    mm = Number(m[1]!);
    if (validateYmd(yyyy, mm, dd)) return `${pad2(yyyy).padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
    return null;
  }
  return null;
}

function validateYmd(yyyy: number, mm: number, dd: number): boolean {
  if (yyyy < 1990 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  // Round-trip via Date to reject impossible combos (Feb 30, etc.).
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    d.getUTCFullYear() === yyyy &&
    d.getUTCMonth() === mm - 1 &&
    d.getUTCDate() === dd
  );
}

/** Convert one header cell to an ISO date (or null if not a date). */
export function headerCellToIsoDate(cell: string | number | boolean | null): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') {
    return sheetsSerialToIso(cell);
  }
  if (typeof cell === 'boolean') return null;
  return parseDateString(String(cell));
}

export class SheetShapeProbeError extends Error {
  constructor(
    message: string,
    public readonly reason: 'empty_header' | 'no_date_columns',
  ) {
    super(message);
    this.name = 'SheetShapeProbeError';
  }
}

export interface ProbeInput {
  /** The header row from the live sheet. */
  readonly headerRow: ReadonlyArray<string | number | boolean | null>;
  /** ISO timestamp of the probe — defaults to `new Date().toISOString()`. */
  readonly probedAt?: string;
}

/**
 * Build a `SheetShapeMapping` from a header row. Throws
 * `SheetShapeProbeError` when the row is empty or has no date columns.
 */
export function probeSheetShape(input: ProbeInput): SheetShapeMapping {
  if (input.headerRow.length === 0) {
    throw new SheetShapeProbeError('header row is empty', 'empty_header');
  }
  const headerStrings = input.headerRow.map((c) => (c === null || c === undefined ? '' : String(c)));
  const personColumnHeader = headerStrings[0] ?? '';
  const dateColumns: DateColumnEntry[] = [];
  for (let i = 1; i < input.headerRow.length; i++) {
    const cell = input.headerRow[i] ?? null;
    const iso = headerCellToIsoDate(cell);
    if (iso) {
      dateColumns.push({
        columnIndex: i,
        headerText: headerStrings[i] ?? '',
        dateIso: iso,
      });
    }
  }
  if (dateColumns.length === 0) {
    throw new SheetShapeProbeError(
      'header row has no recognisable date columns; check sheet format',
      'no_date_columns',
    );
  }
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: hashHeaderRow(headerStrings),
    personColumn: 0,
    personColumnHeader,
    dateColumns,
    statusValueToEnumMap: { ...DEFAULT_STATUS_VALUE_MAP },
    probedAt: input.probedAt ?? new Date().toISOString(),
  };
}
