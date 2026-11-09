import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_UPDATES_HEARTBEAT,
  CLOUD_UPDATES_PROTOCOL,
  type CloudUpdateEvent,
  type CloudUpdatesSocket,
  type CloudUpdatesState,
  type CloudUpdatesStateDetail,
  DEFAULT_CLOUD_UPDATES_POLICY,
  backoffDelayMs,
  parseCloudUpdate,
  subscribeToCloudUpdates
} from '../../src/cloud/updates.js';
import { resolveCloudUpdatesUrl } from '../../src/sdk/common.js';

/**
 * Live cloud-run updates over a WebSocket, against a fake socket: the token travels in the subprotocol and is asked
 * for again on every connect, only v1 events reach the caller, reconnects back off and stop when asked, a heartbeat
 * keeps the connection inside the idle limit, and the connection is replaced before the two-hour limit.
 *
 * Identities and tokens here are synthetic.
 */

const ENDPOINT = 'wss://updates.example.org/test';
const ENVIRONMENT = 'qa';

interface FakeSocket extends CloudUpdatesSocket {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly sent: string[];
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }>;
  readonly open: (protocol?: string) => void;
  readonly receive: (data: unknown) => void;
  readonly drop: (code?: number) => void;
}

/**
 * A fake WebSocket factory that records every socket it makes. A close fires its event at once. With `answerPings`,
 * each socket answers a heartbeat as the service's `$default` route does.
 */
const fakeSockets = (answerPings = true) => {
  const sockets: FakeSocket[] = [];
  const createSocket = (url: string, protocols: ReadonlyArray<string>): CloudUpdatesSocket => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const emit = (type: string, event: unknown): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const state = { protocol: '', closed: false };
    const finish = (code: number, reason: string): void => {
      if (state.closed) return;
      state.closed = true;
      emit('close', { code, reason });
    };
    const sent: string[] = [];
    const closes: Array<{ code?: number; reason?: string }> = [];
    const socket: FakeSocket = {
      url,
      protocols: [...protocols],
      sent,
      closes,
      get protocol() {
        return state.protocol;
      },
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
      },
      send: data => {
        sent.push(data);
        if (answerPings && data === CLOUD_UPDATES_HEARTBEAT) emit('message', { data: JSON.stringify({ action: 'pong' }) });
      },
      close: (code, reason) => {
        closes.push({ code, reason });
        finish(code ?? 1005, reason ?? '');
      },
      open: (protocol = CLOUD_UPDATES_PROTOCOL) => {
        state.protocol = protocol;
        emit('open', {});
      },
      receive: data => emit('message', { data }),
      drop: (code = 1006) => finish(code, '')
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, createSocket };
};

const event = (over: Partial<Record<keyof CloudUpdateEvent, unknown>> = {}): Record<string, unknown> => ({
  v: 1,
  kind: 'run',
  environmentName: ENVIRONMENT,
  providerUoi: 'T00000000',
  providerUsi: '99999',
  recipientUoi: 'M00000000',
  endorsementName: 'data-dictionary',
  version: '2.1',
  certificationRequestId: 'qa-T00000000-1700000000000',
  reportId: null,
  status: 'running',
  statusTimestamp: '2026-11-04T18:00:00.000Z',
  ...over
});

/** Let the token provider's promise and the connect after it settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

type StateCall = readonly [CloudUpdatesState, CloudUpdatesStateDetail];

const subscribe = (over: Partial<Parameters<typeof subscribeToCloudUpdates>[0]> = {}, answerPings = true) => {
  const fake = fakeSockets(answerPings);
  const events: CloudUpdateEvent[] = [];
  const states: StateCall[] = [];
  const subscription = subscribeToCloudUpdates({
    endpoint: ENDPOINT,
    token: async () => 'token-one',
    environmentName: ENVIRONMENT,
    onEvent: e => {
      events.push(e);
    },
    onState: (state, detail) => {
      states.push([state, detail]);
    },
    createSocket: fake.createSocket,
    random: () => 0.5,
    ...over
  });
  return { ...fake, events, states, subscription };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('subscribeToCloudUpdates: the token', () => {
  it('asks for reso.v1 and carries the token as the second subprotocol, never in the address', async () => {
    const { sockets, subscription } = subscribe();
    await settle();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].protocols).toEqual([CLOUD_UPDATES_PROTOCOL, 'token-one']);
    expect(CLOUD_UPDATES_PROTOCOL).toBe('reso.v1');
    expect(sockets[0].url).toBe(ENDPOINT);
    expect(sockets[0].url).not.toContain('token-one');
    subscription.close();
  });

  it('asks the token provider again on every reconnect, so a refreshed token is used', async () => {
    const tokens = ['token-one', 'token-two'];
    const token = vi.fn(async () => tokens.shift());
    const { sockets, subscription } = subscribe({ token });
    await settle();
    sockets[0].open();
    sockets[0].drop();

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs);

    expect(token).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].protocols).toEqual([CLOUD_UPDATES_PROTOCOL, 'token-two']);
    subscription.close();
  });

  it('counts a token provider that throws or has no token as a failed attempt, and tries again', async () => {
    const token = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue('token-three');
    const { sockets, states, subscription } = subscribe({ token });
    await settle();
    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs * 2);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].protocols).toEqual([CLOUD_UPDATES_PROTOCOL, 'token-three']);
    expect(states.filter(([state]) => state === 'closed').length).toBeGreaterThanOrEqual(2);
    subscription.close();
  });

  it('gives up at once on a token that cannot travel as a subprotocol, and never names the token', async () => {
    const { sockets, states, subscription } = subscribe({ token: async () => 'abc/def+ghi==' });
    await settle();

    expect(sockets).toHaveLength(0);
    const last = states.at(-1);
    expect(last?.[0]).toBe('giving-up');
    expect(JSON.stringify(states)).not.toContain('abc/def');
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs * 4);
    expect(sockets).toHaveLength(0);
    subscription.close();
  });

  it('refuses a server that does not answer with reso.v1, and tries again', async () => {
    const { sockets, states, subscription } = subscribe();
    await settle();
    sockets[0].open('');

    expect(sockets[0].closes).toHaveLength(1);
    expect(states.some(([state]) => state === 'open')).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs);
    expect(sockets).toHaveLength(2);
    subscription.close();
  });
});

describe('subscribeToCloudUpdates: the address', () => {
  it('makes the address wss before a token goes on it', async () => {
    const { sockets, subscription } = subscribe({ endpoint: 'ws://updates.example.org/test' });
    await settle();
    expect(sockets[0].url).toBe('wss://updates.example.org/test');
    subscription.close();
  });

  it('gives up on an address that is not a WebSocket one, without asking for a token', async () => {
    const token = vi.fn(async () => 'token-one');
    const { sockets, states, subscription } = subscribe({ endpoint: 'ftp://updates.example.org', token });
    await settle();
    expect(token).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(states.at(-1)?.[0]).toBe('giving-up');
    subscription.close();
  });
});

describe('subscribeToCloudUpdates: what reaches the caller', () => {
  it('delivers a v1 event and drops and counts anything else', async () => {
    const { sockets, events, subscription } = subscribe();
    await settle();
    sockets[0].open();

    sockets[0].receive(JSON.stringify(event({ status: 'passed', reportId: 'report-1' })));
    sockets[0].receive('not json');
    sockets[0].receive(JSON.stringify(event({ v: 2 })));
    sockets[0].receive(JSON.stringify(event({ kind: 'other' })));
    sockets[0].receive(JSON.stringify(event({ status: undefined })));
    sockets[0].receive(JSON.stringify(event({ reportId: 7 })));
    sockets[0].receive(new Uint8Array([1, 2, 3]));
    sockets[0].receive(JSON.stringify(event({ environmentName: 'production' })));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'passed', reportId: 'report-1', certificationRequestId: 'qa-T00000000-1700000000000' });
    expect(subscription.stats()).toMatchObject({ delivered: 1, invalid: 6, otherEnvironment: 1 });
    subscription.close();
  });

  it('never throws into the caller, even when its own handler throws', async () => {
    const onEvent = vi.fn(() => {
      throw new Error('handler broke');
    });
    const { sockets, subscription } = subscribe({ onEvent });
    await settle();
    sockets[0].open();

    expect(() => sockets[0].receive(JSON.stringify(event()))).not.toThrow();
    expect(() => sockets[0].receive(JSON.stringify(event({ status: 'passed' })))).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(2);
    subscription.close();
  });

  it('delivers the same event once, though two connections carry it while one replaces the other', async () => {
    const { sockets, events, subscription } = subscribe();
    await settle();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.rotateAfterMs);

    // The service can push one change to both connections while the new one replaces the old.
    const same = JSON.stringify(event({ status: 'passed' }));
    sockets[0].receive(same);
    sockets[1].open();
    sockets[1].receive(same);

    expect(events).toHaveLength(1);
    expect(subscription.stats().duplicates).toBe(1);
    subscription.close();
  });
});

describe('subscribeToCloudUpdates: reconnecting', () => {
  it('backs off with a delay that grows and caps', () => {
    const policy = { ...DEFAULT_CLOUD_UPDATES_POLICY, initialDelayMs: 1_000, maxDelayMs: 30_000 };
    const highest = [1, 2, 3, 4, 5, 6, 7, 8].map(attempt => backoffDelayMs(attempt, policy, () => 0.999_999));
    const lowest = [1, 2, 3, 4, 5, 6, 7, 8].map(attempt => backoffDelayMs(attempt, policy, () => 0));

    expect(highest.map(Math.round)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(lowest).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  it('waits longer after each failure in a row, up to the cap, then gives up', async () => {
    const policy = { ...DEFAULT_CLOUD_UPDATES_POLICY, initialDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 4 };
    const { sockets, states, subscription } = subscribe({ policy });
    await settle();

    for (const _ of [1, 2, 3, 4]) {
      sockets.at(-1)?.drop();
      await vi.advanceTimersByTimeAsync(policy.maxDelayMs);
    }

    // Four attempts, each dropped: three waits between them, then it stops.
    const waits = states.flatMap(([state, detail]) => (state === 'closed' && detail.retryInMs !== undefined ? [detail.retryInMs] : []));
    expect(waits).toEqual([750, 1_500, 3_000]);
    expect(sockets).toHaveLength(4);
    expect(states.at(-1)?.[0]).toBe('giving-up');
    const made = sockets.length;
    await vi.advanceTimersByTimeAsync(policy.maxDelayMs * 10);
    expect(sockets).toHaveLength(made);
    subscription.close();
  });

  it('starts again from the shortest wait once a connection opens', async () => {
    const policy = { ...DEFAULT_CLOUD_UPDATES_POLICY, initialDelayMs: 1_000, maxDelayMs: 30_000 };
    const { sockets, states, subscription } = subscribe({ policy });
    await settle();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(policy.maxDelayMs);
    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(policy.maxDelayMs);
    sockets[2].open();
    sockets[2].drop();

    const waits = states.flatMap(([state, detail]) => (state === 'closed' && detail.retryInMs !== undefined ? [detail.retryInMs] : []));
    expect(waits).toEqual([750, 1_500, 750]);
    const opens = states.filter(([state]) => state === 'open');
    expect(opens.map(([, detail]) => detail.connection)).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(policy.maxDelayMs);
    sockets[3].open();
    expect(states.filter(([state]) => state === 'open').map(([, detail]) => detail.connection)).toEqual(['first', 'reconnect']);
    subscription.close();
  });

  it('makes one connection when the open one drops while its replacement is still getting a token', async () => {
    const pending: Array<(token: string) => void> = [];
    const token = vi.fn(
      () =>
        new Promise<string>(resolve => {
          pending.push(resolve);
        })
    );
    const { sockets, states, subscription } = subscribe({ token });
    pending.shift()?.('token-one');
    await settle();
    sockets[0].open();

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.rotateAfterMs);
    sockets[0].drop();
    pending.shift()?.('token-two');
    await settle();
    expect(sockets).toHaveLength(2);
    sockets[1].open();

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs);
    for (const resolve of pending) resolve('token-late');
    await settle();
    expect(sockets).toHaveLength(2);
    expect(states.filter(([state]) => state === 'open').map(([, detail]) => detail.connection)).toEqual(['first', 'reconnect']);
    subscription.close();
  });

  it('stops on close: no socket after it, whether it comes while open, while waiting or while the token is minted', async () => {
    const open = subscribe();
    await settle();
    open.sockets[0].open();
    open.subscription.close();
    expect(open.sockets[0].closes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs * 4);
    expect(open.sockets).toHaveLength(1);
    expect(open.states.at(-1)?.[0]).toBe('closed');
    expect(open.states.at(-1)?.[1].retryInMs).toBeUndefined();

    const waiting = subscribe();
    await settle();
    waiting.sockets[0].drop();
    waiting.subscription.close();
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs * 4);
    expect(waiting.sockets).toHaveLength(1);

    const held: { release?: (token: string) => void } = {};
    const minting = subscribe({
      token: () =>
        new Promise<string>(resolve => {
          held.release = resolve;
        })
    });
    minting.subscription.close();
    held.release?.('token-late');
    await settle();
    expect(minting.sockets).toHaveLength(0);
  });
});

describe('subscribeToCloudUpdates: the heartbeat and the two-hour limit', () => {
  it('sends a heartbeat inside the ten-minute idle limit', async () => {
    expect(DEFAULT_CLOUD_UPDATES_POLICY.heartbeatMs).toBeLessThan(10 * 60_000);
    const { sockets, subscription } = subscribe();
    await settle();
    sockets[0].open();
    expect(sockets[0].sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.heartbeatMs);

    expect(sockets[0].sent).toEqual([CLOUD_UPDATES_HEARTBEAT]);
    subscription.close();
  });

  it('keeps a connection that answers its heartbeat, and counts the answer as neither event nor invalid', async () => {
    const { sockets, events, subscription } = subscribe({}, false);
    await settle();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.heartbeatMs);
    sockets[0].receive(JSON.stringify({ action: 'pong' }));
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.heartbeatMs);

    expect(sockets[0].closes).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(events).toHaveLength(0);
    expect(subscription.stats()).toMatchObject({ invalid: 0, heartbeats: 1 });
    subscription.close();
  });

  it('replaces a connection that hears nothing back after a heartbeat', async () => {
    const { sockets, subscription } = subscribe({}, false);
    await settle();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.heartbeatMs * 2);

    expect(sockets[0].closes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs);
    expect(sockets).toHaveLength(2);
    subscription.close();
  });

  it('opens a new connection before the two-hour limit and closes the old one only once the new one is open', async () => {
    expect(DEFAULT_CLOUD_UPDATES_POLICY.rotateAfterMs).toBeLessThan(2 * 60 * 60_000);
    const { sockets, states, subscription } = subscribe();
    await settle();
    sockets[0].open();

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.rotateAfterMs);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closes).toHaveLength(0);

    sockets[1].open();
    expect(sockets[0].closes).toHaveLength(1);
    expect(states.filter(([state]) => state === 'open').map(([, detail]) => detail.connection)).toEqual(['first', 'rotation']);
    // The old connection's close is its own retirement, not a drop: nothing reconnects.
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_UPDATES_POLICY.maxDelayMs);
    expect(sockets).toHaveLength(2);
    subscription.close();
  });
});

describe('parseCloudUpdate', () => {
  it('reads a v1 event and keeps only the contract fields', () => {
    const parsed = parseCloudUpdate(JSON.stringify({ ...event({ kind: 'notice' }), extra: 'dropped' }));
    expect(parsed).toEqual(event({ kind: 'notice' }));
  });

  it('refuses each way a message can miss the contract', () => {
    const bad = [
      event({ v: '1' }),
      event({ kind: undefined }),
      event({ environmentName: '' }),
      event({ certificationRequestId: 42 }),
      event({ reportId: '' }),
      event({ statusTimestamp: undefined }),
      [event()],
      null
    ];
    for (const message of bad) expect(parseCloudUpdate(JSON.stringify(message))).toBeUndefined();
    expect(parseCloudUpdate(`${JSON.stringify(event())}${' '.repeat(70_000)}`)).toBeUndefined();
  });
});

describe('resolveCloudUpdatesUrl', () => {
  const original = process.env.RESO_CLOUD_UPDATES_URL;
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    if (original === undefined) delete process.env.RESO_CLOUD_UPDATES_URL;
    else process.env.RESO_CLOUD_UPDATES_URL = original;
  });

  it('reads RESO_CLOUD_UPDATES_URL as a wss address', () => {
    process.env.RESO_CLOUD_UPDATES_URL = 'updates.example.org/test/';
    expect(resolveCloudUpdatesUrl()).toBe('wss://updates.example.org/test');
    process.env.RESO_CLOUD_UPDATES_URL = 'https://updates.example.org/test';
    expect(resolveCloudUpdatesUrl()).toBe('wss://updates.example.org/test');
    process.env.RESO_CLOUD_UPDATES_URL = 'ws://updates.example.org/test';
    expect(resolveCloudUpdatesUrl()).toBe('wss://updates.example.org/test');
  });

  it('leaves a loopback address as it is', () => {
    process.env.RESO_CLOUD_UPDATES_URL = 'ws://localhost:3001';
    expect(resolveCloudUpdatesUrl()).toBe('ws://localhost:3001');
  });

  it('refuses an unset value or another scheme, naming the variable', () => {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.RESO_CLOUD_UPDATES_URL;
    expect(() => resolveCloudUpdatesUrl()).toThrow(/RESO_CLOUD_UPDATES_URL is not set/);
    process.env.RESO_CLOUD_UPDATES_URL = 'ftp://updates.example.org';
    expect(() => resolveCloudUpdatesUrl()).toThrow(/RESO_CLOUD_UPDATES_URL/);
  });
});
