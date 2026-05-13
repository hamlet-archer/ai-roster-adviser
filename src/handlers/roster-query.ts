/**
 * Handler for `roster.query.v1` — returns the working status of one person
 * on one date, sourced from the local SQLite cache. ai-doer is hard-coded
 * as 24/7 working and never touches the cache.
 *
 * AP-1 cache-stale rule: cache > ROSTER_CACHE_MAX_STALENESS_S stale returns
 * `status: 'unknown'` with the per-source staleness filled in, so the
 * downstream Phase 2 scheduler refuses to write `scheduled_start` for that
 * person on that date rather than fabricating availability.
 *
 * Response shape (not contract-schema-validated; the agent owns this side):
 *   { ok: true, contract_id, trace_id, person, date, status, hours, source,
 *     staleness_seconds, sheet_filled }
 *
 * `source`:
 *   - 'hardcoded' for ai-doer
 *   - 'cache' for everyone else (whether the cache row is fresh or stale)
 *
 * `sheet_filled` distinguishes "no row in cache because the sheet doesn't go
 * that far out yet" from "no row in cache because we haven't synced lately".
 * Future dates beyond the sheet's filled horizon return
 * `{ status: 'unknown', staleness_seconds: null, sheet_filled: false }`.
 */

import type { RosterCache } from '../cache.js';
import type { ContractEnvelope } from '../contracts.js';
import { ROSTER_CACHE_MAX_STALENESS_S, ROSTER_SYNC_SOURCE } from '../sync-runner.js';

export interface RosterQueryDeps {
  readonly cache: RosterCache;
  /** Test seam — defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Sync-state source key the cache writes under. Defaults to the W&L Log. */
  readonly syncStateSource?: string;
}

export interface RosterQuerySuccess {
  readonly ok: true;
  readonly contract_id: 'roster.query.v1';
  readonly trace_id: string;
  readonly person: string;
  readonly date: string;
  readonly status: string;
  readonly hours: number | null;
  readonly source: 'cache' | 'hardcoded';
  readonly staleness_seconds: number | null;
  readonly sheet_filled: boolean;
}

export interface HandlerError {
  readonly ok: false;
  readonly code: 'bad_query' | 'internal_error';
  readonly message: string;
  readonly trace_id?: string;
}

export function handleRosterQuery(
  envelope: ContractEnvelope,
  deps: RosterQueryDeps,
): RosterQuerySuccess | HandlerError {
  const person = envelope.person as string;
  const date = envelope.date as string;

  // ai-doer is 24/7 — never touches the cache. The hardcoded answer is the
  // privacy + correctness invariant per project_roster_semantics.
  if (person === 'ai-doer') {
    return {
      ok: true,
      contract_id: 'roster.query.v1',
      trace_id: envelope.trace_id,
      person,
      date,
      status: 'working',
      hours: 24,
      source: 'hardcoded',
      staleness_seconds: null,
      sheet_filled: true,
    };
  }

  const syncStateSource = deps.syncStateSource ?? ROSTER_SYNC_SOURCE;
  const now = deps.now ?? (() => new Date());
  const syncState = deps.cache.getSyncState(syncStateSource);
  const stalenessSeconds = syncState
    ? Math.max(0, Math.floor((now().getTime() - Date.parse(syncState.lastSyncIso)) / 1000))
    : null;
  const cacheStale =
    stalenessSeconds !== null && stalenessSeconds > ROSTER_CACHE_MAX_STALENESS_S;

  const row = deps.cache.getEntry({ person, dateIso: date });

  if (!row) {
    // No row → either the sheet doesn't cover this date yet, or we've never
    // synced. Without a sync_state entry we cannot distinguish; either way
    // we return `unknown` per AP-1.
    return {
      ok: true,
      contract_id: 'roster.query.v1',
      trace_id: envelope.trace_id,
      person,
      date,
      status: 'unknown',
      hours: null,
      source: 'cache',
      staleness_seconds: stalenessSeconds,
      sheet_filled: false,
    };
  }

  if (cacheStale) {
    // Cache exists but is older than the AP-1 threshold — refuse to answer
    // with the (potentially stale) status. Downstream scheduler treats this
    // identically to "no row" and refuses to schedule for that person+date.
    return {
      ok: true,
      contract_id: 'roster.query.v1',
      trace_id: envelope.trace_id,
      person,
      date,
      status: 'unknown',
      hours: null,
      source: 'cache',
      staleness_seconds: stalenessSeconds,
      sheet_filled: true,
    };
  }

  return {
    ok: true,
    contract_id: 'roster.query.v1',
    trace_id: envelope.trace_id,
    person,
    date,
    status: row.status,
    hours: row.hours,
    source: 'cache',
    staleness_seconds: stalenessSeconds,
    sheet_filled: true,
  };
}
