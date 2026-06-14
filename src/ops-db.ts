/**
 * Control-plane wrapper — opens the shared ops.db on golden-ai-ops via
 * `@hamlet-archer/ai-ops-control-plane`, so the dashboard's fleet-liveness
 * probe sees a fresh `runs.started_at` for roster-adviser every sync cadence
 * (architect-backlog AI1b: this agent previously emitted zero ops.db traces and
 * was therefore invisible to ops.db-based liveness — sister change to AI1a for
 * calendar-adviser).
 *
 * Path resolution is delegated to the lib (OPS_DB_PATH →
 * /var/lib/ai-ops/ops.db → ~/.local/share/ai-ops/ops.db). The bootstrap UPSERT
 * registers the agents row with the shape the lib needs — an existence guard at
 * boot would otherwise UnknownAgentError on a fresh dev database. Unlike the
 * runner-heartbeat INSERT-OR-IGNORE seed, the lib bootstrap is an UPSERT, so a
 * registry change (status / blast radius) self-heals on the next boot.
 *
 * `validatorMode: 'warn'` — roster-adviser serves RPC contracts
 * (roster.query.v1 / roster.range.v1) but emits no control-plane handoffs and
 * bootstraps no contract rows here, so handoff-payload validation has nothing to
 * bind to. (The agent's own RPC-side contract validation lives in
 * src/contracts.ts and is unaffected.)
 */

import { type ControlPlane, open } from '@hamlet-archer/ai-ops-control-plane';

import type { SyncCycleReport } from './sync-runner.js';

const ROSTER_ADVISER_AGENT_ROW = {
  id: 'roster-adviser',
  name: 'Roster Adviser',
  status: 'active' as const,
  blastRadius: 'domain-write' as const,
  notionPageId: null,
  repoUrl: 'https://github.com/hamlet-archer/ai-roster-adviser',
  acceptedIntents: ['roster.query.v1', 'roster.range.v1'],
};

let _cp: ControlPlane | null = null;

export async function openOpsDb(): Promise<ControlPlane> {
  if (_cp) return _cp;
  _cp = await open({
    agentId: 'roster-adviser',
    validatorMode: 'warn',
    bootstrap: { agents: [ROSTER_ADVISER_AGENT_ROW] },
  });
  return _cp;
}

export async function closeOpsDb(): Promise<void> {
  if (!_cp) return;
  await _cp.close();
  _cp = null;
}

/**
 * Wrap one sync cycle in a control-plane run so each 15-min oneshot writes a
 * `runs` row + an `events` row on failure. Returns the `SyncCycleReport`
 * unchanged so callers keep their existing render / exit-code logic.
 *
 * Fail-soft on the *trace*, never on the *sync*. The whole point of this wiring
 * is observability; it must not reduce availability. If ops.db is unreachable
 * (locked, disk full, perms drift) `openOpsDb`/`startRun` is caught and the sync
 * runs untraced with a single warn line — mirroring the runner-heartbeat's
 * "never crash the cycle on emit-failure" discipline. A genuine sync failure
 * still propagates so systemd's non-zero exit semantics are preserved.
 *
 * roster's `runSyncCycle` is non-throwing for expected failures — it returns a
 * report with `status: 'sheet_error' | 'header_hash_mismatch'` rather than
 * raising. So the trace maps the report status to a run status: `ok` → `done`,
 * anything else → `failed` with the report's `errorMessage` as the
 * `errorSummary`. An *unexpected* throw is still caught and ends the run
 * `failed` before re-raising.
 *
 * Five Whys (per docs/architecture.md §1.7 G2): (1) why catch open failure? so
 * a transient ops.db lock can't turn a green sync RED; (2) why would that
 * happen? the oneshot and the always-on RPC daemon both touch ops.db (WAL,
 * concurrent writers) plus the runner heartbeat; (3) why does a red sync matter?
 * it manufactures a false "sync broken" signal — the opposite of this row's
 * intent; (4) why not let it crash like email-triage? email-triage opens once at
 * boot where a crash is acceptable; the advisers' sync oneshot IS the liveness
 * signal; (5) root cause: observability wiring added to a critical path must
 * degrade, not fail. PATCH-EXPIRY: none — this is a permanent design invariant,
 * not a temporary band-aid.
 */
export async function runSyncWithTrace(
  runSync: () => Promise<SyncCycleReport>,
): Promise<SyncCycleReport> {
  let cp: ControlPlane;
  let run: Awaited<ReturnType<ControlPlane['startRun']>>;
  try {
    cp = await openOpsDb();
    run = await cp.startRun({ triggeredBy: 'cron' });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        service: 'ai-roster-adviser',
        phase: 'ops-db',
        msg: 'ops_db_unavailable_untraced',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return runSync();
  }

  try {
    const report = await runSync();
    run.bumpItems(report.cellsUpserted);
    if (report.status === 'ok') {
      await run.end({
        status: 'done',
        summary: `cells_upserted=${report.cellsUpserted} cells_skipped=${report.cellsSkipped}`,
      });
    } else {
      run.bumpErrors(1);
      await cp.emit({
        run,
        kind: 'sync.failed',
        severity: 'error',
        payload: { status: report.status, error: report.errorMessage ?? null },
      });
      await run.end({
        status: 'failed',
        summary: `cells_upserted=${report.cellsUpserted} cells_skipped=${report.cellsSkipped}`,
        errorSummary: `${report.status}: ${report.errorMessage ?? 'unknown'}`,
      });
    }
    return report;
  } catch (err) {
    run.bumpErrors(1);
    await cp.emit({
      run,
      kind: 'sync.failed',
      severity: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    await run.end({
      status: 'failed',
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
