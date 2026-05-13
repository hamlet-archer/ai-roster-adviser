/**
 * One-shot sync entry point — invoked by the 15-min systemd timer
 * (`deploy/systemd/ai-roster-adviser-sync.timer`).
 *
 * Lifecycle:
 *   1. runBootCheck — same gate the long-running RPC daemon uses; ensures
 *      auth + sheet-shape mapping are still valid before we write to the
 *      cache.
 *   2. runSyncCycle — pulls the full sheet, applies the privacy filter,
 *      upserts every (person, date) cell that resolves to a known status.
 *   3. Exit 0 on a clean cycle (`status: 'ok'`); 1 on any abort
 *      (header-hash drift, sheet error, or boot-check failure).
 *
 * The unit's `Type=oneshot` means systemd treats exit-0 as success and
 * exit-non-zero as failure — keeping the timer's own log a clean signal
 * of "last sync OK vs not".
 */

import { RosterCache } from '../cache.js';
import { BootCheckError, renderDiagnostic, runBootCheck } from '../boot-check.js';
import { renderSyncSummary, runSyncCycle } from '../sync-runner.js';

const DEFAULT_DB_PATH = '/var/lib/ai-roster-adviser/roster.db';
const DEFAULT_FULL_SHEET_RANGE = 'A1:ZZ';

async function main(): Promise<number> {
  let bootResult: Awaited<ReturnType<typeof runBootCheck>>;
  try {
    bootResult = await runBootCheck();
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
  const { adapter, mapping, sheetId } = bootResult;

  const dbPath = process.env.ROSTER_DB_PATH ?? DEFAULT_DB_PATH;
  // The full-sheet sync uses a wider range than the boot-check header probe
  // — A1:ZZ covers every data row a sane roster will ever have.
  const sheetRange = process.env.ROSTER_SHEET_FULL_RANGE ?? DEFAULT_FULL_SHEET_RANGE;
  const cache = new RosterCache({ path: dbPath });
  try {
    const report = await runSyncCycle({
      adapter,
      cache,
      mapping,
      sheetId,
      sheetRange,
    });
    // eslint-disable-next-line no-console
    console.log(renderSyncSummary(report));
    return report.status === 'ok' ? 0 : 1;
  } finally {
    cache.close();
  }
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
