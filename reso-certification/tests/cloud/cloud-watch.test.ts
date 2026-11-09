import { describe, expect, it, vi } from 'vitest';
import {
  type CloudWatchIo,
  type CloudWatchRequest,
  type CloudWatchSubscribeInput,
  cloudWatchPrerequisite,
  runCloudWatch
} from '../../src/cli/cloud-watch.js';
import type { CloudRunStatusPage } from '../../src/cloud/runs.js';
import type { CloudUpdateEvent } from '../../src/cloud/updates.js';

/**
 * `reso-cert cloud watch`: one line per update, a running tally, `--until-done` with its exit codes, the status read
 * at the start and after a drop, and a give-up that says so instead of falling back to polling.
 *
 * Identities here are synthetic.
 */

const ENV = 'qa';
const A = 'qa-T00000000-1700000000001';
const B = 'qa-T00000000-1700000000002';
const C = 'qa-T00000000-1700000000003';

const row = (certificationRequestId: string, recipientUoi: string, status: string, statusTimestamp: string, over = {}) => ({
  certificationRequestId,
  recipientConfigId: `${recipientUoi}-50000`,
  environmentName: ENV,
  endorsementName: 'data-dictionary',
  endorsementVersion: '2.1',
  status,
  statusTimestamp,
  providerUoi: 'T00000000',
  ...over
});

const event = (
  certificationRequestId: string,
  recipientUoi: string,
  status: string,
  statusTimestamp: string,
  over: Partial<CloudUpdateEvent> = {}
): CloudUpdateEvent => ({
  v: 1,
  kind: 'run',
  environmentName: ENV,
  providerUoi: 'T00000000',
  providerUsi: '50000',
  recipientUoi,
  endorsementName: 'data-dictionary',
  version: '2.1',
  certificationRequestId,
  reportId: null,
  status,
  statusTimestamp,
  ...over
});

const page = (...results: ReadonlyArray<Record<string, unknown>>): CloudRunStatusPage => ({ results, hasMore: false });

const request = (over: Partial<CloudWatchRequest> = {}): CloudWatchRequest => ({
  requestIds: [],
  endorsements: [],
  untilDone: false,
  json: false,
  ...over
});

/** The CLI's side effects, recorded. Each status read answers with the next page given, the last one repeating. */
const harness = (pages: ReadonlyArray<CloudRunStatusPage>, isTty = false) => {
  const out: string[] = [];
  const err: string[] = [];
  const subscriptions: Array<{ readonly input: CloudWatchSubscribeInput; closed: boolean }> = [];
  const interrupt: { handler?: () => void } = {};
  const queue = [...pages];
  const readStatus = vi.fn(async () => (queue.length > 1 ? (queue.shift() as CloudRunStatusPage) : queue[0]));
  const io: CloudWatchIo = {
    readStatus,
    subscribe: input => {
      const subscription = { input, closed: false };
      subscriptions.push(subscription);
      return {
        close: () => {
          subscription.closed = true;
        }
      };
    },
    write: text => {
      out.push(text);
    },
    warn: line => {
      err.push(line);
    },
    isTty,
    onInterrupt: handler => {
      interrupt.handler = handler;
      return () => {
        interrupt.handler = undefined;
      };
    }
  };
  const stream = () => subscriptions[0].input;
  return { io, out, err, subscriptions, interrupt, readStatus, stream, stdout: () => out.join('') };
};

/** Let the status read and the subscribe after it settle. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('cloud watch: lines and the tally', () => {
  it('prints one line per update, and on a pipe the tally at the start and at the end', async () => {
    const h = harness([
      page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'), row(C, 'M00000000', 'passed', '2026-11-01T00:00:00.000Z'))
    ]);
    const done = runCloudWatch(request(), h.io);
    await flush();

    expect(h.stream().environmentName).toBe(ENV);
    h.stream().onEvent(event(A, 'M00000123', 'passed', '2026-11-04T18:05:00.000Z', { reportId: 'report-1' }));
    h.interrupt.handler?.();

    await expect(done).resolves.toBe(0);
    const lines = h.stdout().trimEnd().split('\n');
    expect(lines[0]).toBe('0 scheduled · 1 running · 0 passed · 0 failed · 0 error');
    expect(lines[1]).toBe(`2026-11-04T18:05:00  passed     ${A}  M00000123, system 50000  data-dictionary 2.1  report report-1`);
    expect(lines[2]).toBe('0 scheduled · 0 running · 1 passed · 0 failed · 0 error');
    expect(lines).toHaveLength(3);
    expect(h.subscriptions[0].closed).toBe(true);
    expect(h.interrupt.handler).toBeUndefined();
  });

  it('keeps the tally on one line on a terminal, rewritten in place under each update', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))], true);
    const done = runCloudWatch(request(), h.io);
    await flush();
    h.stream().onEvent(event(A, 'M00000123', 'failed', '2026-11-04T18:05:00.000Z'));
    h.interrupt.handler?.();
    await done;

    const text = h.stdout();
    expect(text.startsWith('\r\x1b[2K0 scheduled · 1 running')).toBe(true);
    expect(text).toContain(`\r\x1b[2K2026-11-04T18:05:00  failed     ${A}`);
    expect(text).toContain('\n\r\x1b[2K0 scheduled · 0 running · 0 passed · 1 failed · 0 error');
    expect(text.endsWith('0 error\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('narrows to the requests named, repeated, and to an endorsement', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))]);
    const done = runCloudWatch(request({ requestIds: [A, B], endorsements: ['data-dictionary'] }), h.io);
    await flush();

    h.stream().onEvent(event(C, 'M00000000', 'passed', '2026-11-04T18:01:00.000Z'));
    h.stream().onEvent(event(B, 'M00000000', 'passed', '2026-11-04T18:02:00.000Z', { endorsementName: 'web-api-core' }));
    h.stream().onEvent(event(B, 'M00000000', 'running', '2026-11-04T18:03:00.000Z'));
    h.interrupt.handler?.();
    await done;

    const updates = h
      .stdout()
      .split('\n')
      .filter(line => line.startsWith('2026'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(B);
    expect(updates[0]).toContain('running');
  });

  it('prints each update as the service sent it, one JSON object per line, with --json', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))]);
    const done = runCloudWatch(request({ json: true }), h.io);
    await flush();
    const update = event(A, 'M00000123', 'passed', '2026-11-04T18:05:00.000Z');
    h.stream().onEvent(update);
    h.interrupt.handler?.();
    await done;

    expect(h.stdout()).toBe(`${JSON.stringify(update)}\n`);
    expect(h.err.join('\n')).toContain('0 scheduled · 0 running · 1 passed · 0 failed · 0 error');
  });
});

describe('cloud watch --until-done', () => {
  it('counts runs that finished before it started, and exits 0 once every watched request has passed', async () => {
    const h = harness([
      page(
        row(A, 'M00000123', 'passed', '2026-11-04T17:00:00.000Z'),
        row(A, 'M00000000', 'passed', '2026-11-04T17:00:00.000Z'),
        row(B, 'M00000000', 'running', '2026-11-04T18:00:00.000Z')
      )
    ]);
    const done = runCloudWatch(request({ requestIds: [A, B], untilDone: true }), h.io);
    await flush();

    expect(h.stdout()).toContain('0 scheduled · 1 running · 2 passed · 0 failed · 0 error · 1 of 2 requests finished');
    h.stream().onEvent(event(B, 'M00000000', 'passed', '2026-11-04T18:10:00.000Z'));

    await expect(done).resolves.toBe(0);
    expect(h.stdout().trimEnd().split('\n').at(-1)).toBe(
      '0 scheduled · 0 running · 3 passed · 0 failed · 0 error · 2 of 2 requests finished'
    );
    expect(h.subscriptions[0].closed).toBe(true);
  });

  it('exits 1 when any watched request failed or errored', async () => {
    const h = harness([
      page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'), row(B, 'M00000000', 'scheduled', '2026-11-04T18:00:00.000Z'))
    ]);
    const done = runCloudWatch(request({ requestIds: [A, B], untilDone: true }), h.io);
    await flush();
    h.stream().onEvent(event(A, 'M00000123', 'passed', '2026-11-04T18:10:00.000Z'));
    h.stream().onEvent(event(B, 'M00000000', 'error', '2026-11-04T18:11:00.000Z'));

    await expect(done).resolves.toBe(1);
  });

  it('waits on the runs in progress when no request is named, and exits at once when there are none', async () => {
    const idle = harness([page(row(C, 'M00000000', 'passed', '2026-11-01T00:00:00.000Z'))]);
    await expect(runCloudWatch(request({ untilDone: true }), idle.io)).resolves.toBe(0);
    expect(idle.subscriptions).toHaveLength(0);
    expect(idle.err.join('\n')).toContain('No cloud runs in progress');

    const busy = harness([
      page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'), row(C, 'M00000000', 'passed', '2026-11-01T00:00:00.000Z'))
    ]);
    const done = runCloudWatch(request({ untilDone: true }), busy.io);
    await flush();
    // A run started after the watch began is shown, but is not waited on.
    busy.stream().onEvent(event(B, 'M00000000', 'running', '2026-11-04T18:05:00.000Z'));
    busy.stream().onEvent(event(A, 'M00000123', 'passed', '2026-11-04T18:10:00.000Z'));
    await expect(done).resolves.toBe(0);
  });

  it('keeps every recipient of a run in progress, so one that failed before the watch began still fails it', async () => {
    const h = harness([
      page(
        row(A, 'M00000123', 'failed', '2026-11-04T17:00:00.000Z'),
        row(A, 'M00000000', 'running', '2026-11-04T18:00:00.000Z'),
        row(C, 'M00000000', 'passed', '2026-11-01T00:00:00.000Z')
      )
    ]);
    const done = runCloudWatch(request({ untilDone: true }), h.io);
    await flush();
    expect(h.stdout()).toContain('0 scheduled · 1 running · 0 passed · 1 failed · 0 error · 0 of 1 request finished');
    h.stream().onEvent(event(A, 'M00000000', 'passed', '2026-11-04T18:10:00.000Z'));

    await expect(done).resolves.toBe(1);
  });

  it('exits without subscribing when every watched request had already finished', async () => {
    const h = harness([page(row(A, 'M00000123', 'failed', '2026-11-04T17:00:00.000Z'))]);
    await expect(runCloudWatch(request({ requestIds: [A], untilDone: true }), h.io)).resolves.toBe(1);
    expect(h.subscriptions).toHaveLength(0);
  });

  it('says which named requests are not in the status yet, and waits for them', async () => {
    const h = harness([page(row(A, 'M00000123', 'passed', '2026-11-04T17:00:00.000Z'))]);
    const done = runCloudWatch(request({ requestIds: [A, B], untilDone: true }), h.io);
    await flush();
    expect(h.err.join('\n')).toContain(B);
    h.stream().onEvent(event(B, 'M00000000', 'passed', '2026-11-04T18:10:00.000Z'));
    await expect(done).resolves.toBe(0);
  });

  it('exits 130 on Ctrl-C before the runs finish', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))]);
    const done = runCloudWatch(request({ requestIds: [A], untilDone: true }), h.io);
    await flush();
    h.interrupt.handler?.();
    await expect(done).resolves.toBe(130);
  });
});

describe('cloud watch: the connection', () => {
  it('reads the status once more after a drop, so a run that finished meanwhile is counted', async () => {
    const h = harness([
      page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z')),
      page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z')),
      page(row(A, 'M00000123', 'passed', '2026-11-04T18:20:00.000Z', { reportId: 'report-9' }))
    ]);
    const done = runCloudWatch(request({ requestIds: [A], untilDone: true }), h.io);
    await flush();
    h.stream().onState('open', { attempt: 0, connection: 'first' });
    await flush();
    expect(h.readStatus).toHaveBeenCalledTimes(2);

    h.stream().onState('closed', { attempt: 1, retryInMs: 750, code: 1006 });
    h.stream().onState('open', { attempt: 0, connection: 'rotation' });
    await flush();
    expect(h.readStatus).toHaveBeenCalledTimes(2);
    h.stream().onState('open', { attempt: 0, connection: 'reconnect' });

    await expect(done).resolves.toBe(0);
    expect(h.readStatus).toHaveBeenCalledTimes(3);
    expect(h.stdout()).toContain(`2026-11-04T18:20:00  passed     ${A}  M00000123-50000  data-dictionary 2.1  report report-9`);
  });

  it('says so when the connection gives up, points at cloud status and exits 2, without polling instead', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))]);
    const done = runCloudWatch(request({ requestIds: [A], untilDone: true }), h.io);
    await flush();
    h.stream().onState('giving-up', { attempt: 10, reason: 'no connection after 10 attempts in a row' });

    await expect(done).resolves.toBe(2);
    const said = h.err.join('\n');
    expect(said).toContain('no connection after 10 attempts in a row');
    expect(said).toContain('reso-cert cloud status');
    const reads = h.readStatus.mock.calls.length;
    await flush();
    expect(h.readStatus).toHaveBeenCalledTimes(reads);
  });
});

describe('cloud watch: the environment', () => {
  it('reads the environment off the runs when --env is not given', async () => {
    const h = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z', { environmentName: 'production' }))]);
    const done = runCloudWatch(request(), h.io);
    await flush();
    expect(h.stream().environmentName).toBe('production');
    h.interrupt.handler?.();
    await done;
  });

  it('refuses an --env the credentials are not for, an unknown one, and no way to tell', async () => {
    const mismatch = harness([page(row(A, 'M00000123', 'running', '2026-11-04T18:00:00.000Z'))]);
    await expect(runCloudWatch(request({ environmentName: 'production' }), mismatch.io)).resolves.toBe(2);
    expect(mismatch.err.join('\n')).toMatch(/qa/);
    expect(mismatch.subscriptions).toHaveLength(0);

    const unknown = harness([page()]);
    await expect(runCloudWatch(request({ environmentName: 'prod' }), unknown.io)).resolves.toBe(2);
    expect(unknown.err.join('\n')).toContain('local, qa, staging or production');

    const none = harness([page()]);
    await expect(runCloudWatch(request(), none.io)).resolves.toBe(2);
    expect(none.err.join('\n')).toContain('--env');

    const given = harness([page()]);
    const done = runCloudWatch(request({ environmentName: 'staging' }), given.io);
    await flush();
    expect(given.stream().environmentName).toBe('staging');
    given.interrupt.handler?.();
    await done;
  });

  it('refuses an endorsement name the service does not use', async () => {
    const h = harness([page()]);
    await expect(runCloudWatch(request({ endorsements: ['dd'], environmentName: 'qa' }), h.io)).resolves.toBe(2);
    expect(h.err.join('\n')).toContain('data-dictionary');
    expect(h.readStatus).not.toHaveBeenCalled();
  });
});

describe('cloudWatchPrerequisite', () => {
  it('names what is missing, never a value', () => {
    expect(cloudWatchPrerequisite({})).toMatch(/RESO_CLOUD_UPDATES_URL/);
    const complete = {
      RESO_SERVICES_URL: 'https://services.example.org',
      RESO_CLOUD_UPDATES_URL: 'wss://updates.example.org',
      TOKEN_URI: 'https://cert.example.org/token',
      CLIENT_ID: 'id',
      CLIENT_SECRET: 'reso-example-client-secret'
    };
    expect(cloudWatchPrerequisite(complete)).toBeUndefined();
    const noUpdates = { ...complete, RESO_CLOUD_UPDATES_URL: '' };
    expect(cloudWatchPrerequisite(noUpdates)).toMatch(/RESO_CLOUD_UPDATES_URL/);
    expect(cloudWatchPrerequisite(noUpdates)).not.toContain('reso-example-client-secret');
  });
});
