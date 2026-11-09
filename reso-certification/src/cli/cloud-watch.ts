/**
 * `reso-cert cloud watch`: follow cloud runs live, from RESO's push updates, instead of polling `cloud status`.
 *
 * For someone with many runs going. One line per update, and a running tally of where the watched runs stand,
 * rewritten in place on a terminal and printed at the start and the end on a pipe, so logs stay clean. With
 * `--until-done` it exits once every watched request has finished: 0 when all passed, 1 when any failed or errored, so
 * a script can wait on many runs without polling.
 *
 * The status is read once at the start, so runs that already finished are counted, and then the stream is relied on.
 * It is read once more each time a connection opens after a gap, the first connection and any after a drop, because
 * the service does not replay what it pushed while nobody was connected. That is one read per gap, never a loop. If
 * the connection gives up, the watch says so, points at `cloud status` and exits `2`; it never falls back to polling.
 *
 * Everything that touches the world is injected (`CloudWatchIo`), so the command is tested without a network.
 */

import { CLOUD_ENDORSEMENT, type CloudRunStatusPage, type CloudRunStatusRow } from '../cloud/runs.js';
import type { CloudUpdateEvent, CloudUpdatesState, CloudUpdatesStateDetail } from '../cloud/updates.js';
import { CLOUD_UPDATES_URL_VARIABLE } from '../sdk/common.js';
import { hasCloudCredentials, present } from './cloud-command.js';

/** The four environments a token can name. An `--env` outside them would filter out every event, so it is refused. */
export const CLOUD_ENVIRONMENT_NAMES: ReadonlyArray<string> = ['local', 'qa', 'staging', 'production'];

/** The most rows one status read asks for: the service's own maximum. */
export const STATUS_READ_LIMIT = 500;

/** The exit code after Ctrl-C ended an `--until-done` watch before the runs finished. */
export const INTERRUPTED_EXIT_CODE = 130;

/** The statuses a run's row goes through, in the order the tally shows them. */
const TALLY_STATUSES = ['scheduled', 'running', 'passed', 'failed', 'error'] as const;
type TallyStatus = (typeof TALLY_STATUSES)[number];

const TALLIED: ReadonlySet<string> = new Set(TALLY_STATUSES);
const IN_PROGRESS: ReadonlySet<string> = new Set(['scheduled', 'running']);
const FINISHED: ReadonlySet<string> = new Set(['passed', 'failed', 'error']);
const NOT_PASSED: ReadonlySet<string> = new Set(['failed', 'error']);
const ENDORSEMENT_NAMES: ReadonlyArray<string> = Object.values(CLOUD_ENDORSEMENT);

/** Clears the terminal line the cursor is on, so the tally is rewritten rather than repeated. */
const CLEAR_LINE = '\r\x1b[2K';

/** What was asked for on the command line. */
export interface CloudWatchRequest {
  /** Only these requests. Empty means every run. */
  readonly requestIds: ReadonlyArray<string>;
  /** Only these endorsements, by the names the service uses. Empty means every endorsement. */
  readonly endorsements: ReadonlyArray<string>;
  /** The environment the credentials are for. Read off the runs when absent. */
  readonly environmentName?: string;
  readonly untilDone: boolean;
  /** Each update as the service sent it, one JSON object per line, and no tally on stdout. */
  readonly json: boolean;
}

/** What the watch hands the subscription. The endpoint and the token are the caller's to supply. */
export interface CloudWatchSubscribeInput {
  readonly environmentName: string;
  readonly onEvent: (event: CloudUpdateEvent) => void;
  readonly onState: (state: CloudUpdatesState, detail: CloudUpdatesStateDetail) => void;
}

/** The watch's side effects. */
export interface CloudWatchIo {
  /** One read of the caller's runs: `listCloudRunStatus`. */
  readonly readStatus: () => Promise<CloudRunStatusPage>;
  /** `subscribeToCloudUpdates`, with the endpoint and the token filled in. */
  readonly subscribe: (input: CloudWatchSubscribeInput) => { readonly close: () => void };
  /** Write to stdout as given. No newline is added. */
  readonly write: (text: string) => void;
  /** One line to stderr. */
  readonly warn: (line: string) => void;
  /** True when stdout is a terminal, so the tally can be rewritten in place. */
  readonly isTty: boolean;
  /** Call `handler` on Ctrl-C. Returns a function that stops listening. */
  readonly onInterrupt: (handler: () => void) => () => void;
}

/** One recipient of one run, from a status row or an event: the shape the watch keeps and prints. */
interface WatchedRun {
  /** The request and the recipient, as the service keys its rows. */
  readonly key: string;
  readonly certificationRequestId: string;
  /** The recipient as printed. */
  readonly recipient: string;
  readonly environmentName?: string;
  readonly endorsementName?: string;
  readonly version?: string;
  readonly status: string;
  readonly statusTimestamp: string;
  readonly reportId?: string;
  readonly notice: boolean;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** A status row as a watched run, or `undefined` when it lacks what one needs. */
const runOfRow = (row: CloudRunStatusRow): WatchedRun | undefined => {
  const certificationRequestId = text(row.certificationRequestId);
  const recipient = text(row.recipientConfigId);
  const status = text(row.status);
  const statusTimestamp = text(row.statusTimestamp);
  if (!certificationRequestId || !recipient || !status || !statusTimestamp) return undefined;
  return {
    key: `${certificationRequestId} ${recipient}`,
    certificationRequestId,
    recipient,
    environmentName: text(row.environmentName),
    endorsementName: text(row.endorsementName),
    version: text(row.endorsementVersion),
    status,
    statusTimestamp,
    reportId: text(row.reportId),
    notice: false
  };
};

const runsOfPage = (page: CloudRunStatusPage): ReadonlyArray<WatchedRun> =>
  page.results.flatMap(row => {
    const run = runOfRow(row);
    return run === undefined ? [] : [run];
  });

/** An event as a watched run. Its key matches the row's: the service keys a recipient as `{recipientUoi}-{providerUsi}`. */
const runOfEvent = (event: CloudUpdateEvent): WatchedRun => ({
  key: `${event.certificationRequestId} ${event.recipientUoi}-${event.providerUsi}`,
  certificationRequestId: event.certificationRequestId,
  recipient: `${event.recipientUoi}, system ${event.providerUsi}`,
  environmentName: event.environmentName,
  endorsementName: event.endorsementName,
  version: event.version,
  status: event.status,
  statusTimestamp: event.statusTimestamp,
  reportId: event.reportId ?? undefined,
  notice: event.kind === 'notice'
});

const timeOf = (timestamp: string): number | undefined => {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
};

/** True unless what is held is known to be newer: a read and the stream can arrive in either order. */
const supersedes = (incoming: WatchedRun, held: WatchedRun | undefined): boolean => {
  if (held === undefined) return true;
  const incomingAt = timeOf(incoming.statusTimestamp);
  const heldAt = timeOf(held.statusTimestamp);
  return incomingAt === undefined || heldAt === undefined || incomingAt >= heldAt;
};

/** One update as one line: when, the status, the request, the recipient, the endorsement and the report. */
const formatUpdateLine = (run: WatchedRun): string =>
  [
    run.statusTimestamp.slice(0, 19),
    run.status.padEnd(9),
    run.certificationRequestId,
    run.recipient,
    [run.endorsementName, run.version].filter(Boolean).join(' '),
    ...(run.reportId === undefined ? [] : [`report ${run.reportId}`]),
    ...(run.notice ? ['(notice)'] : [])
  ]
    .filter(part => part !== '')
    .join('  ');

interface Progress {
  readonly finished: number;
  readonly total: number;
  readonly failed: boolean;
}

/** How many watched requests have finished: every recipient known and in a final status. */
const progressOf = (runs: ReadonlyArray<WatchedRun>, watched: ReadonlySet<string>): Progress => {
  const requests = [...watched].map(id => runs.filter(run => run.certificationRequestId === id));
  return {
    finished: requests.filter(rows => rows.length > 0 && rows.every(run => FINISHED.has(run.status))).length,
    total: watched.size,
    failed: runs.some(run => watched.has(run.certificationRequestId) && NOT_PASSED.has(run.status))
  };
};

const formatTally = (runs: ReadonlyArray<WatchedRun>, progress: Progress | undefined): string => {
  const count = (status: TallyStatus): number => runs.filter(run => run.status === status).length;
  const tally = TALLY_STATUSES.map(status => `${count(status)} ${status}`).join(' · ');
  if (progress === undefined) return tally;
  return `${tally} · ${progress.finished} of ${progress.total} ${progress.total === 1 ? 'request' : 'requests'} finished`;
};

/**
 * Why `cloud watch` cannot start: the live-updates address, the status address and one set of credentials have to be
 * there. Names only, never values. `undefined` when all is set.
 */
export const cloudWatchPrerequisite = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const missing = [
    ...(present(env[CLOUD_UPDATES_URL_VARIABLE]) ? [] : [CLOUD_UPDATES_URL_VARIABLE]),
    ...(present(env.RESO_SERVICES_URL) ? [] : ['RESO_SERVICES_URL']),
    ...(hasCloudCredentials(env) ? [] : ['TOKEN_URI, CLIENT_ID and CLIENT_SECRET (or the CERT_AUTH_API_* set)'])
  ];
  if (missing.length === 0) return undefined;
  const needs = `${CLOUD_UPDATES_URL_VARIABLE}, RESO_SERVICES_URL and one set of credentials, from your credentials file or the environment`;
  return `cloud watch follows your runs through RESO's live updates, so it needs ${needs}. Not set: ${missing.join('; ')}.`;
};

/** What the command line asked for that can never match anything, refused before anything is read. */
const requestRefusal = (request: CloudWatchRequest): string | undefined => {
  if (request.environmentName !== undefined && !CLOUD_ENVIRONMENT_NAMES.includes(request.environmentName)) {
    return `--env must be local, qa, staging or production, got '${request.environmentName}'.`;
  }
  const unknown = request.endorsements.filter(name => !ENDORSEMENT_NAMES.includes(name));
  if (unknown.length > 0) {
    return `--endorsement must be one of ${ENDORSEMENT_NAMES.join(', ')}, got '${unknown.join("', '")}'.`;
  }
  if (request.requestIds.some(id => id.trim() === '')) return '--request needs a request ID.';
  return undefined;
};

type EnvironmentChoice = { readonly name: string } | { readonly refusal: string };

/**
 * The environment to watch. The status route lists only the runs in the environment the credentials name, so the
 * runs say which one it is. A given `--env` has to agree with them; with no runs to read, `--env` has to be given.
 */
const environmentOf = (given: string | undefined, runs: ReadonlyArray<WatchedRun>): EnvironmentChoice => {
  const seen = [...new Set(runs.flatMap(run => (run.environmentName === undefined ? [] : [run.environmentName])))];
  if (given !== undefined) {
    const other = seen.find(name => name !== given);
    return other === undefined
      ? { name: given }
      : { refusal: `--env is ${given}, but your credentials are for ${other}. Leave --env out, or use the credentials for ${given}.` };
  }
  if (seen.length === 1) return { name: seen[0] };
  return {
    refusal:
      seen.length === 0
        ? 'No cloud runs are listed for your credentials yet, so their environment cannot be read from them. Pass --env with it: local, qa, staging or production.'
        : `Your runs are in more than one environment (${seen.join(', ')}). Pass --env to choose one.`
  };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Watch the caller's cloud runs until Ctrl-C or, with `--until-done`, until every watched request has finished.
 * Resolves with the exit code: 0, 1 (with `--until-done`, a run failed or errored), 2 (could not watch) or 130
 * (Ctrl-C before `--until-done` was done).
 */
export const runCloudWatch = async (request: CloudWatchRequest, io: CloudWatchIo): Promise<number> => {
  const refusal = requestRefusal(request);
  if (refusal !== undefined) {
    io.warn(`Error: ${refusal}`);
    return 2;
  }
  const requestIds: ReadonlySet<string> = new Set(request.requestIds);
  const endorsements: ReadonlySet<string> = new Set(request.endorsements);
  const scoped = requestIds.size > 0;
  const admits = (run: WatchedRun): boolean =>
    (!scoped || requestIds.has(run.certificationRequestId)) &&
    (endorsements.size === 0 || (run.endorsementName !== undefined && endorsements.has(run.endorsementName)));

  const start = await io.readStatus().then(
    page => ({ page }),
    (error: unknown) => ({ error })
  );
  if ('error' in start) {
    io.warn(`Error: ${messageOf(start.error)}`);
    return 2;
  }
  const startRuns = runsOfPage(start.page);
  const environment = environmentOf(request.environmentName, startRuns);
  if ('refusal' in environment) {
    io.warn(`Error: ${environment.refusal}`);
    return 2;
  }

  // Without --request, the runs watched are those in progress, each with every recipient it has: one recipient that
  // already failed fails the run, however the others end.
  const admitted = startRuns.filter(run => admits(run) && TALLIED.has(run.status));
  const inProgress = new Set(admitted.filter(run => IN_PROGRESS.has(run.status)).map(run => run.certificationRequestId));

  // Everything below is one watch's state: local to this call and never handed out.
  const tracked = new Map<string, WatchedRun>(
    admitted.filter(run => scoped || inProgress.has(run.certificationRequestId)).map(run => [run.key, run])
  );
  const watched: ReadonlySet<string> | undefined = request.untilDone
    ? scoped
      ? requestIds
      : new Set([...tracked.values()].map(run => run.certificationRequestId))
    : undefined;
  if (watched !== undefined && watched.size === 0) {
    io.warn('No cloud runs in progress to wait for.');
    return 0;
  }

  const runs = (): ReadonlyArray<WatchedRun> => [...tracked.values()];
  const progress = (): Progress | undefined => (watched === undefined ? undefined : progressOf(runs(), watched));
  const tally = (): string => formatTally(runs(), progress());
  const human = !request.json;
  const inPlace = human && io.isTty;

  const missing = [...requestIds].filter(id => !runs().some(run => run.certificationRequestId === id));
  if (missing.length > 0) io.warn(`Not in the status yet: ${missing.join(', ')}. Waiting for their updates.`);
  if (scoped && start.page.hasMore) {
    io.warn('More runs changed recently than one status read returns. A request not found in it is waited for on the stream.');
  }

  const startProgress = progress();
  if (startProgress !== undefined && startProgress.finished === startProgress.total) {
    if (human) io.write(`${inPlace ? CLEAR_LINE : ''}${tally()}\n`);
    else io.warn(tally());
    return startProgress.failed ? 1 : 0;
  }

  const scope = scoped ? `${requestIds.size} ${requestIds.size === 1 ? 'request' : 'requests'}` : 'your cloud runs';
  io.warn(`Watching ${scope} in ${environment.name}${endorsements.size > 0 ? ` (${[...endorsements].join(', ')})` : ''}. Ctrl-C to stop.`);
  if (inPlace) io.write(`${CLEAR_LINE}${tally()}`);
  else if (human) io.write(`${tally()}\n`);

  return new Promise<number>(resolve => {
    const state: { finished: boolean; subscription?: { readonly close: () => void }; stopInterrupt?: () => void } = { finished: false };

    /** A message on stderr. On a terminal, the tally line is cleared first and drawn again after. */
    const say = (line: string): void => {
      if (inPlace) io.write(CLEAR_LINE);
      io.warn(line);
      if (inPlace) io.write(`${CLEAR_LINE}${tally()}`);
    };

    const show = (line: string): void => {
      if (inPlace) io.write(`${CLEAR_LINE}${line}\n${CLEAR_LINE}${tally()}`);
      else io.write(`${line}\n`);
    };

    const finish = (code: number): void => {
      if (state.finished) return;
      state.finished = true;
      state.subscription?.close();
      state.stopInterrupt?.();
      if (inPlace) io.write('\n');
      else if (human) io.write(`${tally()}\n`);
      else io.warn(tally());
      resolve(code);
    };

    const finishIfDone = (): void => {
      const now = progress();
      if (now !== undefined && now.finished === now.total) finish(now.failed ? 1 : 0);
    };

    /** Keep a run's newest status. Returns true when it changed what is held. */
    const keep = (run: WatchedRun): boolean => {
      if (!TALLIED.has(run.status)) return false;
      const held = tracked.get(run.key);
      if (!supersedes(run, held)) return false;
      tracked.set(run.key, run);
      return held?.status !== run.status;
    };

    const onEvent = (event: CloudUpdateEvent): void => {
      if (state.finished) return;
      const run = runOfEvent(event);
      if (!admits(run)) return;
      keep(run);
      show(human ? formatUpdateLine(run) : JSON.stringify(event));
      finishIfDone();
    };

    /** One read after a gap in the connection, for what the stream could not carry while nobody was connected. */
    const catchUp = (): void => {
      io.readStatus().then(
        page => {
          if (state.finished) return;
          const known = new Set(runs().map(run => run.certificationRequestId));
          const changed = runsOfPage(page)
            .filter(run => admits(run) && (scoped || known.has(run.certificationRequestId) || IN_PROGRESS.has(run.status)))
            .filter(keep);
          if (human) for (const run of changed) show(formatUpdateLine(run));
          else if (changed.length > 0) io.warn(`${changed.length} changed while the connection was down; the tally includes them.`);
          finishIfDone();
        },
        (error: unknown) => {
          if (!state.finished) say(`Could not read where your runs stand after connecting: ${messageOf(error)}`);
        }
      );
    };

    const onState = (status: CloudUpdatesState, detail: CloudUpdatesStateDetail): void => {
      if (state.finished) return;
      if (status === 'open') {
        if (detail.connection === 'reconnect') say("Reconnected to RESO's live updates.");
        if (detail.connection !== 'rotation') catchUp();
        return;
      }
      if (status === 'closed' && detail.retryInMs !== undefined) {
        say(`Not connected to RESO's live updates. Trying again in ${Math.ceil(detail.retryInMs / 1000)}s.`);
        return;
      }
      if (status === 'giving-up') {
        say(
          `Stopped watching: could not stay connected to RESO's live updates (${detail.reason ?? 'no reason given'}). ` +
            `See where your runs stand with: reso-cert cloud status${scoped ? '' : ' --in-progress'}`
        );
        finish(2);
      }
    };

    state.stopInterrupt = io.onInterrupt(() => finish(request.untilDone ? INTERRUPTED_EXIT_CODE : 0));
    const subscription = io.subscribe({ environmentName: environment.name, onEvent, onState });
    // A subscription can give up before `subscribe` returns, and then there is nothing left to keep open.
    if (state.finished) subscription.close();
    else state.subscription = subscription;
  });
};
