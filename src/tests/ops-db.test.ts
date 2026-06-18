/**
 * Hermetic test for the control-plane run-trace wrapper (architect-backlog AI1b).
 * Points OPS_DB_PATH at a throwaway sqlite file — the lib creates the schema on
 * open — and asserts that one sync cycle writes the agents row + a `runs` row,
 * that a sheet-error cycle ends the run `failed`, and that an ops.db outage
 * degrades to an untraced sync rather than throwing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeOpsDb, runSyncWithTrace } from '../ops-db.js';
import type { SyncCycleReport } from '../sync-runner.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'roster-opsdb-'));
  dbPath = join(tmpDir, 'ops.db');
  process.env.OPS_DB_PATH = dbPath;
});

afterEach(async () => {
  await closeOpsDb();
  delete process.env.OPS_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(overrides: Partial<SyncCycleReport> = {}): SyncCycleReport {
  return {
    traceId: '0192f000-0000-7000-8000-000000000000',
    startedAtIso: '2026-06-14T10:00:00.000Z',
    endedAtIso: '2026-06-14T10:00:01.000Z',
    status: 'ok',
    headerHashOk: true,
    cellsUpserted: 5,
    cellsSkipped: 2,
    perCellOutcomes: [],
    ...overrides,
  };
}

describe('runSyncWithTrace', () => {
  it('registers the agents row and writes a done run for a clean cycle', async () => {
    const result = await runSyncWithTrace(() => Promise.resolve(report()));
    expect(result.cellsUpserted).toBe(5);
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const agent = db
        .prepare("SELECT id, status, blast_radius FROM agents WHERE id = 'roster-adviser'")
        .get() as { id: string; status: string; blast_radius: string } | undefined;
      expect(agent).toBeDefined();
      expect(agent?.status).toBe('active');
      expect(agent?.blast_radius).toBe('domain-write');

      const runs = db
        .prepare("SELECT status, items_processed FROM runs WHERE agent_id = 'roster-adviser'")
        .all() as Array<{ status: string; items_processed: number }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('done');
      expect(runs[0]?.items_processed).toBe(5);
    } finally {
      db.close();
    }
  });

  it('emits a sync.cycle_complete event on the success path (AJ2b)', async () => {
    await runSyncWithTrace(() => Promise.resolve(report()));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const ev = db
        .prepare(
          "SELECT kind, severity, payload_json FROM events WHERE agent_id = 'roster-adviser' AND kind = 'sync.cycle_complete'",
        )
        .get() as { kind: string; severity: string; payload_json: string } | undefined;
      expect(ev).toBeDefined();
      expect(ev?.severity).toBe('info');
      const payload = JSON.parse(ev?.payload_json ?? '{}');
      expect(payload.contract_id).toBe('sync.cycle_complete.v1');
      expect(payload.sources_ok).toBe(1);
      expect(payload.sources_failed).toBe(0);
      expect(payload.rows_upserted).toBe(5);
    } finally {
      db.close();
    }
  });

  it('does NOT emit sync.cycle_complete on a non-ok cycle (AJ2b — failure path uses sync.failed)', async () => {
    const failingReport = report({
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      errorMessage: 'values.get returned 1 rows; need at least 2 header rows',
    });
    await runSyncWithTrace(() => Promise.resolve(failingReport));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const complete = db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE agent_id = 'roster-adviser' AND kind = 'sync.cycle_complete'",
        )
        .get() as { n: number };
      expect(complete.n).toBe(0);
      const failed = db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE agent_id = 'roster-adviser' AND kind = 'sync.failed'",
        )
        .get() as { n: number };
      expect(failed.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('ends the run failed when the sync reports a non-ok status', async () => {
    const failingReport = report({
      status: 'sheet_error',
      headerHashOk: false,
      cellsUpserted: 0,
      cellsSkipped: 0,
      errorMessage: 'values.get returned 1 rows; need at least 2 header rows',
    });
    await runSyncWithTrace(() => Promise.resolve(failingReport));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const run = db
        .prepare("SELECT status, errors FROM runs WHERE agent_id = 'roster-adviser'")
        .get() as { status: string; errors: number } | undefined;
      expect(run?.status).toBe('failed');
      expect(run?.errors).toBe(1);
    } finally {
      db.close();
    }
  });

  it('runs the sync untraced when ops.db cannot be opened', async () => {
    // Point at a path whose parent is a file → open() cannot create the db.
    const badParent = join(tmpDir, 'not-a-dir');
    writeFileSync(badParent, 'x');
    process.env.OPS_DB_PATH = join(badParent, 'ops.db');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runSyncWithTrace(() => Promise.resolve(report()));

    expect(result.cellsUpserted).toBe(5); // sync still completed
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
