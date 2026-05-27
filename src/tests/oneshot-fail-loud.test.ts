import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DM_REPEAT_HOURS, FAIL_THRESHOLD, recordOneshotOutcome } from '../oneshot-fail-loud.js';

interface PostCall {
  url: string;
  channel: string;
  text: string;
  headers: Record<string, string>;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyOf(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return '{}';
  // Test fetcher only receives string bodies — the production caller passes
  // JSON.stringify(...). Anything else is a bug in the test wiring.
  throw new Error(`makeFetch: unexpected body type ${typeof body}`);
}

function makeFetch(opts: { posts: PostCall[]; slackOk?: boolean; httpOk?: boolean }): typeof fetch {
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyParsed = JSON.parse(bodyOf(init)) as {
      channel: string;
      text: string;
    };
    opts.posts.push({
      url: urlOf(input),
      channel: bodyParsed.channel,
      text: bodyParsed.text,
      headers,
    });
    const httpOk = opts.httpOk ?? true;
    const slackOk = opts.slackOk ?? true;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: slackOk }), {
        status: httpOk ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return impl;
}

function defaultDeps(statePath: string, posts: PostCall[], nowIso: string) {
  return {
    statePath,
    slackBotToken: 'xoxb-fake',
    slackChannel: 'D0APHT9NUG3',
    recoveryCommand: 'npx tsx src/scripts/bootstrap-oauth.ts',
    serviceId: 'ai-roster-adviser-sync',
    fetch: makeFetch({ posts }),
    nowIso: () => nowIso,
  };
}

describe('recordOneshotOutcome', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oneshot-fail-loud-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('success on a clean state writes lastSuccessAt and posts nothing', async () => {
    const posts: PostCall[] = [];
    const result = await recordOneshotOutcome(
      { kind: 'success' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('success_reset');
    expect(result.state.lastSuccessAt).toBe('2026-05-27T12:00:00.000Z');
    expect(result.state.consecutiveFailures).toBe(0);
    expect(posts).toHaveLength(0);
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(persisted.consecutiveFailures).toBe(0);
  });

  it('a single failure stays below threshold — no DM, counter ticks to 1', async () => {
    const posts: PostCall[] = [];
    const result = await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('below_threshold');
    expect(result.state.consecutiveFailures).toBe(1);
    expect(posts).toHaveLength(0);
  });

  it('two consecutive failures with no prior DM trigger a DM with the recovery command', async () => {
    const posts: PostCall[] = [];
    // first failure: counter = 1
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    // second failure: threshold reached, DM fires
    const result = await recordOneshotOutcome(
      {
        kind: 'failure',
        reason: 'invalid_grant',
        rankedCauses: ['refresh_token revoked in GCP console', 'OAuth client rotated', 'time skew'],
      },
      defaultDeps(statePath, posts, '2026-05-27T12:15:00.000Z'),
    );
    expect(result.posted).toBe(true);
    expect(result.reason).toBe('posted');
    expect(result.state.consecutiveFailures).toBe(FAIL_THRESHOLD);
    expect(result.state.lastDmAt).toBe('2026-05-27T12:15:00.000Z');
    expect(posts).toHaveLength(1);
    const sent = posts[0];
    expect(sent.channel).toBe('D0APHT9NUG3');
    expect(sent.headers.Authorization).toBe('Bearer xoxb-fake');
    expect(sent.text).toContain('🚨 *Action needed*');
    expect(sent.text).toContain('ai-roster-adviser-sync');
    expect(sent.text).toContain(`${FAIL_THRESHOLD} consecutive fires`);
    expect(sent.text).toContain('refresh_token revoked');
    expect(sent.text).toContain('npx tsx src/scripts/bootstrap-oauth.ts');
  });

  it('successive failures within the 24h DM cap stay silent — counter still increments', async () => {
    const posts: PostCall[] = [];
    // Pump two failures to fire the first DM at T0.
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:15:00.000Z'),
    );
    expect(posts).toHaveLength(1);
    // Third failure 15 min later — still inside the 24h cap, no second DM.
    const result = await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:30:00.000Z'),
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('dm_repeat_cap');
    expect(result.state.consecutiveFailures).toBe(3);
    expect(posts).toHaveLength(1);
  });

  it('after the 24h cap elapses, the next failure re-fires the DM', async () => {
    const posts: PostCall[] = [];
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:15:00.000Z'),
    );
    expect(posts).toHaveLength(1);
    // Jump past the repeat cap.
    const after = new Date(
      Date.parse('2026-05-27T12:15:00.000Z') + (DM_REPEAT_HOURS + 1) * 3_600_000,
    ).toISOString();
    const result = await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, after),
    );
    expect(result.posted).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('success resets the consecutive-failures counter (and the next failure starts at 1)', async () => {
    const posts: PostCall[] = [];
    await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    const okResult = await recordOneshotOutcome(
      { kind: 'success' },
      defaultDeps(statePath, posts, '2026-05-27T12:15:00.000Z'),
    );
    expect(okResult.state.consecutiveFailures).toBe(0);
    const nextFail = await recordOneshotOutcome(
      { kind: 'failure', reason: 'invalid_grant' },
      defaultDeps(statePath, posts, '2026-05-27T12:30:00.000Z'),
    );
    expect(nextFail.state.consecutiveFailures).toBe(1);
    expect(nextFail.posted).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it('missing Slack credentials skip the post but still persist the counter increment', async () => {
    const posts: PostCall[] = [];
    const deps = defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z');
    await recordOneshotOutcome({ kind: 'failure', reason: 'x' }, deps);
    const result = await recordOneshotOutcome(
      { kind: 'failure', reason: 'x' },
      {
        ...deps,
        slackBotToken: undefined,
        slackChannel: undefined,
        nowIso: () => '2026-05-27T12:15:00.000Z',
      },
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('no_slack_creds');
    expect(result.state.consecutiveFailures).toBe(2);
    expect(posts).toHaveLength(0);
  });

  it('Slack non-OK response leaves lastDmAt untouched so the next attempt retries', async () => {
    const posts: PostCall[] = [];
    const fetchImpl = makeFetch({ posts, slackOk: false });
    const deps = {
      ...defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
      fetch: fetchImpl,
    };
    await recordOneshotOutcome({ kind: 'failure', reason: 'x' }, deps);
    const result = await recordOneshotOutcome(
      { kind: 'failure', reason: 'x' },
      { ...deps, nowIso: () => '2026-05-27T12:15:00.000Z' },
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('post_failed');
    expect(result.state.lastDmAt).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('writes the state file with 0600 mode', async () => {
    const posts: PostCall[] = [];
    await recordOneshotOutcome(
      { kind: 'success' },
      defaultDeps(statePath, posts, '2026-05-27T12:00:00.000Z'),
    );
    expect(existsSync(statePath)).toBe(true);
    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
