/**
 * Sync runner — pulls the W&L Log sheet, applies the persisted vertical
 * `SheetShapeMapping`, applies the per-staff resolution rules + privacy
 * filter, and upserts every (person, date) row into the SQLite cache.
 *
 * G6.15.3 (2026-05-21) rewrote the iteration body to walk rows-by-date
 * (column A) and resolve each staff's Day cell via `resolveStaffDayCell`
 * (G6.15.2 priority rules). The horizontal-layout v0 iteration is gone.
 *
 * Privacy invariants (`project_roster_semantics` — load-bearing):
 *
 *   1. Cell text containing `/sick/i` collapses to `status: 'sick'`,
 *      hours `null`. Original cell text never reaches the cache.
 *      Remarks cell text is fed to the resolver ONLY so the `/sick/i`
 *      heuristic can fire — it is not persisted in any field.
 *   2. The `payload_json` column carries only structural metadata
 *      (`source_row`, `staff_day_col`, `sick_collapsed`,
 *      `annual_leave_remaining` numeric balance) — never free-text
 *      from the sheet.
 *   3. There is no `notes` column anywhere in the cache; the privacy
 *      filter is the runtime guard.
 */

import type { RosterCache } from './cache.js';
import type { RosterStatus } from './cache.js';
import type { GoogleSheetsUserOauthAdapter } from './google-sheets-user-oauth-adapter.js';
import { hashHeaderRows, type SheetShapeMapping, type StaffSubColumns } from './sheet-shape-mapping.js';
import { cellToIsoDate } from './sheet-shape-probe.js';

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
  readonly status:
    | 'ok'
    | 'header_hash_mismatch'
    | 'sheet_error';
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

/**
 * Parse the `Annual Leave` cell as a numeric running balance. Returns
 * `null` for non-numeric cells (empty, `-`, dashes). G6.15.5: the balance
 * is recorded in payload metadata only (for future "AL days remaining"
 * reporting) — it never drives status resolution.
 */
export function parseAnnualLeaveBalance(
  cell: string | number | boolean | null | undefined,
): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const trimmed = cell.trim();
    if (trimmed === '' || trimmed === '-') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function hoursForStatus(s: RosterStatus): number | null {
  switch (s) {
    case 'working':
      return ROSTER_DEFAULT_HOURS_WORKING;
    case 'half-day':
      return ROSTER_DEFAULT_HOURS_HALF_DAY;
    case 'leave':
    case 'leave-other':
    case 'sick':
    case 'public-holiday':
    case 'not-working':
    case 'unknown':
    default:
      return null;
  }
}

/**
 * Inputs to `resolveStaffDayCell` — the per-(person, date) row state that
 * the resolver needs to decide a status. G6.15.3 will assemble these from
 * the value grid; G6.15.2 ships the resolver itself.
 */
export interface StaffDayCellInput {
  /** Staff name (row-1 label) — used to look up the per-staff map. */
  readonly staffName: string;
  /** The cell at `staffColumns[name].day` for this row. */
  readonly dayCell: string | number | boolean | null;
  /** The cell at `staffColumns[name].annualLeave` for this row (or null
   *  if the staff has no annualLeave sub-column). */
  readonly annualLeaveCell?: string | number | boolean | null;
  /** The cell at `staffColumns[name].remarks` for this row (or null if
   *  the staff has no remarks sub-column). Used for the `/sick/i`
   *  privacy filter heuristic. */
  readonly remarksCell?: string | number | boolean | null;
}

/**
 * Resolve one (staff, date) row's status. G6.15.5 (2026-05-21) dropped the
 * `Annual Leave > 0` override from G6.15.2 — the W&L sheet's `Annual Leave`
 * column carries the *running balance* of remaining AL days, not a per-day
 * leave flag, so the override mis-classified essentially every populated
 * row as `leave`. The Day cell + per-staff `statusValueToEnumMap` is now
 * the only status signal; `annualLeaveCell` is recorded in payload metadata
 * at the call site (see `runSyncCycle`) for future balance-remaining
 * reporting, never as status.
 *
 * Priority order (highest first):
 *
 *   1. **Privacy collapse** — if either `dayCell` or `remarksCell`
 *      contains `/sick/i`, the row is `sick`, hours `null`. No further
 *      detail is returned (privacy invariant per
 *      `project_roster_semantics`).
 *   2. **Per-staff statusValueToEnumMap** — lowercased + trimmed Day cell
 *      text is looked up against `staffColumns[name].statusValueToEnumMap`
 *      first.
 *   3. **Global fallback map** — if no per-staff hit, the lookup falls
 *      back to `mapping.statusValueToEnumMap`.
 *   4. **Numeric Day cell** — if the Day cell is a number (Chloe's
 *      convention), `> 0 → working`, `0 → not-working`. This fires only
 *      when neither per-staff nor global lookups had a hit.
 *   5. **Unknown** — empty cell → `unknown` + `unknownText: false`; any
 *      other unrecognised text → `unknown` + `unknownText: true`.
 */
export function resolveStaffDayCell(
  input: StaffDayCellInput,
  mapping: SheetShapeMapping,
): CellResolution {
  const staff = mapping.staffColumns[input.staffName] as StaffSubColumns | undefined;
  const dayText =
    input.dayCell === null || input.dayCell === undefined ? '' : String(input.dayCell);
  const remarksText =
    input.remarksCell === null || input.remarksCell === undefined ? '' : String(input.remarksCell);

  // 1. Privacy collapse — runs against both Day and Remarks cell text.
  if (/sick/i.test(dayText) || /sick/i.test(remarksText)) {
    return { status: 'sick', hours: null, sickCollapsed: true, unknownText: false };
  }

  // 2-3. Lookup precedence: per-staff map → global fallback.
  const key = dayText.trim().toLowerCase();
  const perStaffHit = staff?.statusValueToEnumMap?.[key];
  if (perStaffHit) {
    return {
      status: perStaffHit,
      hours: hoursForStatus(perStaffHit),
      sickCollapsed: false,
      unknownText: false,
    };
  }
  const globalHit = mapping.statusValueToEnumMap[key];
  if (globalHit) {
    return {
      status: globalHit,
      hours: hoursForStatus(globalHit),
      sickCollapsed: false,
      unknownText: false,
    };
  }

  // 4. Numeric Day cell — Chloe's `Day Value` convention is numeric hours.
  if (typeof input.dayCell === 'number' && Number.isFinite(input.dayCell)) {
    if (input.dayCell > 0) {
      return {
        status: 'working',
        hours: hoursForStatus('working'),
        sickCollapsed: false,
        unknownText: false,
      };
    }
    return {
      status: 'not-working',
      hours: null,
      sickCollapsed: false,
      unknownText: false,
    };
  }

  // 5. Unknown.
  if (dayText === '') {
    return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: false };
  }
  return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: true };
}

/**
 * Walk the sheet grid in vertical layout — for each data row whose
 * column-A cell parses to a date, walk every staff in `mapping.staffColumns`
 * and resolve the (staff, date) row's status via `resolveStaffDayCell`.
 *
 * AP-6 mid-cycle: re-hash (row 0, row 1) at the top of the sync; if the
 * pair diverges from the persisted mapping's headerHash, abort with
 * `header_hash_mismatch`. The boot self-check catches this on startup
 * but a long-lived RPC daemon may sit between boots, so the re-check
 * here catches in-flight edits without a full restart.
 *
 * AP-2 per cell: a parse error for one (person, date) row logs +
 * continues; the loop never aborts on a single bad cell.
 *
 * Privacy invariants (`project_roster_semantics`):
 *   1. Remarks cell text is fed to `resolveStaffDayCell` ONLY for the
 *      `/sick/i` heuristic; the cell text itself never reaches the
 *      cache (the resolver returns only the status enum + boolean
 *      flag).
 *   2. The `payload_json` column carries only structural metadata
 *      (`source_row`, `staff_day_col`, `sick_collapsed`,
 *      `annual_leave_remaining` numeric balance) — never free-text
 *      from the sheet.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleReport> {
  const now = (deps.now ?? (() => new Date()))();
  const startedAtIso = now.toISOString();

  let values: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
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
  if (values.length < 2) {
    return {
      startedAtIso,
      endedAtIso: new Date().toISOString(),
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      perCellOutcomes: [],
      errorMessage: `values.get returned ${values.length} rows; need at least 2 header rows`,
    };
  }

  const liveHash = hashHeaderRows(values[0] ?? [], values[1] ?? []);
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

  const staffEntries = Object.entries(deps.mapping.staffColumns);

  // Walk data rows (skip the two header rows).
  for (let r = 2; r < values.length; r += 1) {
    const row = values[r] ?? [];
    const dateCell = row[deps.mapping.dateColumn] ?? null;
    const dateIso = cellToIsoDate(dateCell);
    if (!dateIso) {
      // Non-date rows (section headers, "Carried Forward", blank
      // rows between months) are silently skipped — same as v0's
      // "empty row" handling.
      continue;
    }
    for (const [staffName, cols] of staffEntries) {
      if (cols.day === undefined) {
        // Staff has no Day sub-column → nothing to resolve. Skip silently.
        continue;
      }
      const dayCell = row[cols.day] ?? null;
      const annualLeaveCell =
        cols.annualLeave !== undefined ? (row[cols.annualLeave] ?? null) : undefined;
      const remarksCell =
        cols.remarks !== undefined ? (row[cols.remarks] ?? null) : undefined;
      // Empty Day cell with no sick-in-remarks → skip (don't pollute the
      // cache with `unknown` rows for empty cells; matches v0 behaviour).
      // G6.15.5: the AL > 0 escape hatch is gone — Annual Leave is a
      // running balance column, not a per-day leave signal.
      const isEmptyDayCell = dayCell === null || dayCell === undefined || dayCell === '';
      const remarksText =
        remarksCell === null || remarksCell === undefined ? '' : String(remarksCell);
      const sickInRemarks = /sick/i.test(remarksText);
      if (isEmptyDayCell && !sickInRemarks) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person: staffName,
          dateIso,
          status: 'skipped',
          reason: 'empty_cell',
        });
        continue;
      }
      let resolution: CellResolution;
      try {
        resolution = resolveStaffDayCell(
          { staffName, dayCell, annualLeaveCell, remarksCell },
          deps.mapping,
        );
      } catch (err) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person: staffName,
          dateIso,
          status: 'skipped',
          reason: 'parse_error',
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (resolution.unknownText) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person: staffName,
          dateIso,
          status: 'skipped',
          reason: 'unknown_text',
          // Privacy: do NOT include cell text in `detail`. (staff, dateIso)
          // is enough for the operator to find the row.
        });
        continue;
      }
      const annualLeaveRemaining = parseAnnualLeaveBalance(annualLeaveCell);
      const payloadJson = JSON.stringify({
        source_row: r,
        staff_day_col: cols.day,
        sick_collapsed: resolution.sickCollapsed,
        ...(annualLeaveRemaining !== null ? { annual_leave_remaining: annualLeaveRemaining } : {}),
      });
      try {
        deps.cache.upsertEntry({
          person: staffName,
          dateIso,
          status: resolution.status,
          hours: resolution.hours,
          payloadJson,
          updatedAt: startedAtIso,
        });
        cellsUpserted += 1;
        perCellOutcomes.push({
          person: staffName,
          dateIso,
          status: 'upserted',
        });
      } catch (err) {
        cellsSkipped += 1;
        perCellOutcomes.push({
          person: staffName,
          dateIso,
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
