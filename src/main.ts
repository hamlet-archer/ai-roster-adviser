/**
 * ai-roster-adviser entry point.
 *
 * Sub-item 2 lifecycle (today):
 *   1. runBootCheck — DwD credential load + values.get probe + sheet-shape
 *      mapping load-or-probe + header-hash compare.
 *   2. Exit non-zero with a scaffold-only message — sync runner + RPC server
 *      land in sub-items 3 + 4. Production deploy uses sub-item 4's units;
 *      this binary is currently a one-shot to flush boot-check failures.
 *
 * When sub-items 3 + 4 land, this file will:
 *   - Run boot check (already wired)
 *   - Open SQLite cache
 *   - Run initial sync cycle (sub-item 3)
 *   - Bind Unix-socket RPC server (sub-item 4)
 *
 * Privacy filter (project_roster_semantics): the cache schema enforces no
 * `notes` column; the sync runner (sub-item 3) collapses any cell text
 * containing `sick` to `status: 'sick'` with no further detail before write.
 */

import { BootCheckError, renderDiagnostic, runBootCheck } from './boot-check.js';

async function main(): Promise<number> {
  try {
    const { mapping, sheetId } = await runBootCheck();
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'ai-roster-adviser',
        phase: 'boot-check',
        msg: 'boot_check_ok',
        sheet_id: sheetId,
        person_column: mapping.personColumn,
        date_columns: mapping.dateColumns.length,
        header_hash_prefix: mapping.headerHash.slice(0, 16),
        probed_at: mapping.probedAt,
      }),
    );
  } catch (err) {
    if (err instanceof BootCheckError) {
      // eslint-disable-next-line no-console
      console.error(renderDiagnostic(err.diagnostic));
      return 1;
    }
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-roster-adviser',
        phase: 'boot-check',
        msg: 'unhandled_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 2;
  }

  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'ai-roster-adviser',
      msg: 'scaffold_only',
      hint:
        'sub-item 2 ships boot self-check only; sync runner (sub-item 3) and RPC server (sub-item 4) land next',
    }),
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-roster-adviser',
        msg: 'unhandled_rejection',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(2);
  });
