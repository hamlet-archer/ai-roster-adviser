/**
 * ai-roster-adviser entry point.
 *
 * Lifecycle (sub-item 4a — pre-deploy, code-side wiring):
 *   1. runBootCheck — per-user OAuth credential load + values.get probe +
 *      sheet-shape mapping load-or-probe + header-hash compare.
 *   2. startRpcServer — long-running Unix-socket daemon at /run/ai-roster-adviser/query.sock.
 *
 * The 15-min sync cadence is driven by a separate systemd timer (sub-item 3 —
 * `run-sync-once.ts`); this binary is the always-on RPC server. The two
 * processes write to the same SQLite cache via WAL mode. We intentionally
 * do NOT run an initial sync in this process — that's the timer's job and
 * adding it here would (a) double-pull on every restart and (b) extend boot
 * time enough to make the systemd ExecStartPost socket-bind probe miss its
 * window. The first scheduled sync fires within a minute of boot (the
 * `OnCalendar=*:0/15` timer + `Persistent=true` semantics from sub-item 3).
 *
 * Graceful shutdown: SIGTERM / SIGINT close the listener and remove the
 * socket file. systemd issues SIGTERM on `systemctl stop` + waits the unit's
 * `TimeoutStopSec` before SIGKILL.
 *
 * Privacy filter (project_roster_semantics): the cache schema enforces no
 * `notes` column; the sync runner (sub-item 3) collapses any cell text
 * containing `sick` to `status: 'sick'` with no further detail before write.
 * Handlers (sub-item 4a) project cache rows out of the agent — there is no
 * code path through which `notes` content can be returned to a caller.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RosterCache } from './cache.js';
import { BootCheckError, renderDiagnostic, runBootCheck } from './boot-check.js';
import { buildContractValidator } from './contracts.js';
import { startRpcServer, type RunningRpcServer } from './rpc-server.js';

const DEFAULT_DB_PATH = '/var/lib/ai-roster-adviser/roster.db';
// systemd RuntimeDirectory=ai-roster-adviser creates /run/ai-roster-adviser/.
// Note: /var/run is a compat symlink to /run on every modern systemd
// distribution, so callers using either path resolve to the same socket.
const DEFAULT_SOCKET_PATH = '/run/ai-roster-adviser/query.sock';

async function main(): Promise<number> {
  const dbPath = process.env.ROSTER_DB_PATH ?? DEFAULT_DB_PATH;
  const socketPath = process.env.ROSTER_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;

  // 1. Boot self-check.
  try {
    const { mapping, sheetId } = await runBootCheck();
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
      console.error(renderDiagnostic(err.diagnostic));
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
    return 2;
  }

  // 2. Long-running RPC server.
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    try {
      await mkdir(socketDir, { recursive: true });
    } catch {
      // Best-effort. systemd RuntimeDirectory typically creates /run/...
    }
  }
  const cache = new RosterCache({ path: dbPath });
  const validator = buildContractValidator();
  let running: RunningRpcServer;
  try {
    running = await startRpcServer({ socketPath, cache, validator });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-roster-adviser',
        phase: 'rpc',
        msg: 'listen_failed',
        socket_path: socketPath,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    cache.close();
    return 1;
  }

  // Graceful shutdown wiring.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'ai-roster-adviser',
        phase: 'shutdown',
        msg: 'received_signal',
        signal,
      }),
    );
    try {
      await running.close();
    } finally {
      cache.close();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Hold the process open — the server's listener keeps the event loop alive.
  return new Promise<number>(() => {
    // Never resolves under normal operation; signals exit via `shutdown`.
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-roster-adviser',
        msg: 'unhandled_rejection',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(2);
  },
);
