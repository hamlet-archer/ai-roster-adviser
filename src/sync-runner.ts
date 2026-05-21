/**
 * Sync runner — pulls the W&L Log sheet, applies the persisted
 * sheet-shape mapping, applies the privacy filter, and upserts every
 * (person, date) cell into the SQLite cache.
 *
 * G6.15.1 (2026-05-21) bumped `SheetShapeMapping` from horizontal (one row
 * per person, one column per date) to vertical (dates in column A, staff
 * groups in row 1, sub-headers in row 2). The probe + mapping shape now
 * carry the new layout; **the iteration logic in `runSyncCycle` has not
 * been rewritten yet** — that's G6.15.3.
 *
 * Until G6.15.3 lands, `runSyncCycle` returns `status: 'awaiting_v2_runner'`
 * with `cellsUpserted: 0`. The boot self-check + RPC server still work
 * (they read from the cache, which the sync runner is supposed to
 * populate), but the cache will be empty until G6.15.3 ships the new
 * iteration. This is deliberate per the G6.15 sub-item plan: keep
 * compilable, leave the iteration for the next sub-item, do not bridge.
 *
 * `resolveCell` (status enum resolution + `/sick/i` privacy collapse) is
 * shape-agnostic and stays — G6.15.3 will reuse it.
 *
 * Privacy invariants (`project_roster_semantics` — load-bearing):
 *
 *   1. Cell text containing `/sick/i` collapses to `status: 'sick'`,
 *      hours `null`. Original cell text never reaches the cache.
 *   2. The `payload_json` column carries only structural metadata
 *      (`source_row`, `source_column`) — never free-text from the sheet.
 *   3. There is no `notes` column anywhere in the cache; the privacy
 *      filter is the runtime guard.
 */

import type { RosterCache } from './cache.js';
import type { RosterStatus } from './cache.js';
import type { GoogleSheetsUserOauthAdapter } from './google-sheets-user-oauth-adapter.js';
import type { SheetShapeMapping, StaffSubColumns } from './sheet-shape-mapping.js';

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
    | 'sheet_error'
    | 'awaiting_v2_runner';
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
 * Resolve one (staff, date) row's status, applying the G6.15.2 rule
 * priority. Returns the same `CellResolution` shape as `resolveCell` so
 * G6.15.3 can route per-cell outcomes uniformly.
 *
 * Priority order (highest first):
 *
 *   1. **Privacy collapse** — if either `dayCell` or `remarksCell`
 *      contains `/sick/i`, the row is `sick`, hours `null`. No further
 *      detail is returned (privacy invariant per
 *      `project_roster_semantics`).
 *   2. **Annual Leave override** — if the staff has an `annualLeave`
 *      column AND its cell is a number > 0, the row is `leave` regardless
 *      of what the Day cell says. The W&L sheet's Annual Leave column is
 *      the formal leave signal.
 *   3. **Per-staff statusValueToEnumMap** — lowercased + trimmed Day cell
 *      text is looked up against `staffColumns[name].statusValueToEnumMap`
 *      first.
 *   4. **Global fallback map** — if no per-staff hit, the lookup falls
 *      back to `mapping.statusValueToEnumMap`.
 *   5. **Numeric Day cell** — if the Day cell is a number (Chloe's
 *      convention), `> 0 → working`, `0 → not-working`. This fires only
 *      when neither per-staff nor global lookups had a hit.
 *   6. **Unknown** — empty cell → `unknown` + `unknownText: false`; any
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

  // 2. Annual Leave override — formal leave signal beats per-staff map.
  if (staff?.annualLeave !== undefined && input.annualLeaveCell !== undefined) {
    const al = input.annualLeaveCell;
    if (typeof al === 'number' && Number.isFinite(al) && al > 0) {
      return { status: 'leave', hours: null, sickCollapsed: false, unknownText: false };
    }
    if (typeof al === 'string' && al.trim() !== '' && al.trim() !== '-') {
      const n = Number(al);
      if (Number.isFinite(n) && n > 0) {
        return { status: 'leave', hours: null, sickCollapsed: false, unknownText: false };
      }
    }
  }

  // 3-4. Lookup precedence: per-staff map → global fallback.
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

  // 5. Numeric Day cell — Chloe's `Day Value` convention is numeric hours.
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

  // 6. Unknown.
  if (dayText === '') {
    return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: false };
  }
  return { status: 'unknown', hours: null, sickCollapsed: false, unknownText: true };
}

/**
 * **Transitional stub (G6.15.1 → G6.15.3).** The horizontal-layout
 * iteration that v0 of this function used is gone; the new vertical
 * iteration is the work item G6.15.3 carries. Until then, this returns a
 * report with status `awaiting_v2_runner` and no upserts. Callers
 * (`run-sync-once.ts`) treat non-`ok` as exit 1, so the systemd sync
 * timer will reliably surface "not yet implemented" instead of silently
 * doing nothing.
 *
 * `deps` is fully validated (so the function still type-checks against
 * its production caller) but never read — the stub is intentional, not a
 * skipped argument bug.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleReport> {
  // Touch deps just enough to keep `noUnusedParameters` happy; this is
  // not a leak of behaviour. G6.15.3 will rebuild the body from scratch.
  void deps.adapter;
  void deps.cache;
  void deps.mapping;
  void deps.sheetId;
  void deps.sheetRange;
  const now = (deps.now ?? (() => new Date()))();
  const iso = now.toISOString();
  return {
    startedAtIso: iso,
    endedAtIso: iso,
    status: 'awaiting_v2_runner',
    headerHashOk: false,
    cellsUpserted: 0,
    cellsSkipped: 0,
    perCellOutcomes: [],
    errorMessage:
      'sync runner v2 not yet implemented — G6.15.1 shipped the new sheet-shape mapping; G6.15.3 rewrites the iteration. See architect-backlog.md.',
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
