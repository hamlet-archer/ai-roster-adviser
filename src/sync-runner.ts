/**
 * Sync runner — pulls the W&L Log sheet, applies the persisted
 * sheet-shape mapping, applies the privacy filter, and upserts every
 * (person, date) cell into the SQLite cache.
 *
 * Driven by the 15-min systemd timer (`deploy/systemd/ai-roster-adviser-sync.timer`).
 *
 * Privacy invariant (project_roster_semantics — load-bearing here):
 *
 *   1. Cell text containing `/sick/i` collapses to `status: 'sick'`,
 *      hours `null`. The original cell text (e.g. "sick - migraine")
 *      never reaches the cache.
 *   2. The `payload_json` column carries only structural metadata
 *      (`source_row`, `source_column`) — never free-text from the sheet.
 *   3. There is no `notes` column anywhere in the cache (sub-item 1's
 *      schema guard); the privacy filter is the runtime guard.
 *
 * AP-2 discipline: a parse error for one (person, date) cell logs +
 * skips that cell; the loop continues. A header-hash mismatch at the
 * top of the sync is fatal — that's an AP-6 schema-drift signal the
 * boot self-check already catches; we re-verify here in case the sheet
 * was edited between boot and the next 15-min tick.
 *
 * Pacing: the W&L sheet is small (~12 people × ~365 days). One
 * `values.get` call returns the entire grid; no pacing is needed inside
 * a single cycle. The 15-min cadence already paces us under Google's
 * per-user-per-minute quota.
 */

import type { RosterCache } from './cache.js';
import type { RosterStatus } from './cache.js';
import type { GoogleSheetsUserOauthAdapter } from './google-sheets-user-oauth-adapter.js';
import { hashHeaderRow, type SheetShapeMapping } from './sheet-shape-mapping.js';

// PATCH-EXPIRY: 2026-08-13 owner=roster-adviser reason=https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md (roster-adviser sub-item 3 magic-number register)
export const ROSTER_SYNC_LOOKBACK_DAYS = 30;
// PATCH-EXPIRY: 2026-08-13 owner=roster-adviser reason=same — cache-stale ceiling per AP-1 (no fabricated availability beyond this)
export const ROSTER_CACHE_MAX_STALENESS_S = 86_400;
// PATCH-EXPIRY: 2026-08-13 owner=roster-adviser reason=same — default hours per status; operators override later if needed
export const ROSTER_DEFAULT_HOURS_WORKING = 8;
export const ROSTER_DEFAULT_HOURS_HALF_DAY = 4;

/** Source identifier for the `sync_state` table — single-source agent today. */
export const ROSTER_SYNC_SOURCE = 'wl-log';

export interface SyncCycleDeps {
  readonly adapter: GoogleSheetsUserOauthAdapter;
  readonly cache: RosterCache;
  readonly mapping: SheetShapeMapping;
  readonly sheetId: string;
  /** A1 range covering the full sheet tab (e.g. `Roster!A1:ZZ`). */
  readonly sheetRange: string;
  /** Clock seam for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

export interface CellResolution {
  readonly status: RosterStatus;
  readonly hours: number | null;
  /** True iff the cell text triggered the `/sick/i` privacy collapse. */
  readonly sickCollapsed: boolean;
  /** True iff the cell text was not recognised in `status_value_to_enum_map`. */
  readonly unknownText: boolean;
}

export interface PerCellOutcome {
  readonly person: string;
  readonly dateIso: string;
  readonly status: 'upserted' | 'skipped';
  readonly reason?: 'empty_cell' | 'unknown_text' | 'parse_error';
  readonly detail?: string;
}

export interface SyncCycleReport {
  readonly startedAtIso: string;
  readonly endedAtIso: string;
  readonly status: 'ok' | 'header_hash_mismatch' | 'sheet_error';
  readonly headerHashOk: boolean;
  readonly cellsUpserted: number;
  readonly cellsSkipped: number;
  readonly perCellOutcomes: readonly PerCellOutcome[];
  readonly errorMessage?: string;
}

/**
 * Resolve one cell's text against the sheet-shape mapping + privacy filter.
 *
 * Privacy filter precedence (load-bearing):
 *   1. `/sick/i` substring → `status: 'sick'`, hours null. Cell text
 *      NEVER returned beyond the boolean flag.
 *   2. Fall through to `status_value_to_enum_map` lookup (lowercased,
 *      trimmed); unknown text → `unknown` enum + `unknownText: true`.
 */
export function resolveCell(
  rawCell: string | number | boolean | null,
  mapping: SheetShapeMapping,
): CellResolution {
  // Empty / null cells → unknown (no upsert; the caller skips them).
  if (rawCell === null || rawCell === undefined || rawCell === '') {
    return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: false };
  }
  const text = String(rawCell);
  // PRIVACY FILTER — must run before any other text matching.
  if (/sick/i.test(text)) {
    return { status: 'sick', hours: null, sickCollapsed: true, unknownText: false };
  }
  const key = text.trim().toLowerCase();
  const lookup = mapping.statusValueToEnumMap[key];
  if (!lookup) {
    return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: true };
  }
  return {
    status: lookup,
    hours: hoursForStatus(lookup),
    sickCollapsed: false,
    unknownText: false,
  };
}

function hoursForStatus(s: RosterStatus): number | null {
  switch (s) {
    case 'working':
      return ROSTER_DEFAULT_HOURS_WORKING;
    case 'half-day':
      return ROSTER_DEFAULT_HOURS_HALF_DAY;
    case 'leave':
    case 'sick':
    case 'public-holiday':
    case 'unknown':
    default:
      return null;
  }
}

/**
 * Walk the sheet grid → for every (person row × date column) intersection,
 * resolve the cell + privacy-filter it + upsert.
 *
 * AP-6 mid-cycle: re-hash the live header row at the top of the sync; if
 * it diverges from the persisted mapping's hash, abort with
 * `header_hash_mismatch`. The boot self-check catches this on startup but
 * a long-lived RPC daemon may sit between boots, so the re-check here
 * catches in-flight edits without a full restart.
 *
 * AP-2 inside the cell loop: per-cell errors are logged in
 * `perCellOutcomes` and the loop continues.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleReport> {
  const now = (deps.now ?? (() => new Date()))();
  const startedAtIso = now.toISOString();
  let values: ReadonlyArray<readonly (string | number | boolean | null)[]>;
  try {
    const res = await deps.adapter.valuesGet({
      spreadsheetId: deps.sheetId,
      range: deps.sheetRange,
    });
    values = res.values;
  } catch (err) {
    return {
      startedAtIso,
      endedAtIso: new Date().toISOString(),
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      perCellOutcomes: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  if (values.length === 0) {
    return {
      startedAtIso,
      endedAtIso: new Date().toISOString(),
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      perCellOutcomes: [],
      errorMessage: 'values.get returned an empty grid',
    };
  }
  const headerRow = (values[0] ?? []).map((c) => (c === null || c === undefined ? '' : String(c)));
  const liveHash = hashHeaderRow(headerRow);
  if (liveHash !== deps.mapping.headerHash) {
    return {
      startedAtIso,
      endedAtIso: new Date().toISOString(),
      status: 'header_hash_mismatch',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      perCellOutcomes: [],
      errorMessage: `live header hash ${liveHash.slice(0, 16)}… differs from persisted ${deps.mapping.headerHash.slice(0, 16)}… — delete the mapping file and re-probe after reviewing the diff`,
    };
  }

  const perCellOutcomes: PerCellOutcome[] = [];
  let cellsUpserted = 0;
  let cellsSkipped = 0;

  // Walk data rows (skip header).
  for (let r = 1; r < values.length; r += 1) {
    const row = values[r] ?? [];
    const personCell = row[deps.mapping.personColumn];
    if (personCell === undefined || personCell === null || personCell === '') {
      continue; // empty row — silently skip; common in W&L sheets between sections
    }
    const person = String(personCell).trim();
    if (!person) continue;
    for (const dc of deps.mapping.dateColumns) {
      const cell = row[dc.columnIndex] ?? null;
      // Empty cells are not upserted — absence of a row means "unknown",
      // and the `unknown` cache-stale path in roster.query.v1 handles it.
      // (Persisting 'unknown' rows for every empty cell would balloon the
      // cache without information gain.)
      if (cell === null || cell === undefined || cell === '') {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person,
          dateIso: dc.dateIso,
          status: 'skipped',
          reason: 'empty_cell',
        });
        continue;
      }
      let resolution: CellResolution;
      try {
        resolution = resolveCell(cell, deps.mapping);
      } catch (err) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person,
          dateIso: dc.dateIso,
          status: 'skipped',
          reason: 'parse_error',
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (resolution.unknownText) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person,
          dateIso: dc.dateIso,
          status: 'skipped',
          reason: 'unknown_text',
          // Note: we do NOT include the cell text in `detail` — that's the
          // privacy invariant. The (person, dateIso) tuple plus the
          // unknown-text flag is enough for the operator to fix.
        });
        continue;
      }
      // Privacy-safe payload: only structural metadata; no free-text.
      const payloadJson = JSON.stringify({
        source_row: r,
        source_column: dc.columnIndex,
        sick_collapsed: resolution.sickCollapsed,
      });
      try {
        deps.cache.upsertEntry({
          person,
          dateIso: dc.dateIso,
          status: resolution.status,
          hours: resolution.hours,
          payloadJson,
          updatedAt: startedAtIso,
        });
        cellsUpserted += 1;
        perCellOutcomes.push({
          person,
          dateIso: dc.dateIso,
          status: 'upserted',
        });
      } catch (err) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person,
          dateIso: dc.dateIso,
          status: 'skipped',
          reason: 'parse_error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  deps.cache.setSyncState(ROSTER_SYNC_SOURCE, deps.mapping.headerHash, startedAtIso);

  return {
    startedAtIso,
    endedAtIso: new Date().toISOString(),
    status: 'ok',
    headerHashOk: true,
    cellsUpserted,
    cellsSkipped,
    perCellOutcomes,
  };
}

/**
 * One-line journald summary of a sync cycle. Excludes `perCellOutcomes`
 * because they can be hundreds of rows — those are inspectable via the
 * cache directly during incident triage.
 */
export function renderSyncSummary(report: SyncCycleReport): string {
  return JSON.stringify({
    level: report.status === 'ok' ? 'info' : 'error',
    service: 'ai-roster-adviser',
    phase: 'sync',
    msg: 'sync_cycle_complete',
    started_at: report.startedAtIso,
    ended_at: report.endedAtIso,
    status: report.status,
    cells_upserted: report.cellsUpserted,
    cells_skipped: report.cellsSkipped,
    error_message: report.errorMessage ?? null,
  });
}
