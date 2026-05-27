/**
 * Oneshot-fail-loud: detect N consecutive failed timer fires on a periodic
 * refresher (today: `ai-roster-adviser-sync.service` fired by `*.timer` every
 * 15 min) and post a single `🚨 *Action needed*` DM to the AI Ops bot DM with
 * the ranked-cause line + the copy-pasteable recovery command.
 *
 * Closes the detection-vs-recovery gap that today's stability-runner §1c probe
 * (T1) caught ~3h into the 2026-05-27 `ai-roster-adviser-sync` crash-loop —
 * 12+ failed fires before the operator-visible signal. The agent itself logs
 * a textbook AP-4 ranked-cause fatal line every fire, but only to journald.
 *
 * Threshold: 2 consecutive failures (≈ 30 min for a 15-min timer). DM repeat
 * cap: 1 per 24 h. State persisted under `/var/lib/ai-roster-adviser/` so it
 * survives the oneshot's between-fire process exits.
 *
 * Filed as T3 in [architect-backlog.md](https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md);
 * pattern replicates fleet-wide to every periodic-refresher oneshot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FAIL_THRESHOLD = 2;
export const DM_REPEAT_HOURS = 24;
export const DEFAULT_STATE_PATH = '/var/lib/ai-roster-adviser/oneshot-fail-loud.json';

interface OneshotFailState {
  /** ISO-8601 UTC timestamp of the most recent successful fire, or null if no success has ever been recorded. */
  lastSuccessAt: string | null;
  /** Consecutive failed fires since the last success (or since state-file creation). Reset to 0 on success. */
  consecutiveFailures: number;
  /** ISO-8601 UTC timestamp of the most recent posted DM, or null if no DM has fired. */
  lastDmAt: string | null;
}

export interface OneshotSuccessOutcome {
  readonly kind: 'success';
}

export interface OneshotFailureOutcome {
  readonly kind: 'failure';
  /** One-line cause description (e.g. the AP-4 ranked-cause headline). */
  readonly reason: string;
  /** Optional top-3 ranked causes per AP-4. Joined with `; ` when rendered. */
  readonly rankedCauses?: readonly string[];
}

export type OneshotOutcome = OneshotSuccessOutcome | OneshotFailureOutcome;

export interface OneshotFailLoudDeps {
  /** Path to the state JSON file. Defaults to {@link DEFAULT_STATE_PATH}. */
  statePath?: string;
  /** Slack bot token; if absent we cannot post — fail-soft (no throw). */
  slackBotToken: string | undefined;
  /** Slack channel id; if absent we cannot post — fail-soft. */
  slackChannel: string | undefined;
  /**
   * Copy-pasteable recovery command shown verbatim in the DM body. The caller
   * supplies this because different agents recover differently — keeps this
   * module reusable across the fleet (architect-backlog.md T3 row's
   * "pattern then replicated to every active agent").
   */
  recoveryCommand: string;
  /** Service id (e.g. "ai-roster-adviser-sync") — naming the agent in the DM. */
  serviceId: string;
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Injection seam for tests. Defaults to `new Date().toISOString()`. */
  nowIso?: () => string;
}

export interface OneshotFailLoudResult {
  /** Whether a DM was actually posted on this call. */
  readonly posted: boolean;
  /** Why a DM was or wasn't posted — for the caller's structured log. */
  readonly reason:
    | 'success_reset'
    | 'below_threshold'
    | 'dm_repeat_cap'
    | 'no_slack_creds'
    | 'posted'
    | 'post_failed';
  /** State as written after this call (already persisted). */
  readonly state: OneshotFailState;
}

function readState(statePath: string): OneshotFailState {
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return freshState();
    const obj = parsed as Partial<OneshotFailState>;
    return {
      lastSuccessAt: typeof obj.lastSuccessAt === 'string' ? obj.lastSuccessAt : null,
      consecutiveFailures:
        typeof obj.consecutiveFailures === 'number' && Number.isFinite(obj.consecutiveFailures)
          ? obj.consecutiveFailures
          : 0,
      lastDmAt: typeof obj.lastDmAt === 'string' ? obj.lastDmAt : null,
    };
  } catch {
    return freshState();
  }
}

function freshState(): OneshotFailState {
  return { lastSuccessAt: null, consecutiveFailures: 0, lastDmAt: null };
}

function writeState(statePath: string, state: OneshotFailState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

function hoursSince(isoAt: string, nowIso: string): number {
  const at = Date.parse(isoAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return Infinity;
  return (now - at) / 3_600_000;
}

function buildDmText(
  serviceId: string,
  failure: OneshotFailureOutcome,
  consecutiveFailures: number,
  recoveryCommand: string,
): string {
  const causes =
    failure.rankedCauses && failure.rankedCauses.length > 0
      ? `\n*Ranked likely causes:* ${failure.rankedCauses.join('; ')}`
      : '';
  return [
    `🚨 *Action needed* — ${serviceId} has failed ${consecutiveFailures} consecutive fires`,
    '',
    `*Cause:* ${failure.reason}${causes}`,
    '',
    '*Recover:*',
    '```',
    recoveryCommand,
    '```',
  ].join('\n');
}

async function postToSlack(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text, mrkdwn: true }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/**
 * Record one oneshot outcome and conditionally post a Slack DM.
 *
 * Always persists state. Never throws — observability is non-blocking per the
 * fleet's standing fail-soft discipline (`feedback_alpha_move_fast`).
 */
export async function recordOneshotOutcome(
  outcome: OneshotOutcome,
  deps: OneshotFailLoudDeps,
): Promise<OneshotFailLoudResult> {
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH;
  const nowIso = deps.nowIso ? deps.nowIso() : new Date().toISOString();
  const state = readState(statePath);

  if (outcome.kind === 'success') {
    const next: OneshotFailState = {
      lastSuccessAt: nowIso,
      consecutiveFailures: 0,
      lastDmAt: state.lastDmAt,
    };
    writeState(statePath, next);
    return { posted: false, reason: 'success_reset', state: next };
  }

  const nextFailures = state.consecutiveFailures + 1;
  const next: OneshotFailState = {
    lastSuccessAt: state.lastSuccessAt,
    consecutiveFailures: nextFailures,
    lastDmAt: state.lastDmAt,
  };

  if (nextFailures < FAIL_THRESHOLD) {
    writeState(statePath, next);
    return { posted: false, reason: 'below_threshold', state: next };
  }

  if (state.lastDmAt && hoursSince(state.lastDmAt, nowIso) < DM_REPEAT_HOURS) {
    writeState(statePath, next);
    return { posted: false, reason: 'dm_repeat_cap', state: next };
  }

  if (!deps.slackBotToken || !deps.slackChannel) {
    writeState(statePath, next);
    return { posted: false, reason: 'no_slack_creds', state: next };
  }

  const dmText = buildDmText(deps.serviceId, outcome, nextFailures, deps.recoveryCommand);
  const fetchImpl = deps.fetch ?? fetch;
  const posted = await postToSlack(fetchImpl, deps.slackBotToken, deps.slackChannel, dmText);

  const persisted: OneshotFailState = {
    lastSuccessAt: state.lastSuccessAt,
    consecutiveFailures: nextFailures,
    lastDmAt: posted ? nowIso : state.lastDmAt,
  };
  writeState(statePath, persisted);

  return {
    posted,
    reason: posted ? 'posted' : 'post_failed',
    state: persisted,
  };
}
