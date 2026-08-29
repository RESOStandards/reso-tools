/**
 * A programmable, deliberately-misbehaving local HTTP server for rigorously
 * testing the resilient request path against realistic server behavior:
 * scripted status sequences, Retry-After headers, latency, hung sockets
 * (for timeout tests), and dropped connections (for network-error tests).
 *
 * Listens on an ephemeral loopback port. Tests script behavior via `enqueue`
 * (FIFO, consumed one per request) or `setHandler` (per-request decision),
 * and assert against the recorded request log.
 */

import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

export interface MockReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-serialized as the body unless `rawBody` is given. */
  readonly body?: unknown;
  /** Exact response body; overrides `body` (use for malformed/non-JSON payloads). */
  readonly rawBody?: string;
  /** Wait this many ms before replying (simulate a slow server). */
  readonly delayMs?: number;
  /** Never reply — leave the socket open (simulate a hang, to exercise client timeouts). */
  readonly hang?: boolean;
  /** Destroy the socket instead of replying (simulate a dropped connection / network error). */
  readonly drop?: boolean;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Wall-clock ms when the request was received (for pacing/concurrency assertions). */
  readonly at: number;
}

export interface MockServer {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** Queue replies consumed FIFO, one per request. */
  enqueue(...replies: readonly MockReply[]): void;
  /** Fallback decision used when the queue is empty. */
  setHandler(handler: (req: RecordedRequest) => MockReply): void;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_REPLY: MockReply = { status: 200, body: { value: [] } };

export const startMockServer = async (): Promise<MockServer> => {
  const requests: RecordedRequest[] = [];
  const queue: MockReply[] = [];
  const sockets = new Set<Socket>();
  const state: { handler?: (req: RecordedRequest) => MockReply } = {};

  const server: Server = createServer((req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      at: Date.now()
    };
    requests.push(recorded);
    req.resume(); // drain any request body so POST/PATCH sockets don't stall

    const reply = queue.shift() ?? state.handler?.(recorded) ?? DEFAULT_REPLY;

    const send = (): void => {
      if (reply.drop) {
        req.socket.destroy();
        return;
      }
      if (reply.hang) {
        return; // never respond
      }
      const headers = { 'content-type': 'application/json', ...reply.headers };
      res.writeHead(reply.status ?? 200, headers);
      res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
    };

    if (reply.delayMs && reply.delayMs > 0) {
      setTimeout(send, reply.delayMs);
    } else {
      send();
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock server did not bind to a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    get requests() {
      return requests;
    },
    enqueue(...replies) {
      queue.push(...replies);
    },
    setHandler(handler) {
      state.handler = handler;
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      state.handler = undefined;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
};
