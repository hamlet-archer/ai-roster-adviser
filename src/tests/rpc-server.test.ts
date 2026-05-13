import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterCache } from '../cache.js';
import { buildContractValidator } from '../contracts.js';
import { startRpcServer, type RunningRpcServer, createRpcServer } from '../rpc-server.js';
import { ROSTER_SYNC_SOURCE } from '../sync-runner.js';

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts');

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function roundTrip(socketPath: string, payload: object | string): Promise<unknown> {
  return new Promise((resolveRT, reject) => {
    const sock: Socket = connect(socketPath, () => {
      sock.write((typeof payload === 'string' ? payload : JSON.stringify(payload)) + '\n');
    });
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        sock.end();
        try {
          resolveRT(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    sock.on('error', reject);
  });
}

describe('rpc-server integration', () => {
  let dir: string;
  let cache: RosterCache;
  let running: RunningRpcServer | null;
  let socketPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rpc-roster-'));
    cache = new RosterCache({ path: join(dir, 'roster.db') });
    socketPath = join(dir, 'query.sock');
    const validator = buildContractValidator(CONTRACTS_DIR);
    cache.setSyncState(ROSTER_SYNC_SOURCE, 'h', '2026-05-13T11:00:00Z');
    cache.upsertEntry({
      person: 'sally',
      dateIso: '2026-05-13',
      status: 'working',
      hours: 8,
      payloadJson: '{}',
      updatedAt: '2026-05-13T11:00:00Z',
    });
    running = await startRpcServer({
      socketPath,
      cache,
      validator,
      now: () => new Date('2026-05-13T12:00:00Z'),
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    if (running) await running.close();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a valid roster.query.v1 envelope', async () => {
    const resp = await roundTrip(socketPath, {
      contract_id: 'roster.query.v1',
      trace_id: '01890000-0000-7000-8000-00000000aaaa',
      dedupe_key: 'sha256:x',
      source_ref: 'test',
      caller_agent_id: 'test',
      person: 'sally',
      date: '2026-05-13',
    });
    expect(resp).toMatchObject({
      ok: true,
      contract_id: 'roster.query.v1',
      person: 'sally',
      status: 'working',
      hours: 8,
      source: 'cache',
      sheet_filled: true,
    });
  });

  it('ai-doer queries always return hardcoded working regardless of cache state', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'roster.query.v1',
      trace_id: '01890000-0000-7000-8000-0000000000ad',
      dedupe_key: 'sha256:x',
      source_ref: 'test',
      caller_agent_id: 'test',
      person: 'ai-doer',
      date: '2099-01-01',
    })) as { ok: boolean; status: string; source: string; hours: number };
    expect(resp).toMatchObject({
      ok: true,
      status: 'working',
      hours: 24,
      source: 'hardcoded',
    });
  });

  it('round-trips a valid roster.range.v1 envelope', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'roster.range.v1',
      trace_id: '01890000-0000-7000-8000-00000000bbbb',
      dedupe_key: 'sha256:y',
      source_ref: 'test',
      caller_agent_id: 'test',
      people: ['sally', 'ai-doer'],
      window: { start: '2026-05-13', end: '2026-05-14' },
    })) as { ok: boolean; entries: ReadonlyArray<{ person: string; date: string; status: string }> };
    expect(resp.ok).toBe(true);
    expect(resp.entries).toHaveLength(4);
  });

  it('returns bad_query on a malformed envelope', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'roster.query.v1',
      // missing required fields
      person: 'sally',
    })) as { ok: boolean; code: string };
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('bad_query');
  });

  it('returns bad_query on invalid JSON', async () => {
    const resp = (await roundTrip(socketPath, 'this is not json')) as { ok: boolean; code: string };
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('bad_query');
  });

  it('returns bad_query on unknown contract_id', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'roster.unknown.v1',
      trace_id: '01890000-0000-7000-8000-00000000cccc',
      dedupe_key: 'k',
      source_ref: 't',
      caller_agent_id: 't',
      person: 'sally',
      date: '2026-05-13',
    })) as { ok: boolean; code: string };
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('bad_query');
  });

  it('AP-2: a handler exception serialises as internal_error and the server stays up', async () => {
    // Drive the AP-2 path via a stub cache whose getSyncState throws — the
    // handler reads it before any defensive check, so the exception
    // propagates into the RPC server's per-handler try/catch.
    if (running) await running.close();
    cache.close();
    const throwingCache = {
      getSyncState: () => {
        throw new Error('synthetic db blow-up');
      },
      getEntry: () => null,
      entriesForRange: () => [],
    } as unknown as RosterCache;
    const validator = buildContractValidator(CONTRACTS_DIR);

    const apSocketPath = join(dir, 'ap2.sock');
    const apServer = createRpcServer({
      socketPath: apSocketPath,
      cache: throwingCache,
      validator,
      logger: silentLogger(),
    });
    await new Promise<void>((res, rej) => {
      apServer.on('error', rej);
      apServer.listen(apSocketPath, () => res());
    });

    try {
      const resp = (await roundTrip(apSocketPath, {
        contract_id: 'roster.query.v1',
        trace_id: '01890000-0000-7000-8000-00000000dddd',
        dedupe_key: 'k',
        source_ref: 't',
        caller_agent_id: 't',
        person: 'sally',
        date: '2026-05-13',
      })) as { ok: boolean; code: string; trace_id?: string };
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('internal_error');
      expect(resp.trace_id).toBe('01890000-0000-7000-8000-00000000dddd');
      // Second request → server still up (the exception didn't crash the process).
      const resp2 = (await roundTrip(apSocketPath, {
        contract_id: 'roster.query.v1',
        trace_id: '01890000-0000-7000-8000-00000000eeee',
        dedupe_key: 'k2',
        source_ref: 't',
        caller_agent_id: 't',
        person: 'ai-doer',
        date: '2026-05-13',
      })) as { ok: boolean; status: string };
      expect(resp2).toMatchObject({ ok: true, status: 'working' });
    } finally {
      await new Promise<void>((res) => apServer.close(() => res()));
    }
  });
});
