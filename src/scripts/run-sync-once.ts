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

import { v7 as uuidv7 } from 'uuid';

import { BootCheckError, renderDiagnostic, runBootCheck } from '../boot-check.js';
import { RosterCache } from '../cache.js';
import {
  type OneshotFailLoudDeps,
  type OneshotOutcome,
  recordOneshotOutcome,
} from '../oneshot-fail-loud.js';
import { closeOpsDb, runSyncWithTrace } from '../ops-db.js';
import { renderSyncSummary, runSyncCycle } from '../sync-runner.js';

const DEFAULT_DB_PATH = '/var/lib/ai-roster-adviser/roster.db';
const DEFAULT_FULL_SHEET_RANGE = 'A1:ZZ';
const RECOVERY_COMMAND =
  'npx -y tsx ~/Repo/ai-roster-adviser/src/scripts/bootstrap-oauth.ts  # then scp the resulting file to golden-ai-ops:/etc/ai-roster-adviser/oauth-token.json (mode 0600)';

function failLoudDeps(): OneshotFailLoudDeps {
  return {
    statePath: process.env.ONESHOT_FAIL_LOUD_STATE_PATH,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackChannel: process.env.SLACK_CHANNEL_AI_OPS,
    recoveryCommand: RECOVERY_COMMAND,
    serviceId: 'ai-roster-adviser-sync',
  };
}

async function reportToFailLoud(outcome: OneshotOutcome): Promise<void> {
  try {
    const result = await recordOneshotOutcome(outcome, failLoudDeps());
    // Always emit a structured journald line so the stability-runner can grep
    // for "oneshot_fail_loud" if needed; never fail the parent oneshot on
    // observability errors.
    console.log(
      JSON.stringify({
        level: result.posted ? 'warn' : 'info',
        service: 'ai-roster-adviser',
        phase: 'sync',
        msg: 'oneshot_fail_loud',
        outcome: outcome.kind,
        posted: result.posted,
        reason: result.reason,
        consecutive_failures: result.state.consecutiveFailures,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        service: 'ai-roster-adviser',
        phase: 'sync',
        msg: 'oneshot_fail_loud_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function main(): Promise<number> {
  let bootResult: Awaited<ReturnType<typeof runBootCheck>>;
  try {
    bootResult = await runBootCheck();
  } catch (err) {
    if (err instanceof BootCheckError) {
      console.error(renderDiagnostic(err.diagnostic));
      await reportToFailLoud({
        kind: 'failure',
        reason: `boot-check ${err.diagnostic.step}: ${err.diagnostic.upstream_error}`,
        rankedCauses: err.diagnostic.ranked_causes,
      });
      return 1;
    }

    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-roster-adviser',
        phase: 'boot-check',
        msg: 'unhandled_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await reportToFailLoud({
      kind: 'failure',
      reason: `boot-check unhandled: ${err instanceof Error ? err.message : String(err)}`,
    });
    return 2;
  }
  const { adapter, mapping, sheetId } = bootResult;

  const dbPath = process.env.ROSTER_DB_PATH ?? DEFAULT_DB_PATH;
  // The full-sheet sync uses a wider range than the boot-check header probe
  // — A1:ZZ covers every data row a sane roster will ever have.
  const sheetRange = process.env.ROSTER_SHEET_FULL_RANGE ?? DEFAULT_FULL_SHEET_RANGE;
  const traceId = uuidv7();

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'ai-roster-adviser',
      phase: 'sync',
      msg: 'sync_cycle_start',
      trace_id: traceId,
    }),
  );
  const cache = new RosterCache({ path: dbPath });
  try {
    // Wrap the cycle in a control-plane run so each 15-min timer fire writes an
    // ops.db `runs` row — the dashboard's fleet-liveness probe (AI1b).
    // runSyncWithTrace returns the report unchanged and is fail-soft on the
    // trace, so the exit-code + fail-loud semantics below are preserved even if
    // ops.db is unreachable.
    const report = await runSyncWithTrace(() =>
      runSyncCycle({
        adapter,
        cache,
        mapping,
        sheetId,
        sheetRange,
        traceId,
      }),
    );

    console.log(renderSyncSummary(report));
    if (report.status === 'ok') {
      await reportToFailLoud({ kind: 'success' });
      return 0;
    }
    await reportToFailLoud({
      kind: 'failure',
      reason: `sync ${report.status}: ${report.errorMessage ?? 'unknown'}`,
    });
    return 1;
  } finally {
    cache.close();
    await closeOpsDb();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
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
