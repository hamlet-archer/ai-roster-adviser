/**
 * Boot self-check (AP-3 + AP-4 + AP-6) for roster-adviser.
 *
 * Runs before any RPC binding or sync work; fails loud with a ranked-cause
 * diagnostic when a dependency is wrong. Four steps:
 *
 *   1. OAuth credential load — proves the per-user refresh-token file is
 *      present and parseable, scoped to `spreadsheets.readonly`, and bound
 *      to a non-forbidden subject (i.e. NOT `kelvin@liao.info` per
 *      `feedback_no_kelvin_account_impersonation`).
 *   2. `spreadsheets.values.get` round-trip on the W&L sheet — proves auth +
 *      scope + access. A 403 here is the most common failure (sheet not
 *      shared with `ai@liao.info` as the OAuth subject). The probe range
 *      covers enough rows to detect dates in column A.
 *   3. Sheet-shape mapping load OR first-boot probe-and-write. If the persisted
 *      mapping is missing, run the probe (vertical layout — see
 *      `sheet-shape-probe.ts`) + save it. If present, validate.
 *   4. Header-hash compare — re-hash the LIVE header rows (row 1 + row 2)
 *      and compare against the persisted hash. Mismatch → AP-6 fail-loud,
 *      no auto-reprobe.
 *
 * Why ranked causes (AP-4): a single best-guess diagnostic encourages whoever
 * is paged to act on the guess instead of verifying. The patchwork-audit AP-4
 * anchor was an ai-chief incident where the wrong cause was encoded as the
 * official one and the real cause sat lower in the list. Mitigation: print
 * the top 3 candidates ordered by prior probability — every reader sees what
 * to check and in what order.
 */

import type { GoogleSheetsUserOauthAdapter } from './google-sheets-user-oauth-adapter.js';
import {
  GoogleSheetsUserOauthAdapter as DefaultAdapter,
  WL_LOG_DEFAULT_SHEET_ID,
} from './google-sheets-user-oauth-adapter.js';
import {
  hashHeaderRows,
  loadMappingFromFile,
  resolveMappingPath,
  saveMappingToFile,
  type SheetShapeMapping,
  SheetShapeMappingError,
} from './sheet-shape-mapping.js';
import { probeSheetShape, SheetShapeProbeError } from './sheet-shape-probe.js';

export type DependencyName =
  | 'oauth-credential-load'
  | 'sheets-values-get'
  | 'sheet-shape-mapping-load'
  | 'sheet-shape-probe'
  | 'sheet-shape-header-hash';

export interface BootDiagnostic {
  readonly level: 'fatal';
  readonly service: 'ai-roster-adviser';
  readonly phase: 'boot-check';
  readonly step: DependencyName;
  readonly upstream_error: string;
  readonly detail?: Record<string, unknown>;
  /** Ranked top-3 likely root causes per AP-4. */
  readonly ranked_causes: readonly string[];
}

export class BootCheckError extends Error {
  constructor(public readonly diagnostic: BootDiagnostic) {
    super(`${diagnostic.step}: ${diagnostic.upstream_error}`);
    this.name = 'BootCheckError';
  }
}

const RANKED_CAUSES_OAUTH_LOAD: readonly string[] = [
  'OAUTH_TOKEN_PATH points at a missing file (systemd unit LoadCredential not wired, or scripts/bootstrap-oauth.ts not yet run for ai@liao.info)',
  'Token file exists but is invalid (hand-edited JSON, allowed_scopes missing spreadsheets.readonly, or refresh_token rotated since last consent)',
  'OAUTH_SUBJECT set to a forbidden value (kelvin@liao.info is rejected by FORBIDDEN_SUBJECTS per feedback_no_kelvin_account_impersonation)',
];

const RANKED_CAUSES_VALUES_GET: readonly string[] = [
  'Refresh token expired or revoked (the per-user OAuth grant for ai@liao.info was rotated; re-run scripts/bootstrap-oauth.ts to mint a fresh refresh token)',
  'Sheet not shared with ai@liao.info (open the W&L sheet → Share → confirm ai@liao.info has at least Viewer access)',
  'Sheet id wrong (env var ROSTER_SHEET_ID overrides the canonical default; check the value if set, or that the canonical sheet was not deleted/renamed)',
];

const RANKED_CAUSES_PROBE: readonly string[] = [
  'Column A has no parseable dates in the sampled data rows (operator changed the date column or moved the sheet header; restore ISO / UK-style / numeric dates in column A starting at row 3)',
  'Row 1 has no staff spanning labels (Sally/Chloe must appear as staff-name cells over each group of sub-columns)',
  'A sub-header in row 2 is not one of the 7 known names (Day / Night / Day Value / Night Value / Overtime / Annual Leave / Remarks); rename the cell or extend the known set',
];

const RANKED_CAUSES_MAPPING_LOAD: readonly string[] = [
  'Mapping file at ROSTER_SHEET_MAPPING_PATH is corrupt (operator hand-edited it into invalid YAML — restore from version control or delete and re-probe)',
  'Mapping schema version drift (the file was written by an older agent version; bump roster-adviser AND re-probe by deleting the persisted mapping)',
  'Mapping references an unknown status enum value or sub-column key (operator added a value not in the typed set — fix the value or extend the enum)',
];

const RANKED_CAUSES_HEADER_HASH: readonly string[] = [
  'Sheet header rows (row 1 = staff names; row 2 = sub-headers) were edited since the last probe (a staff added/removed/renamed, or a sub-header changed) — review the diff and re-probe by deleting the persisted mapping file',
  'Sheet structural change (a new section, blank row inserted, or column reorder) — review and re-probe',
  'Wrong sheet tab (ROSTER_SHEET_RANGE env var pointing at a different tab than when the mapping was first probed)',
];

export interface BootCheckDeps {
  /** Test seam — production callers omit (adapter built from $OAUTH_TOKEN_PATH). */
  readonly adapter?: GoogleSheetsUserOauthAdapter;
  /** Test seam — production callers omit (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Test seam — production callers omit. If provided, the boot check
   * reads/writes mappings via these in-memory hooks instead of touching
   * the filesystem.
   */
  readonly mappingIO?: {
    readonly load: () => SheetShapeMapping | null;
    readonly save: (m: SheetShapeMapping) => void;
  };
}

export interface BootCheckResult {
  readonly adapter: GoogleSheetsUserOauthAdapter;
  readonly mapping: SheetShapeMapping;
  readonly sheetId: string;
  readonly sheetRange: string;
}

/**
 * Run the 4-step boot check. Returns the validated adapter + mapping on
 * success; throws `BootCheckError` with a renderable AP-4 diagnostic on
 * any step failing. `main.ts` catches and `process.exit(1)`s.
 */
export async function runBootCheck(deps: BootCheckDeps = {}): Promise<BootCheckResult> {
  const env = deps.env ?? process.env;
  const sheetId = env.ROSTER_SHEET_ID ?? WL_LOG_DEFAULT_SHEET_ID;
  // Default range covers enough rows for the vertical probe to see staff
  // labels (row 1), sub-headers (row 2), and a slab of data rows (rows
  // 3+) to verify column A carries dates. 200 rows ≈ 6-7 months of daily
  // entries — generous but cheap. The sync runner uses a wider range
  // (`A1:ZZ`) to pull the whole sheet.
  const sheetRange = env.ROSTER_SHEET_RANGE ?? 'A1:ZZ200';

  // Step 1 — per-user OAuth credential load.
  let adapter: GoogleSheetsUserOauthAdapter;
  try {
    adapter = deps.adapter ?? DefaultAdapter.fromTokenFile({});
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'oauth-credential-load',
      upstream_error: err instanceof Error ? err.message : String(err),
      ranked_causes: RANKED_CAUSES_OAUTH_LOAD,
    });
  }

  // Step 2 — `spreadsheets.values.get` round-trip covering header rows + data sample.
  let values: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  try {
    const res = await adapter.valuesGet({ spreadsheetId: sheetId, range: sheetRange });
    values = res.values;
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'sheets-values-get',
      upstream_error: err instanceof Error ? err.message : String(err),
      detail: { sheet_id: sheetId, sheet_range: sheetRange },
      ranked_causes: RANKED_CAUSES_VALUES_GET,
    });
  }
  if (values.length === 0) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'sheets-values-get',
      upstream_error: 'values.get returned no rows',
      detail: { sheet_id: sheetId, sheet_range: sheetRange },
      ranked_causes: RANKED_CAUSES_VALUES_GET,
    });
  }

  // Step 3 — load mapping OR first-boot probe + write.
  let mapping: SheetShapeMapping | null;
  const mappingPath = resolveMappingPath(env);
  const load = deps.mappingIO?.load ?? (() => loadMappingFromFile(mappingPath));
  const save =
    deps.mappingIO?.save ?? ((m: SheetShapeMapping) => saveMappingToFile(mappingPath, m));
  try {
    mapping = load();
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'sheet-shape-mapping-load',
      upstream_error: err instanceof Error ? err.message : String(err),
      detail: {
        mapping_path: mappingPath,
        reason: err instanceof SheetShapeMappingError ? err.reason : undefined,
      },
      ranked_causes: RANKED_CAUSES_MAPPING_LOAD,
    });
  }

  if (mapping === null) {
    // First boot — probe + persist.
    try {
      mapping = probeSheetShape({ values });
      save(mapping);
    } catch (err) {
      throw new BootCheckError({
        level: 'fatal',
        service: 'ai-roster-adviser',
        phase: 'boot-check',
        step: 'sheet-shape-probe',
        upstream_error: err instanceof Error ? err.message : String(err),
        detail: {
          mapping_path: mappingPath,
          reason: err instanceof SheetShapeProbeError ? err.reason : undefined,
        },
        ranked_causes: RANKED_CAUSES_PROBE,
      });
    }
    return { adapter, mapping, sheetId, sheetRange };
  }

  // Step 4 — header-rows hash compare. AP-6: no auto-reprobe on mismatch.
  const liveHash = hashHeaderRows(values[0] ?? [], values[1] ?? []);
  if (liveHash !== mapping.headerHash) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'sheet-shape-header-hash',
      upstream_error: `live header hash differs from persisted mapping`,
      detail: {
        persisted_hash: mapping.headerHash,
        live_hash: liveHash,
        mapping_path: mappingPath,
        hint: 'Re-probe by deleting the mapping file (after reviewing what changed) — the agent will write a fresh mapping on next boot.',
      },
      ranked_causes: RANKED_CAUSES_HEADER_HASH,
    });
  }

  return { adapter, mapping, sheetId, sheetRange };
}

/**
 * Render a `BootDiagnostic` as a one-line JSON log entry for journald.
 * Same shape comms-adviser + calendar-adviser use so a single log query
 * spans the fleet.
 */
export function renderDiagnostic(diagnostic: BootDiagnostic): string {
  return JSON.stringify(diagnostic);
}
