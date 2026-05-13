/**
 * Boot self-check (AP-3 + AP-4 + AP-6) for roster-adviser.
 *
 * Runs before any RPC binding or sync work; fails loud with a ranked-cause
 * diagnostic when a dependency is wrong. Four steps:
 *
 *   1. DwD credential load — proves we can sign a JWT for `spreadsheets.readonly`
 *      against the configured impersonation subject.
 *   2. `spreadsheets.values.get` round-trip on the W&L sheet header row — proves
 *      auth + scope + access. A 403 here is the most common failure (sheet not
 *      shared with the SA's impersonation target, or DwD scope not authorized).
 *   3. Sheet-shape mapping load OR first-boot probe-and-write. If the persisted
 *      mapping is missing, run the probe + save it. If present, validate.
 *   4. Header-hash compare — re-hash the LIVE header row and compare against
 *      the persisted hash. Mismatch → AP-6 fail-loud, no auto-reprobe.
 *
 * Why ranked causes (AP-4): a single best-guess diagnostic encourages whoever
 * is paged to act on the guess instead of verifying. The patchwork-audit AP-4
 * anchor was an ai-chief incident where the wrong cause was encoded as the
 * official one and the real cause sat lower in the list. Mitigation: print
 * the top 3 candidates ordered by prior probability — every reader sees what
 * to check and in what order.
 */

import type { GoogleSheetsAdapter } from './google-sheets-adapter.js';
import {
  GoogleSheetsAdapter as DefaultAdapter,
  WL_LOG_DEFAULT_SHEET_ID,
} from './google-sheets-adapter.js';
import {
  hashHeaderRow,
  loadMappingFromFile,
  resolveMappingPath,
  saveMappingToFile,
  SheetShapeMappingError,
  type SheetShapeMapping,
} from './sheet-shape-mapping.js';
import { probeSheetShape, SheetShapeProbeError } from './sheet-shape-probe.js';

export type DependencyName =
  | 'dwd-credential-load'
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

const RANKED_CAUSES_DWD_LOAD: readonly string[] = [
  'DWD_KEY_PATH or DWD_IMPERSONATE_SUBJECT env var unset (systemd unit missing EnvironmentFile / LoadCredential, or local dev started without dotenv)',
  'DwD key file path exists but content is invalid (truncated key, wrong format, or rotated since last deploy)',
  'Impersonation subject is not a real Workspace user (typo in DWD_IMPERSONATE_SUBJECT)',
];

const RANKED_CAUSES_VALUES_GET: readonly string[] = [
  'DwD scope not authorized (Admin Console > API controls > Domain-wide Delegation: client_id 101397011922329106102 missing scope https://www.googleapis.com/auth/spreadsheets.readonly)',
  "Sheet not shared with the impersonation subject (open the W&L sheet → Share → confirm DWD_IMPERSONATE_SUBJECT has at least Viewer)",
  'Sheet id wrong (env var ROSTER_SHEET_ID overrides the canonical default; check the value if set, or that the canonical sheet was not deleted/renamed)',
];

const RANKED_CAUSES_PROBE: readonly string[] = [
  'Header row has no parseable date columns (operator changed the header to free-text — restore ISO/UK-style/numeric dates)',
  'Probe is reading the wrong sheet tab (set ROSTER_SHEET_RANGE to the correct A1 range, e.g. "Roster!A1:ZZ1")',
  'Sheet is empty (the values.get call returned no rows — share the sheet AND make sure the header row is row 1)',
];

const RANKED_CAUSES_MAPPING_LOAD: readonly string[] = [
  'Mapping file at ROSTER_SHEET_MAPPING_PATH is corrupt (operator hand-edited it into invalid YAML — restore from version control or delete and re-probe)',
  'Mapping schema version drift (the file was written by an older agent version; bump roster-adviser AND re-probe)',
  'Mapping references an unknown status enum value (operator added a status not in the typed enum — fix the value or extend the enum)',
];

const RANKED_CAUSES_HEADER_HASH: readonly string[] = [
  'Sheet header row was edited since the last probe (a date column was added/removed/renamed, or the person column header changed) — review the diff and re-probe by deleting the persisted mapping file',
  'Sheet structural change (a new section, blank row inserted, or column reorder) — review and re-probe',
  'Wrong sheet tab (ROSTER_SHEET_RANGE env var pointing at a different tab than when the mapping was first probed)',
];

export interface BootCheckDeps {
  /** Test seam — production callers omit (adapter built from $DWD_KEY_PATH). */
  readonly adapter?: GoogleSheetsAdapter;
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
  readonly adapter: GoogleSheetsAdapter;
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
  // Default range covers the first ~500 columns of the header row's sheet
  // tab; the sync runner will widen to A1:ZZ over the whole tab.
  const sheetRange = env.ROSTER_SHEET_RANGE ?? 'A1:ZZ1';

  // Step 1 — DwD credential load.
  let adapter: GoogleSheetsAdapter;
  try {
    adapter = deps.adapter ?? DefaultAdapter.fromCredentialsFile({});
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'dwd-credential-load',
      upstream_error: err instanceof Error ? err.message : String(err),
      ranked_causes: RANKED_CAUSES_DWD_LOAD,
    });
  }

  // Step 2 — `spreadsheets.values.get` round-trip on the header row.
  let headerRow: ReadonlyArray<string | number | boolean | null>;
  try {
    const res = await adapter.valuesGet({ spreadsheetId: sheetId, range: sheetRange });
    headerRow = (res.values[0] ?? []) as ReadonlyArray<string | number | boolean | null>;
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
  if (headerRow.length === 0) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-roster-adviser',
      phase: 'boot-check',
      step: 'sheets-values-get',
      upstream_error: 'values.get returned no header row',
      detail: { sheet_id: sheetId, sheet_range: sheetRange },
      ranked_causes: RANKED_CAUSES_VALUES_GET,
    });
  }

  // Step 3 — load mapping OR first-boot probe + write.
  let mapping: SheetShapeMapping | null;
  const mappingPath = resolveMappingPath(env);
  const load = deps.mappingIO?.load ?? (() => loadMappingFromFile(mappingPath));
  const save = deps.mappingIO?.save ?? ((m: SheetShapeMapping) => saveMappingToFile(mappingPath, m));
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
      mapping = probeSheetShape({ headerRow });
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

  // Step 4 — header-hash compare. AP-6: no auto-reprobe on mismatch.
  const headerStrings = headerRow.map((c) => (c === null || c === undefined ? '' : String(c)));
  const liveHash = hashHeaderRow(headerStrings);
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
        hint:
          'Re-probe by deleting the mapping file (after reviewing what changed) — the agent will write a fresh mapping on next boot.',
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
