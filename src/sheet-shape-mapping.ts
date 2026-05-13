/**
 * Typed shape mapping for the W&L Log Google Sheet.
 *
 * Sub-item 2 (boot self-check) writes this file on first boot via the
 * sheet-shape probe (`sheet-shape-probe.ts`); subsequent boots load it
 * and compare the live header-row hash. Mismatch → fail loud (AP-6 —
 * schema drift requires human eyes; no auto-reprobe).
 *
 * The persisted file lives at `/etc/roster-adviser/sheet-mapping.yaml`
 * by default (env override `ROSTER_SHEET_MAPPING_PATH`). Operators may
 * edit `status_value_to_enum_map` after the first probe to refine the
 * mapping; the probe seeds it with sensible defaults but cannot know the
 * sheet's actual cell-text conventions in advance.
 *
 * Privacy invariant (project_roster_semantics): this module is the
 * persisted shape; the cache layer (`cache.ts`) enforces no-`notes` at
 * the row schema; the sync runner (sub-item 3) will enforce no-`notes`
 * in cell→row translation. The mapping itself never carries `notes`.
 *
 * Schema versioning: `version: 1` is the current schema. Bumping the
 * version is a breaking change — operators must re-probe.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import yaml from 'js-yaml';

import type { RosterStatus } from './cache.js';
import { ROSTER_STATUS_VALUES } from './cache.js';

export const SHEET_MAPPING_SCHEMA_VERSION = 1;

export interface DateColumnEntry {
  /** Zero-based column index in the sheet's value rows. */
  readonly columnIndex: number;
  /** Header text verbatim (used for human-readable diffs, not for matching). */
  readonly headerText: string;
  /** ISO date `YYYY-MM-DD` the column represents. */
  readonly dateIso: string;
}

export interface SheetShapeMapping {
  readonly version: number;
  /** SHA256 hex of the canonicalised header row — see `hashHeaderRow`. */
  readonly headerHash: string;
  /** Zero-based column index containing person names. */
  readonly personColumn: number;
  /** Header text of the person column (for human-readable diffs). */
  readonly personColumnHeader: string;
  /** Date columns in left-to-right order, indexed into the value rows. */
  readonly dateColumns: readonly DateColumnEntry[];
  /** Cell-text-lowercased → status enum. Operators may extend. */
  readonly statusValueToEnumMap: Readonly<Record<string, RosterStatus>>;
  /** ISO timestamp of the probe that wrote this mapping. */
  readonly probedAt: string;
}

/**
 * SHA256 of the canonicalised header row.
 *
 * Canonicalisation: trim each cell, lowercase, join with `` (unit
 * separator). The lowercase + trim absorbs cosmetic edits (case,
 * trailing spaces) the operator may make in Sheets without triggering
 * an AP-6 fail-loud; the unit-separator join survives any literal cell
 * content. Empty cells (trailing) are preserved — sheet column count
 * changes IS a schema-drift signal.
 */
export function hashHeaderRow(row: readonly string[]): string {
  const canonical = row.map((cell) => cell.trim().toLowerCase()).join('');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Seed for the status-value-to-enum map. Lowercase keys; operators may
 * extend (e.g. add `'al'` if the sheet uses an "Annual Leave" abbreviation).
 *
 * Privacy: any cell text that contains the substring `sick` (case-insensitive)
 * also collapses to `'sick'` at sync time — that's enforced in the sync
 * runner (sub-item 3), not here.
 */
export const DEFAULT_STATUS_VALUE_MAP: Readonly<Record<string, RosterStatus>> = Object.freeze({
  '': 'unknown',
  'w': 'working',
  'wk': 'working',
  'working': 'working',
  'on': 'working',
  'yes': 'working',
  'y': 'working',
  '✓': 'working',
  'l': 'leave',
  'lv': 'leave',
  'leave': 'leave',
  'al': 'leave',
  'off': 'leave',
  'h': 'half-day',
  'half': 'half-day',
  'half-day': 'half-day',
  'half day': 'half-day',
  '½': 'half-day',
  'ph': 'public-holiday',
  'public holiday': 'public-holiday',
  'public-holiday': 'public-holiday',
  'sick': 'sick',
  's': 'sick',
});

/**
 * Render the mapping as a YAML string the operator can hand-edit on disk.
 *
 * Stable ordering: top-level keys appear in `version`, `headerHash`, …,
 * `statusValueToEnumMap` order. The enum-map keys are sorted for diff
 * stability across re-probes.
 */
export function renderMappingYaml(mapping: SheetShapeMapping): string {
  const sortedMap: Record<string, RosterStatus> = {};
  for (const k of Object.keys(mapping.statusValueToEnumMap).sort()) {
    sortedMap[k] = mapping.statusValueToEnumMap[k]!;
  }
  return yaml.dump(
    {
      version: mapping.version,
      headerHash: mapping.headerHash,
      personColumn: mapping.personColumn,
      personColumnHeader: mapping.personColumnHeader,
      dateColumns: mapping.dateColumns,
      statusValueToEnumMap: sortedMap,
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
      | 'invalid_date_column',
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
  for (const k of [
    'headerHash',
    'personColumn',
    'personColumnHeader',
    'dateColumns',
    'statusValueToEnumMap',
    'probedAt',
  ] as const) {
    if (!(k in r)) {
      throw new SheetShapeMappingError(`mapping missing field: ${k}`, 'missing_field');
    }
  }
  if (typeof r.headerHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.headerHash)) {
    throw new SheetShapeMappingError('headerHash must be SHA256 hex', 'missing_field');
  }
  if (typeof r.personColumn !== 'number' || r.personColumn < 0) {
    throw new SheetShapeMappingError('personColumn must be a non-negative integer', 'missing_field');
  }
  if (typeof r.personColumnHeader !== 'string') {
    throw new SheetShapeMappingError('personColumnHeader must be a string', 'missing_field');
  }
  if (!Array.isArray(r.dateColumns)) {
    throw new SheetShapeMappingError('dateColumns must be a list', 'missing_field');
  }
  const dateColumns: DateColumnEntry[] = [];
  for (const dc of r.dateColumns) {
    if (!dc || typeof dc !== 'object') {
      throw new SheetShapeMappingError('dateColumns entry must be a mapping', 'invalid_date_column');
    }
    const e = dc as Record<string, unknown>;
    if (typeof e.columnIndex !== 'number' || typeof e.headerText !== 'string') {
      throw new SheetShapeMappingError(
        'dateColumns entry missing columnIndex/headerText',
        'invalid_date_column',
      );
    }
    if (typeof e.dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.dateIso)) {
      throw new SheetShapeMappingError(
        `dateColumns entry has invalid dateIso: ${String(e.dateIso)}`,
        'invalid_date_column',
      );
    }
    dateColumns.push({
      columnIndex: e.columnIndex,
      headerText: e.headerText,
      dateIso: e.dateIso,
    });
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
    personColumn: r.personColumn,
    personColumnHeader: r.personColumnHeader,
    dateColumns,
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
