/**
 * Cloud runs on the CLI: the choice at the end of a successful local run, and `cloud status`.
 *
 * A provider starts a run in RESO's cloud only from a local run that passed and can be certified, never on its
 * own. The plan and the formatters are pure and tested on their own. The Commander wiring in `index.ts` reads
 * `--start-cloud-run` on every endorsement and starts the run through `src/cloud/start.ts`, the path the desktop
 * shares.
 */

import {
  type AnyLocalRunRecord,
  type CloudRunConfig,
  cloudEndorsementOf,
  cloudTargetOf,
  isSuccessfulRun,
  localRunRecordOf,
  whyNoCloudRunBeforeRun
} from '../cloud/local-run.js';
import type {
  AcceptedCloudRun,
  CloudEndorsementName,
  CloudRunReservation,
  CloudRunStatusPage,
  CloudRunStatusRow,
  ReserveCloudRunInput
} from '../cloud/runs.js';
import { type StartCloudRunInput, whyNotSuccessful } from '../cloud/start.js';
import type { PipelineResult } from '../sdk/types.js';
import type { EntryOutcome } from './render.js';
import { cell, renderTable } from './table.js';

/** One config entry as it ran: its label, the configuration that ran and its outcome. Any of the five endorsements. */
export interface RanEntry {
  readonly label: string;
  readonly config: CloudRunConfig;
  readonly outcome: EntryOutcome;
}

/** An entry that is not offered a cloud run, and why. */
export interface NotOffered {
  readonly label: string;
  readonly reason: string;
}

/** The entries that passed and can start a cloud run, grouped as the requests they will go in. */
export interface OfferedGroup {
  readonly endorsementName: CloudEndorsementName;
  readonly endorsementVersion: string;
  readonly entries: ReadonlyArray<{
    readonly label: string;
    readonly config: CloudRunConfig;
    readonly result: PipelineResult;
    readonly record: AnyLocalRunRecord;
  }>;
}

export interface CloudPlan {
  readonly groups: ReadonlyArray<OfferedGroup>;
  readonly notOffered: ReadonlyArray<NotOffered>;
  /** How many entries passed and can start a cloud run. */
  readonly offered: number;
}

const NO_TARGET = 'it does not name the provider, system and recipient a cloud run is addressed to, or did not record what it certified';

type Classified =
  | {
      readonly offered: true;
      readonly label: string;
      readonly config: CloudRunConfig;
      readonly result: PipelineResult;
      readonly record: AnyLocalRunRecord;
    }
  | { readonly offered: false; readonly label: string; readonly reason: string };

const classify = ({ label, config, outcome }: RanEntry, now: Date): Classified => {
  if ('error' in outcome) return { offered: false, label, reason: 'it stopped before producing a result' };
  if (!isSuccessfulRun(outcome.result)) return { offered: false, label, reason: whyNotSuccessful(outcome.result) };
  const record = localRunRecordOf(outcome.result, config, now);
  return record === undefined
    ? { offered: false, label, reason: NO_TARGET }
    : { offered: true, label, config, result: outcome.result, record };
};

/**
 * The cloud runs a set of local runs can start. Only an entry that passed and can be certified is offered. Every
 * other entry is named with its reason, and nothing is sent for it. A request names one endorsement and version, so
 * entries that ran at different versions go separately.
 */
export const planCloudRuns = (entries: ReadonlyArray<RanEntry>, now: Date = new Date()): CloudPlan => {
  const classified = entries.map(e => classify(e, now));
  const qualified = classified.flatMap(c => (c.offered ? [c] : []));
  const notOffered = classified.flatMap(c => (c.offered ? [] : [{ label: c.label, reason: c.reason }]));
  const keys = [...new Set(qualified.map(q => `${q.record.endorsementName} ${q.record.endorsementVersion}`))];
  const groups = keys.map(key => {
    const entries = qualified.filter(q => `${q.record.endorsementName} ${q.record.endorsementVersion}` === key);
    const first = entries[0];
    return {
      endorsementName: cloudEndorsementOf(first.config),
      endorsementVersion: first.record.endorsementVersion,
      entries: entries.map(({ label, config, result, record }) => ({ label, config, result, record }))
    };
  });
  return { groups, notOffered, offered: qualified.length };
};

/**
 * What `--start-cloud-run` refuses before a config-file run, read from each entry: every entry a cloud run could never
 * start from, named with why, so a long run is not spent on it. `undefined` when every entry may go on. The flags the
 * CLI reads are checked by the command; this reads what the file set.
 */
export const entriesRefusedBeforeRun = (
  entries: ReadonlyArray<{ readonly label: string; readonly config: CloudRunConfig }>
): string | undefined => {
  const refused = entries.flatMap(({ label, config }) => {
    const why = whyNoCloudRunBeforeRun(config);
    return why === undefined ? [] : [`  ✗ ${label}: ${why}`];
  });
  if (refused.length === 0) return undefined;
  return [
    '--start-cloud-run starts from entries that can be certified and sent, and these cannot:',
    ...refused,
    'Fix them in the config file, or run without --start-cloud-run.'
  ].join('\n');
};

/**
 * What `--start-cloud-run` refuses on `dd` from the flags alone, before the config file is read: a flag that makes
 * the run uncertifiable. `--limit` is a sample limit for local testing, so a run with one starts no cloud run
 * whatever the file says, and the refusal names the flag rather than the file. The entry's own `ddOptions.limit` is
 * read by `entriesRefusedBeforeRun` once the file is.
 */
export const ddFlagsRefusedBeforeRun = (flags: {
  readonly strict?: boolean;
  readonly skipVariations?: boolean;
  readonly limit?: string;
}): string | undefined => {
  if (flags.strict === false || flags.skipVariations) {
    return '--start-cloud-run starts from a run that can be certified, which a run with --no-strict or --skip-variations is not.';
  }
  if (flags.limit !== undefined) {
    return '--start-cloud-run starts from a run that can be certified, and a run with --limit uses a sample limit, which is for local testing and cannot be certified. Remove --limit to start a cloud run.';
  }
  return undefined;
};

/** Said at the end of a run with entries that qualify, when `--start-cloud-run` was not given. */
export const cloudRunHint = (offered: number): string =>
  `${offered} passed and can be certified. To start a certification run in RESO's cloud at the end of a run like this one, add --start-cloud-run.`;

/** The entries left out, one line each. */
export const formatNotOffered = (notOffered: ReadonlyArray<NotOffered>): string =>
  [`Not sent to RESO's cloud (${notOffered.length}):`, ...notOffered.map(n => `  ✗ ${n.label}: ${n.reason}`)].join('\n');

/** How the choice is made: `--start-cloud-run`, given with the run. Nothing waits for an answer. */
export interface CloudOfferMode {
  readonly startCloudRun: boolean;
  /** `--output json`: what was started is printed as JSON, still on stderr, so stdout stays the run's JSON. */
  readonly json: boolean;
}

/** The offer's side effects, injected so it can be tested without a network. */
export interface CloudOfferIo {
  readonly say: (text: string) => void;
  /** Reserve a request ID for the entries that passed. Called only once they have. */
  readonly reserve: (input: Omit<ReserveCloudRunInput, 'bearerToken' | 'fromCli'>) => Promise<CloudRunReservation>;
  /** Start the cloud run from that reservation: `startCloudRun`, with the CLI's auth. */
  readonly start: (input: Omit<StartCloudRunInput, 'servicesAuthToken' | 'fromCli'>) => Promise<ReadonlyArray<AcceptedCloudRun>>;
}

export type CloudOfferOutcome = 'none' | 'hinted' | 'started' | 'failed';

/** What a run of these entries is for, and how many of the provider's recipients the service may run at once. */
export interface CloudOffer {
  readonly providerUoi: string;
  readonly concurrency?: number;
  /** What the endorsement is called in what the CLI prints. */
  readonly endorsementLabel: string;
}

const targetOf = (record: AnyLocalRunRecord) => ({
  recipientUoi: record.recipientUoi,
  providerUsi: record.providerUsi,
  ...('serviceRootUri' in record ? { serviceRootUri: record.serviceRootUri } : {})
});

/**
 * Present the choice at the end of a run, for any endorsement. Only `--start-cloud-run` starts anything. Without
 * it, a run with entries that qualify says how to choose it next time, and nothing waits for input.
 *
 * With it, the entries that passed are reserved, never before they pass, and the cloud run starts from that
 * reservation through `startCloudRun`. A reservation or a start the service refuses is reported with its reason,
 * and the other groups are still sent.
 */
export const offerCloudRuns = async (
  offer: CloudOffer,
  plan: CloudPlan,
  mode: CloudOfferMode,
  io: CloudOfferIo
): Promise<CloudOfferOutcome> => {
  if (plan.offered === 0) {
    if (mode.startCloudRun) {
      io.say('No entry passed and can be certified, so no cloud run was started.');
      if (plan.notOffered.length > 0) io.say(formatNotOffered(plan.notOffered));
    }
    return 'none';
  }
  if (!mode.startCloudRun) {
    io.say(cloudRunHint(plan.offered));
    return 'hinted';
  }
  if (plan.notOffered.length > 0) io.say(formatNotOffered(plan.notOffered));

  const sent = await plan.groups.reduce<Promise<ReadonlyArray<boolean>>>(async (done, group) => {
    const previous = await done;
    try {
      const reservation = await io.reserve({
        endorsementName: group.endorsementName,
        endorsementVersion: group.endorsementVersion,
        providerUoi: offer.providerUoi,
        targets: group.entries.map(e => targetOf(e.record))
      });
      const runs = await io.start({
        endorsementName: group.endorsementName,
        endorsementVersion: group.endorsementVersion,
        providerUoi: offer.providerUoi,
        ...(offer.concurrency === undefined ? {} : { concurrency: offer.concurrency }),
        localRuns: group.entries.map(e => ({
          config: e.config,
          result: e.result,
          certificationRequestId: reservation.certificationRequestId,
          description: e.label
        }))
      });
      for (const run of runs) io.say(mode.json ? JSON.stringify(run) : formatAcceptedRun(run, offer.endorsementLabel));
      return [...previous, true];
    } catch (error) {
      io.say(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return [...previous, false];
    }
  }, Promise.resolve([]));
  return sent.every(Boolean) ? 'started' : 'failed';
};

/** The identifiers a run names, for the label of an entry run without a configuration file. */
export const cloudTargetLabel = (config: CloudRunConfig): string | undefined => {
  const target = cloudTargetOf(config);
  return target === undefined ? undefined : `${target.recipientUoi}, system ${target.providerUsi}`;
};

const present = (value: string | undefined): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * Why `--start-cloud-run` cannot send a pass, checked before the run so a long run is not wasted: RESO's service
 * address and one set of credentials have to be there. Names only, never values. `undefined` when all is set.
 */
export const cloudRunPrerequisite = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const clientCredentials = present(env.TOKEN_URI) && present(env.CLIENT_ID) && present(env.CLIENT_SECRET);
  const providerToken = present(env.CERT_AUTH_API_BASE_URL) && present(env.CERT_AUTH_API_USERNAME) && present(env.CERTIFICATION_API_KEY);
  if (present(env.RESO_SERVICES_URL) && (clientCredentials || providerToken)) return undefined;
  return (
    "--start-cloud-run sends a pass to RESO's service, so it needs RESO_SERVICES_URL and either TOKEN_URI, CLIENT_ID " +
    'and CLIENT_SECRET or the CERT_AUTH_API_* set, from your credentials file or the environment.'
  );
};

/** What was started, and how to follow it. */
export const formatAcceptedRun = (run: AcceptedCloudRun, endorsementLabel: string): string =>
  [
    `Started ${endorsementLabel} ${run.endorsementVersion} in RESO's cloud for ${run.providerUoi}.`,
    `Request: ${run.certificationRequestId}`,
    `Recipients (${run.recipients.length}):`,
    ...run.recipients.map(r => `  ${r.recipientUoi}, system ${cell(r.providerUsi)}`),
    'Follow it with: reso-cert cloud status --in-progress'
  ].join('\n');

/** What a row says about how its run ended or where it is: the error, else the step's message, else the step. */
const detailOf = (row: CloudRunStatusRow): unknown => row.error ?? row.stepMessage ?? row.step;

/** A timestamp to the second, without the zone's milliseconds. */
const toSecond = (value: unknown): unknown => (typeof value === 'string' ? value.slice(0, 19) : value);

const STATUS_HEADERS: ReadonlyArray<string> = ['request', 'recipient', 'endorsement', 'version', 'status', 'updated', 'report', 'detail'];

/** One line per recipient of each run, newest change first, as the service ordered them. */
export const formatRunStatusTable = (page: CloudRunStatusPage): string => {
  if (page.results.length === 0) return 'No cloud runs.';
  const rows = page.results.map(row => [
    cell(row.certificationRequestId),
    cell(row.recipientConfigId),
    cell(row.endorsementName),
    cell(row.endorsementVersion),
    cell(row.status),
    cell(toSecond(row.statusTimestamp)),
    cell(row.reportId),
    cell(detailOf(row))
  ]);
  const table = renderTable(STATUS_HEADERS, rows);
  return page.hasMore ? `${table}\nMore runs match than are shown. Narrow with --since.` : table;
};
