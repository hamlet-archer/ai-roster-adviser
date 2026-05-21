/**
 * Typed shape mapping for the W&L Log Google Sheet.
 *
 * The W&L sheet is laid out vertically: dates run down column A; row 1
 * carries staff-name spanning labels (e.g. `Sally` over a group of columns,
 * then `Chloe`); row 2 carries per-staff sub-headers from a known set
 * (`Day` / `Night` / `Day Value` / `Night Value` / `Overtime` / `Annual Leave`
 * / `Remarks`). Each staff "owns" the columns from their row-1 label up to
 * (but not including) the next staff label.
 *
 * v2 (G6.15.1, 2026-05-21) replaces the previous horizontal layout
 * (personColumn + dateColumns) — that probe shipped in v1 + failed in
 * production on 2026-05-18 with `no_date_columns` against the real sheet,
 * which is actually vertical. The schema version is bumped 1 → 2 so any
 * persisted v1 mapping on the VPS gets re-probed cleanly on next boot.
 *
 * The persisted file lives at `/etc/roster-adviser/sheet-mapping.yaml` by
 * default (env override `ROSTER_SHEET_MAPPING_PATH`). Operators may edit
 * `statusValueToEnumMap` after the first probe to refine the mapping;
 * G6.15.2 will move that map per-staff.
 *
 * Privacy invariant (`project_roster_semantics`): this module is the
 * persisted shape; the cache layer (`cache.ts`) enforces no-`notes` at
 * the row schema; the sync runner (G6.15.3) will enforce no-`notes` in
 * cell→row translation. The mapping itself never carries `notes`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import yaml from 'js-yaml';

import type { RosterStatus } from './cache.js';
import { ROSTER_STATUS_VALUES } from './cache.js';

export const SHEET_MAPPING_SCHEMA_VERSION = 2;

/** Typed sub-column keys carried by `StaffSubColumns`. */
export type SubColumnKey =
  | 'day'
  | 'night'
  | 'dayValue'
  | 'nightValue'
  | 'overtime'
  | 'annualLeave'
  | 'remarks';

/**
 * Recognised sub-header strings (row 2) → typed sub-column key. Exact-match
 * lookup; an unknown sub-header in a staff's span fails the probe loud per
 * AP-6. Whitespace is trimmed before lookup.
 */
export const KNOWN_SUB_COLUMN_NAMES: Readonly<Record<string, SubColumnKey>> = Object.freeze({
  Day: 'day',
  Night: 'night',
  'Day Value': 'dayValue',
  'Night Value': 'nightValue',
  Overtime: 'overtime',
  'Annual Leave': 'annualLeave',
  Remarks: 'remarks',
});

export const SUB_COLUMN_KEYS: readonly SubColumnKey[] = [
  'day',
  'night',
  'dayValue',
  'nightValue',
  'overtime',
  'annualLeave',
  'remarks',
];

/**
 * Zero-based column indices for one staff's sub-columns. Each field is
 * optional — staff may not use every sub-column (Sally uses `Day` / `Night`
 * / `Remarks`; Chloe uses the full numeric set). At least one field must
 * be present; the probe rejects an all-empty staff span.
 */
export interface StaffSubColumns {
  readonly day?: number;
  readonly night?: number;
  readonly dayValue?: number;
  readonly nightValue?: number;
  readonly overtime?: number;
  readonly annualLeave?: number;
  readonly remarks?: number;
}

export interface SheetShapeMapping {
  readonly version: number;
  /** SHA256 hex of the canonicalised header rows (row 1 + row 2). */
  readonly headerHash: string;
  /** Zero-based column index containing dates. Canonically 0 (column A). */
  readonly dateColumn: number;
  /**
   * Per-staff sub-column index map. Keyed by exact staff-name text from
   * row 1 (trimmed). Order is staff-label-order in row 1.
   */
  readonly staffColumns: Readonly<Record<string, StaffSubColumns>>;
  /**
   * Cell-text-lowercased → status enum, applied uniformly across staff
   * for now. G6.15.2 will replace this with a per-staff map under
   * `staffColumns[name].statusValueToEnumMap`; this field stays as the
   * fallback default.
   */
  readonly statusValueToEnumMap: Readonly<Record<string, RosterStatus>>;
  /** ISO timestamp of the probe that wrote this mapping. */
  readonly probedAt: string;
}

const UNIT_SEPARATOR = '';

function canonicaliseRow(row: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return row
    .map((cell) =>
      cell === null || cell === undefined ? '' : String(cell).trim().toLowerCase(),
    )
    .join(UNIT_SEPARATOR);
}

/**
 * SHA256 of the canonicalised header rows (row 1 + row 2 joined).
 *
 * Canonicalisation: trim + lowercase each cell, join with `` (unit
 * separator), then join row 1 + row 2 with `\n`. The lowercase + trim
 * absorbs cosmetic edits (case, trailing spaces) the operator may make in
 * Sheets without triggering an AP-6 fail-loud; the unit-separator join
 * survives any literal cell content. Empty trailing cells are preserved
 * — column count change IS a schema-drift signal.
 */
export function hashHeaderRows(
  row1: ReadonlyArray<string | number | boolean | null | undefined>,
  row2: ReadonlyArray<string | number | boolean | null | undefined>,
): string {
  const canonical = `${canonicaliseRow(row1)}\n${canonicaliseRow(row2)}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Seed for the status-value-to-enum map. Lowercase keys; operators may
 * extend (e.g. add `'al'` if the sheet uses an "Annual Leave" abbreviation).
 *
 * Privacy: any cell text that contains the substring `sick` (case-insensitive)
 * also collapses to `'sick'` at sync time — that's enforced in the sync
 * runner (G6.15.3), not here.
 */
export const DEFAULT_STATUS_VALUE_MAP: Readonly<Record<string, RosterStatus>> = Object.freeze({
  '': 'unknown',
  w: 'working',
  wk: 'working',
  working: 'working',
  on: 'working',
  yes: 'working',
  y: 'working',
  '✓': 'working',
  l: 'leave',
  lv: 'leave',
  leave: 'leave',
  al: 'leave',
  off: 'leave',
  h: 'half-day',
  half: 'half-day',
  'half-day': 'half-day',
  'half day': 'half-day',
  '½': 'half-day',
  ph: 'public-holiday',
  'public holiday': 'public-holiday',
  'public-holiday': 'public-holiday',
  sick: 'sick',
  s: 'sick',
});

/**
 * Render the mapping as a YAML string the operator can hand-edit on disk.
 *
 * Stable ordering: top-level keys appear in `version`, `headerHash`,
 * `dateColumn`, `staffColumns`, `statusValueToEnumMap`, `probedAt` order.
 * Within `staffColumns`, staff names are emitted in insertion order
 * (matching row-1 left-to-right). Within each staff, sub-column keys are
 * emitted in canonical `SUB_COLUMN_KEYS` order. The enum-map keys are
 * sorted for diff stability across re-probes.
 */
export function renderMappingYaml(mapping: SheetShapeMapping): string {
  const orderedStaffColumns: Record<string, Record<string, number>> = {};
  for (const [name, cols] of Object.entries(mapping.staffColumns)) {
    const ordered: Record<string, number> = {};
    for (const key of SUB_COLUMN_KEYS) {
      const v = cols[key];
      if (typeof v === 'number') {
        ordered[key] = v;
      }
    }
    orderedStaffColumns[name] = ordered;
  }
  const sortedStatusMap: Record<string, RosterStatus> = {};
  for (const k of Object.keys(mapping.statusValueToEnumMap).sort()) {
    sortedStatusMap[k] = mapping.statusValueToEnumMap[k]!;
  }
  return yaml.dump(
    {
      version: mapping.version,
      headerHash: mapping.headerHash,
      dateColumn: mapping.dateColumn,
      staffColumns: orderedStaffColumns,
      statusValueToEnumMap: sortedStatusMap,
      probedAt: mapping.probedAt,
    },
    { lineWidth: 120, sortKeys: false },
  );
}

export class SheetShapeMappingError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'parse_failed'
      | 'version_mismatch'
      | 'missing_field'
      | 'invalid_status_enum'
      | 'invalid_staff_columns',
  ) {
    super(message);
    this.name = 'SheetShapeMappingError';
  }
}

/**
 * Parse YAML + validate every field. Throws `SheetShapeMappingError` with
 * a typed reason on any structural problem.
 */
export function parseMappingYaml(text: string): SheetShapeMapping {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new SheetShapeMappingError(
      `mapping YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      'parse_failed',
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new SheetShapeMappingError('mapping must be a YAML mapping', 'parse_failed');
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== SHEET_MAPPING_SCHEMA_VERSION) {
    throw new SheetShapeMappingError(
      `mapping schema version ${String(r.version)} != expected ${SHEET_MAPPING_SCHEMA_VERSION}`,
      'version_mismatch',
    );
  }
  for (const k of ['headerHash', 'dateColumn', 'staffColumns', 'statusValueToEnumMap', 'probedAt'] as const) {
    if (!(k in r)) {
      throw new SheetShapeMappingError(`mapping missing field: ${k}`, 'missing_field');
    }
  }
  if (typeof r.headerHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.headerHash)) {
    throw new SheetShapeMappingError('headerHash must be SHA256 hex', 'missing_field');
  }
  if (typeof r.dateColumn !== 'number' || r.dateColumn < 0 || !Number.isInteger(r.dateColumn)) {
    throw new SheetShapeMappingError('dateColumn must be a non-negative integer', 'missing_field');
  }
  if (!r.staffColumns || typeof r.staffColumns !== 'object' || Array.isArray(r.staffColumns)) {
    throw new SheetShapeMappingError('staffColumns must be a mapping', 'invalid_staff_columns');
  }
  const staffColumns: Record<string, StaffSubColumns> = {};
  for (const [name, rawCols] of Object.entries(r.staffColumns as Record<string, unknown>)) {
    if (!rawCols || typeof rawCols !== 'object' || Array.isArray(rawCols)) {
      throw new SheetShapeMappingError(
        `staffColumns["${name}"] must be a mapping`,
        'invalid_staff_columns',
      );
    }
    const cols: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawCols as Record<string, unknown>)) {
      if (!(SUB_COLUMN_KEYS as readonly string[]).includes(k)) {
        throw new SheetShapeMappingError(
          `staffColumns["${name}"] has unknown sub-column key: ${k}`,
          'invalid_staff_columns',
        );
      }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new SheetShapeMappingError(
          `staffColumns["${name}"].${k} must be a non-negative integer`,
          'invalid_staff_columns',
        );
      }
      cols[k] = v;
    }
    if (Object.keys(cols).length === 0) {
      throw new SheetShapeMappingError(
        `staffColumns["${name}"] must have at least one sub-column`,
        'invalid_staff_columns',
      );
    }
    staffColumns[name] = cols as StaffSubColumns;
  }
  if (Object.keys(staffColumns).length === 0) {
    throw new SheetShapeMappingError(
      'staffColumns must contain at least one staff entry',
      'invalid_staff_columns',
    );
  }
  if (!r.statusValueToEnumMap || typeof r.statusValueToEnumMap !== 'object') {
    throw new SheetShapeMappingError('statusValueToEnumMap must be a mapping', 'missing_field');
  }
  const enumSet = new Set<string>(ROSTER_STATUS_VALUES);
  const enumMap: Record<string, RosterStatus> = {};
  for (const [k, v] of Object.entries(r.statusValueToEnumMap as Record<string, unknown>)) {
    if (typeof v !== 'string' || !enumSet.has(v)) {
      throw new SheetShapeMappingError(
        `statusValueToEnumMap entry "${k}" maps to invalid status: ${String(v)}`,
        'invalid_status_enum',
      );
    }
    enumMap[k] = v as RosterStatus;
  }
  if (typeof r.probedAt !== 'string') {
    throw new SheetShapeMappingError('probedAt must be an ISO string', 'missing_field');
  }
  return {
    version: SHEET_MAPPING_SCHEMA_VERSION,
    headerHash: r.headerHash,
    dateColumn: r.dateColumn,
    staffColumns,
    statusValueToEnumMap: enumMap,
    probedAt: r.probedAt,
  };
}

/**
 * Default persisted path. Override via `ROSTER_SHEET_MAPPING_PATH`.
 * Production lives under `/etc/roster-adviser/`; local dev typically
 * puts it under the repo's working dir.
 */
export const DEFAULT_MAPPING_PATH = '/etc/roster-adviser/sheet-mapping.yaml';

export function resolveMappingPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROSTER_SHEET_MAPPING_PATH ?? DEFAULT_MAPPING_PATH;
}

/** Load and validate the persisted mapping. Returns null if the file does
 *  not exist (first-boot case). Throws on parse / validation failure. */
export function loadMappingFromFile(path: string): SheetShapeMapping | null {
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, 'utf-8');
  return parseMappingYaml(text);
}

/**
 * Write the mapping to disk. Creates the parent directory if missing and
 * writes mode 0600 (the file mentions cell-text conventions but no PII;
 * 0600 is the right default for an agent-owned config).
 */
export function saveMappingToFile(path: string, mapping: SheetShapeMapping): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, renderMappingYaml(mapping), { mode: 0o600 });
}
