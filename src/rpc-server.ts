/**
 * Unix-socket RPC server for the roster-adviser. Newline-delimited JSON
 * envelopes in, newline-delimited JSON responses out. Mirrors the shape of
 * ai-calendar-adviser's rpc-server.ts.
 *
 * Wire format:
 *   request line  = JSON object matching either `contracts/roster.query.v1.json`
 *                   or `contracts/roster.range.v1.json` (the `contract_id`
 *                   field selects the schema).
 *   response line = JSON object — either the handler's success payload
 *                   (`{ ok: true, ... }`) or an error envelope
 *                   (`{ ok: false, code, message, trace_id? }`).
 *
 * Discipline per backlog row 4a:
 *   - Socket path is bound at mode 0600 (chmod after listen — Node's
 *     `listen()` does not accept a mode arg for AF_UNIX).
 *   - Stale socket files are cleaned up on listen.
 *   - Per-connection line buffer bounded to 1 MiB to defend against
 *     unbounded inputs.
 *   - Handler exceptions never crash the process (AP-2) — they are caught
 *     and surfaced as `internal_error` response envelopes.
 *
 * Authentication note: SO_PEERCRED-based identity is described in the
 * contracts but not enforced at v1 — the server runs as its own dedicated
 * uid behind systemd, and the socket's 0600 mode limits writers to that
 * uid + root. v2 introduces a per-caller uid table if cross-uid callers
 * land.
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { RosterCache } from './cache.js';
import type { ContractValidator } from './contracts.js';
import { handleRosterQuery, type HandlerError } from './handlers/roster-query.js';
import { handleRosterRange } from './handlers/roster-range.js';

export interface RpcServerDeps {
  readonly socketPath: string;
  readonly cache: RosterCache;
  readonly validator: ContractValidator;
  /** Test seam — production callers omit. */
  readonly now?: () => Date;
  readonly syncStateSource?: string;
  readonly logger?: { info(o: object): void; warn(o: object): void; error(o: object): void };
}

const MAX_LINE_BYTES = 1024 * 1024;

function defaultLogger(): NonNullable<RpcServerDeps['logger']> {
  return {
    info: (o) => console.log(JSON.stringify({ level: 'info', service: 'ai-roster-adviser', ...o })),
    warn: (o) => console.warn(JSON.stringify({ level: 'warn', service: 'ai-roster-adviser', ...o })),
    error: (o) => console.error(JSON.stringify({ level: 'error', service: 'ai-roster-adviser', ...o })),
  };
}

export interface RunningRpcServer {
  readonly server: Server;
  close(): Promise<void>;
}

export function createRpcServer(deps: RpcServerDeps): Server {
  const logger = deps.logger ?? defaultLogger();

  return createServer((socket: Socket) => {
    let buffer = '';
    let droppedOversize = false;

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      if (droppedOversize) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        droppedOversize = true;
        logger.warn({ phase: 'rpc', msg: 'oversize_line_dropped' });
        try {
          socket.end(
            JSON.stringify({ ok: false, code: 'bad_query', message: 'request line exceeds 1 MiB' }) + '\n',
          );
        } catch {
          // Best-effort.
        }
        return;
      }

      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line, socket, deps, logger);
        nl = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      logger.warn({ phase: 'rpc', msg: 'socket_error', error: err.message });
    });
  });
}

function handleLine(
  line: string,
  socket: Socket,
  deps: RpcServerDeps,
  logger: NonNullable<RpcServerDeps['logger']>,
): void {
  if (line.trim() === '') return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    writeResponse(socket, {
      ok: false,
      code: 'bad_query',
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = deps.validator.validate(parsed);
  if (!result.ok) {
    const traceId = (parsed as { trace_id?: string } | null)?.trace_id;
    writeResponse(socket, {
      ok: false,
      code: 'bad_query',
      message: result.errors,
      ...(traceId ? { trace_id: traceId } : {}),
    });
    return;
  }

  const envelope = result.value;
  try {
    let response: object;
    if (envelope.contract_id === 'roster.query.v1') {
      response = handleRosterQuery(envelope, {
        cache: deps.cache,
        now: deps.now,
        syncStateSource: deps.syncStateSource,
      });
    } else if (envelope.contract_id === 'roster.range.v1') {
      response = handleRosterRange(envelope, {
        cache: deps.cache,
        now: deps.now,
        syncStateSource: deps.syncStateSource,
      });
    } else {
      response = {
        ok: false,
        code: 'bad_query',
        message: `unsupported contract_id: ${envelope.contract_id}`,
        trace_id: envelope.trace_id,
      } satisfies HandlerError & { trace_id: string };
    }
    writeResponse(socket, response);
  } catch (err) {
    // AP-2: handler exception → typed error envelope, NEVER crash the process.
    logger.error({
      phase: 'rpc',
      msg: 'handler_exception',
      contract_id: envelope.contract_id,
      trace_id: envelope.trace_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    writeResponse(socket, {
      ok: false,
      code: 'internal_error',
      message: 'handler exception (logged)',
      trace_id: envelope.trace_id,
    });
  }
}

function writeResponse(socket: Socket, payload: object): void {
  try {
    socket.write(JSON.stringify(payload) + '\n');
  } catch {
    // Caller likely disconnected mid-write; nothing we can do.
  }
}

/**
 * Bind the server to a Unix socket at `socketPath`, cleaning up any stale
 * file and chmod'ing to 0600 once listening. Resolves with a `close()`
 * helper that tears the listener down + removes the socket file.
 */
export function startRpcServer(deps: RpcServerDeps): Promise<RunningRpcServer> {
  const logger = deps.logger ?? defaultLogger();
  const server = createRpcServer(deps);

  return new Promise((resolve, reject) => {
    if (existsSync(deps.socketPath)) {
      try {
        unlinkSync(deps.socketPath);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(deps.socketPath, () => {
      try {
        chmodSync(deps.socketPath, 0o600);
      } catch (err) {
        logger.warn({
          phase: 'rpc',
          msg: 'chmod_failed',
          path: deps.socketPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info({
        phase: 'rpc',
        msg: 'listening',
        socket_path: deps.socketPath,
      });
      resolve({
        server,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (existsSync(deps.socketPath)) {
                try {
                  unlinkSync(deps.socketPath);
                } catch {
                  // Best-effort.
                }
              }
              res();
            });
          }),
      });
    });
  });
}
