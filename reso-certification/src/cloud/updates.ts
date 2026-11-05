/**
 * Live updates on cloud runs: a WebSocket the service pushes one JSON event down for each change, so a caller with
 * many runs watches instead of polling `listCloudRunStatus`.
 *
 * The client only listens. It asks for the `reso.v1` subprotocol and carries its bearer as the second subprotocol
 * value, never in the address, so the token stays out of every access log that records a URL. The service echoes
 * `reso.v1`; a connection that does not is refused.
 *
 * The service ends a connection that is idle for ten minutes and any connection after two hours, so the client:
 *  - sends a heartbeat inside the idle limit, and replaces a connection that answers nothing back;
 *  - opens a new connection before the two-hour limit and closes the old one only once the new one is open;
 *  - reconnects after a drop with capped exponential backoff and jitter, asking the token provider again each time
 *    so an expired token is refreshed, and gives up after a run of failed attempts, saying so.
 *
 * Every message is checked against the v1 contract. Anything else is dropped and counted, and nothing is ever thrown
 * into the caller: a broken message, a broken socket or a broken handler of the caller's own all end up as counts or
 * states, never as an exception on the caller's stack.
 *
 * The timers here are a heartbeat, a reconnect schedule and a connection-lifetime schedule. None of them orders one
 * piece of work after another; correctness never waits on them.
 */

import { ensureSecureWebSocketUrl } from '../sdk/common.js';

/** The subprotocol the client asks for and the service echoes. The token travels as the second value. */
export const CLOUD_UPDATES_PROTOCOL = 'reso.v1';

/** What the client sends as a heartbeat. It has no route of its own, so the service's `$default` route answers it. */
export const CLOUD_UPDATES_HEARTBEAT = '{"action":"ping"}';

/** The two kinds of event: a run's status changed, or a notice about a run. */
export const CLOUD_UPDATE_KIND = { run: 'run', notice: 'notice' } as const;
export type CloudUpdateKind = (typeof CLOUD_UPDATE_KIND)[keyof typeof CLOUD_UPDATE_KIND];

/** One event, contract v1. Identifiers and status only: no configuration and no credential is ever in one. */
export interface CloudUpdateEvent {
  readonly v: 1;
  readonly kind: CloudUpdateKind;
  readonly environmentName: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly endorsementName: string;
  readonly version: string;
  readonly certificationRequestId: string;
  /** The published report, once there is one. */
  readonly reportId: string | null;
  readonly status: string;
  readonly statusTimestamp: string;
}

/** The contract's string fields, in the order an event is rebuilt in. Each must be a non-empty string. */
const STRING_FIELDS = [
  'environmentName',
  'providerUoi',
  'providerUsi',
  'recipientUoi',
  'endorsementName',
  'version',
  'certificationRequestId',
  'status',
  'statusTimestamp'
] as const;

const KINDS: ReadonlySet<string> = new Set(Object.values(CLOUD_UPDATE_KIND));

/** The longest message read. An event is a few hundred bytes, so anything near this is not one. */
const MAX_MESSAGE_LENGTH = 64 * 1024;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isKind = (value: unknown): value is CloudUpdateKind => typeof value === 'string' && KINDS.has(value);

/** True when a value is a v1 event: every field present with its type, `reportId` a non-empty string or null. */
export const isCloudUpdateEvent = (value: unknown): value is CloudUpdateEvent =>
  isRecord(value) &&
  value.v === 1 &&
  isKind(value.kind) &&
  STRING_FIELDS.every(field => nonEmpty(value[field])) &&
  (value.reportId === null || nonEmpty(value.reportId));

/** The event with only the contract's fields, so nothing the service adds later reaches a caller unread. */
const projectEvent = (event: CloudUpdateEvent): CloudUpdateEvent => ({
  v: 1,
  kind: event.kind,
  environmentName: event.environmentName,
  providerUoi: event.providerUoi,
  providerUsi: event.providerUsi,
  recipientUoi: event.recipientUoi,
  endorsementName: event.endorsementName,
  version: event.version,
  certificationRequestId: event.certificationRequestId,
  reportId: event.reportId,
  status: event.status,
  statusTimestamp: event.statusTimestamp
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * One message as a v1 event, or `undefined` when it is not one: not text, too long, not JSON, or missing the contract.
 * Exported so the desktop reads events through the same check.
 */
export const parseCloudUpdate = (data: unknown): CloudUpdateEvent | undefined => {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_LENGTH) return undefined;
  const parsed = parseJson(data);
  return isCloudUpdateEvent(parsed) ? projectEvent(parsed) : undefined;
};

/** True for the service's answer to a heartbeat, which is not an event and not a fault. */
const isHeartbeatReply = (data: unknown): boolean => {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_LENGTH) return false;
  if (data.trim() === 'pong') return true;
  const parsed = parseJson(data);
  return isRecord(parsed) && parsed.v === undefined && (parsed.action === 'pong' || parsed.type === 'pong');
};

/**
 * The part of a WebSocket the client uses. Node 22's global `WebSocket` (and so Electron 35's) and a browser's both
 * fit it.
 */
export interface CloudUpdatesSocket {
  readonly protocol: string;
  readonly addEventListener: (type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void) => void;
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
}

/** Makes a socket: the injectable stand-in for `new WebSocket(url, protocols)`. */
export type CloudUpdatesSocketFactory = (url: string, protocols: ReadonlyArray<string>) => CloudUpdatesSocket;

/** A bearer for the next connection, asked for on every connect so it can be refreshed. Nothing means no token. */
export type CloudTokenProvider = () => Promise<string | undefined> | string | undefined;

export type CloudUpdatesState = 'connecting' | 'open' | 'closed' | 'giving-up';

export interface CloudUpdatesStateDetail {
  /** Failed connection attempts in a row. 0 once a connection opens. */
  readonly attempt: number;
  /** On `closed`: how long until the next attempt. Absent when nothing will reconnect, after `close()`. */
  readonly retryInMs?: number;
  /**
   * On `open`: whether this is the first connection, one after a drop, or the planned replacement before the two-hour
   * limit. After a drop, events may have been missed, so a caller that keeps a tally reads the status once.
   */
  readonly connection?: 'first' | 'reconnect' | 'rotation';
  /** On `closed` after a drop: the close code. */
  readonly code?: number;
  /** On `giving-up`: why, in words that never carry the token. */
  readonly reason?: string;
}

export interface CloudUpdatesPolicy {
  /** The first wait after a failure. Each failure in a row doubles it. */
  readonly initialDelayMs: number;
  /** The longest wait between attempts. */
  readonly maxDelayMs: number;
  /** Connection attempts in a row, all failed, before the client gives up. */
  readonly maxAttempts: number;
  /** How often to send a heartbeat. Inside the service's ten-minute idle limit. */
  readonly heartbeatMs: number;
  /** When to replace a connection, measured from its opening. Inside the service's two-hour limit. */
  readonly rotateAfterMs: number;
}

/** The service's limits are 10 minutes idle and 2 hours in all; these stay well inside both. */
export const DEFAULT_CLOUD_UPDATES_POLICY: CloudUpdatesPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 10,
  heartbeatMs: 5 * 60_000,
  rotateAfterMs: 115 * 60_000
};

export interface CloudUpdatesStats {
  /** Events handed to `onEvent`. */
  readonly delivered: number;
  /** Messages dropped because they are not a v1 event. */
  readonly invalid: number;
  /** v1 events for another environment than the one asked for, dropped. */
  readonly otherEnvironment: number;
  /** The same event again, as two connections can carry while one replaces the other, dropped. */
  readonly duplicates: number;
  /** Answers to the heartbeat. */
  readonly heartbeats: number;
  /** Times `onEvent` or `onState` threw. Caught, so the subscription keeps going. */
  readonly handlerErrors: number;
}

export interface SubscribeToCloudUpdatesOptions {
  /**
   * The WebSocket address: `RESO_CLOUD_UPDATES_URL` on the CLI (`resolveCloudUpdatesUrl`). Made `wss` unless loopback;
   * an address that cannot be is given up on before any token is asked for.
   */
  readonly endpoint: string;
  /** The bearer, asked for on every connect. See `update-tokens.ts` for the session, client-credentials and fixed kinds. */
  readonly token: CloudTokenProvider;
  /** The environment the caller's token names. An event for any other is dropped. */
  readonly environmentName: string;
  readonly onEvent: (event: CloudUpdateEvent) => void;
  readonly onState?: (state: CloudUpdatesState, detail: CloudUpdatesStateDetail) => void;
  /** Stands in for `new WebSocket(url, protocols)`. Defaults to the global `WebSocket`. For tests. */
  readonly createSocket?: CloudUpdatesSocketFactory;
  readonly policy?: Partial<CloudUpdatesPolicy>;
  /** The jitter's source, in [0, 1). For tests. */
  readonly random?: () => number;
}

export interface CloudUpdatesSubscription {
  /** Stop: close the connection and never reconnect. Safe to call more than once. */
  readonly close: () => void;
  readonly stats: () => CloudUpdatesStats;
}

/**
 * The wait before attempt `attempt + 1`, after `attempt` failures in a row (1 or more): the exponential step, capped,
 * with "equal jitter", so the wait is between half the step and the whole of it. The jitter spreads many clients'
 * reconnects after a service restart; keeping half the step keeps the backoff a backoff.
 */
export const backoffDelayMs = (attempt: number, policy: CloudUpdatesPolicy, random: () => number): number => {
  const step = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.max(0, attempt - 1));
  return step / 2 + random() * (step / 2);
};

/**
 * What may travel as a subprotocol value: an RFC 7230 token. A JWT or a hex token is one. Base64 with `/`, `+` or `=`
 * is not, and `new WebSocket` would throw on it.
 */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Close codes the client uses: a normal close, a refused protocol, and a connection that stopped answering. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_NO_HEARTBEAT = 4000;

/** How many recent events are remembered to drop a repeat. Enough for any overlap of two connections. */
const RECENT_EVENTS = 512;

type SocketConstructor = new (url: string, protocols: string[]) => CloudUpdatesSocket;

const isSocketConstructor = (value: unknown): value is SocketConstructor => typeof value === 'function';

/** The global `WebSocket` as a factory, or `undefined` where there is none. */
const globalSocketFactory = (): CloudUpdatesSocketFactory | undefined => {
  const candidate: unknown = Reflect.get(globalThis, 'WebSocket');
  if (!isSocketConstructor(candidate)) return undefined;
  return (url, protocols) => new candidate(url, [...protocols]);
};

const closeCodeOf = (event: unknown): number | undefined => (isRecord(event) && typeof event.code === 'number' ? event.code : undefined);

const dataOf = (event: unknown): unknown => (isRecord(event) ? event.data : undefined);

/** A key that is the same for two copies of one event and different for any two events. */
const eventKey = (event: CloudUpdateEvent): string => JSON.stringify(projectEvent(event));

/**
 * Subscribe to live updates on the caller's cloud runs. Returns at once; the connection is made in the background,
 * and `onState` says how it goes. Call `close()` to stop.
 */
export const subscribeToCloudUpdates = (options: SubscribeToCloudUpdatesOptions): CloudUpdatesSubscription => {
  const policy: CloudUpdatesPolicy = { ...DEFAULT_CLOUD_UPDATES_POLICY, ...options.policy };
  const random = options.random ?? Math.random;
  const createSocket = options.createSocket ?? globalSocketFactory();
  // The token travels on this address, so it is made wss (loopback excepted) before anything is sent.
  const endpoint = (() => {
    try {
      return ensureSecureWebSocketUrl(options.endpoint, 'The live-updates address');
    } catch {
      return undefined;
    }
  })();

  // One subscription's state. Local to this closure and never handed out.
  interface Connection {
    readonly socket: CloudUpdatesSocket;
    pingOutstanding: boolean;
    heartbeat?: ReturnType<typeof setInterval>;
    rotation?: ReturnType<typeof setTimeout>;
  }
  const live: {
    stopped: boolean;
    attempt: number;
    everOpened: boolean;
    active?: Connection;
    candidate?: Connection;
    retry?: ReturnType<typeof setTimeout>;
  } = { stopped: false, attempt: 0, everOpened: false };
  const counts = { delivered: 0, invalid: 0, otherEnvironment: 0, duplicates: 0, heartbeats: 0, handlerErrors: 0 };
  const recent = { keys: [] as string[], seen: new Set<string>() };

  const report = (state: CloudUpdatesState, detail: Omit<CloudUpdatesStateDetail, 'attempt'> = {}): void => {
    try {
      options.onState?.(state, { attempt: live.attempt, ...detail });
    } catch {
      counts.handlerErrors += 1;
    }
  };

  const stopTimers = (connection: Connection): void => {
    if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat);
    if (connection.rotation !== undefined) clearTimeout(connection.rotation);
    connection.heartbeat = undefined;
    connection.rotation = undefined;
  };

  const closeQuietly = (connection: Connection, code: number, reason: string): void => {
    stopTimers(connection);
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already closing or closed: nothing more to do.
    }
  };

  /** Stop for good: no timer and no socket is left behind. */
  const stop = (): void => {
    live.stopped = true;
    if (live.retry !== undefined) clearTimeout(live.retry);
    live.retry = undefined;
    for (const connection of [live.active, live.candidate]) {
      if (connection !== undefined) closeQuietly(connection, CLOSE_NORMAL, 'closed by the client');
    }
    live.active = undefined;
    live.candidate = undefined;
  };

  const giveUp = (reason: string): void => {
    if (live.stopped) return;
    stop();
    report('giving-up', { reason });
  };

  /** A connection attempt failed, or an open connection dropped: wait, then try again, or give up. */
  const scheduleRetry = (code?: number): void => {
    if (live.stopped) return;
    live.attempt += 1;
    if (live.attempt >= policy.maxAttempts) {
      giveUp(`no connection after ${live.attempt} attempts in a row`);
      return;
    }
    const retryInMs = backoffDelayMs(live.attempt, policy, random);
    report('closed', { retryInMs, ...(code === undefined ? {} : { code }) });
    // A reconnect schedule: nothing waits on it for correctness.
    live.retry = setTimeout(() => {
      live.retry = undefined;
      void connect();
    }, retryInMs);
  };

  /**
   * A connection attempt failed. With a connection still open, it was the planned replacement, and the open one's own
   * end reconnects in time; otherwise wait and try again.
   */
  const attemptFailed = (code?: number): void => {
    if (live.active === undefined) scheduleRetry(code);
  };

  const deliver = (event: CloudUpdateEvent): void => {
    if (event.environmentName !== options.environmentName) {
      counts.otherEnvironment += 1;
      return;
    }
    const key = eventKey(event);
    if (recent.seen.has(key)) {
      counts.duplicates += 1;
      return;
    }
    recent.seen.add(key);
    recent.keys.push(key);
    if (recent.keys.length > RECENT_EVENTS) recent.seen.delete(recent.keys.shift() ?? '');
    counts.delivered += 1;
    try {
      options.onEvent(event);
    } catch {
      counts.handlerErrors += 1;
    }
  };

  const onMessage = (connection: Connection, data: unknown): void => {
    if (live.stopped || (connection !== live.active && connection !== live.candidate)) return;
    // Anything at all from the service shows the connection is alive.
    connection.pingOutstanding = false;
    if (isHeartbeatReply(data)) {
      counts.heartbeats += 1;
      return;
    }
    const event = parseCloudUpdate(data);
    if (event === undefined) {
      counts.invalid += 1;
      return;
    }
    deliver(event);
  };

  /** A heartbeat: each beat checks the last one was answered, then sends the next. */
  const beat = (connection: Connection): void => {
    if (connection.pingOutstanding) {
      // Nothing came back since the last heartbeat: the connection is gone without saying so. Its close event
      // reconnects as any drop does.
      closeQuietly(connection, CLOSE_NO_HEARTBEAT, 'no answer to the heartbeat');
      return;
    }
    connection.pingOutstanding = true;
    try {
      connection.socket.send(CLOUD_UPDATES_HEARTBEAT);
    } catch {
      // A socket that cannot send is closing, and its close event reconnects.
    }
  };

  const onOpen = (connection: Connection): void => {
    if (live.stopped || connection !== live.candidate) {
      closeQuietly(connection, CLOSE_NORMAL, 'not needed');
      return;
    }
    if (connection.socket.protocol !== CLOUD_UPDATES_PROTOCOL) {
      // The service did not agree to reso.v1, so what it sends cannot be read as this contract.
      closeQuietly(connection, CLOSE_PROTOCOL_ERROR, `expected the ${CLOUD_UPDATES_PROTOCOL} subprotocol`);
      return;
    }
    const previous = live.active;
    const kind: CloudUpdatesStateDetail['connection'] = previous !== undefined ? 'rotation' : live.everOpened ? 'reconnect' : 'first';
    live.active = connection;
    live.candidate = undefined;
    live.attempt = 0;
    live.everOpened = true;
    // A retry scheduled while this connection was on its way is not needed now.
    if (live.retry !== undefined) clearTimeout(live.retry);
    live.retry = undefined;
    // A heartbeat inside the idle limit, and a lifetime schedule inside the two-hour limit.
    connection.heartbeat = setInterval(() => beat(connection), policy.heartbeatMs);
    connection.rotation = setTimeout(() => {
      connection.rotation = undefined;
      if (live.active === connection) void connect(true);
    }, policy.rotateAfterMs);
    if (previous !== undefined) closeQuietly(previous, CLOSE_NORMAL, 'replaced by a new connection');
    report('open', { connection: kind });
  };

  const onClose = (connection: Connection, event: unknown): void => {
    stopTimers(connection);
    if (live.stopped) return;
    if (connection === live.candidate) {
      live.candidate = undefined;
      attemptFailed(closeCodeOf(event));
      return;
    }
    if (connection !== live.active) return;
    live.active = undefined;
    // A replacement already on its way decides what happens next.
    if (live.candidate === undefined) scheduleRetry(closeCodeOf(event));
  };

  /**
   * Make a connection. One is either the planned replacement of the open connection or the only one: an attempt that
   * finds a connection already open, or another already on its way, has nothing to do.
   */
  const connect = async (replacing = false): Promise<void> => {
    const needed = (): boolean => !live.stopped && live.candidate === undefined && (replacing || live.active === undefined);
    if (!needed()) return;
    if (createSocket === undefined) {
      giveUp('there is no WebSocket in this runtime; Node 22 or later has one');
      return;
    }
    if (endpoint === undefined) {
      giveUp('the live-updates address is not a usable wss address');
      return;
    }
    report('connecting');
    const token = await (async (): Promise<string | undefined> => {
      try {
        return await options.token();
      } catch {
        return undefined;
      }
    })();
    if (!needed()) return;
    if (!nonEmpty(token)) {
      attemptFailed();
      return;
    }
    if (!SUBPROTOCOL_TOKEN.test(token)) {
      giveUp('the token has characters a WebSocket subprotocol cannot carry');
      return;
    }
    const socket = (() => {
      try {
        return createSocket(endpoint, [CLOUD_UPDATES_PROTOCOL, token]);
      } catch {
        return undefined;
      }
    })();
    if (socket === undefined) {
      attemptFailed();
      return;
    }
    const connection: Connection = { socket, pingOutstanding: false };
    live.candidate = connection;
    socket.addEventListener('open', () => onOpen(connection));
    socket.addEventListener('message', event => onMessage(connection, dataOf(event)));
    socket.addEventListener('close', event => onClose(connection, event));
    // An error is always followed by a close, which is where the next attempt is decided.
    socket.addEventListener('error', () => undefined);
  };

  const close = (): void => {
    if (live.stopped) return;
    stop();
    report('closed');
  };

  void connect();
  return { close, stats: () => ({ ...counts }) };
};
