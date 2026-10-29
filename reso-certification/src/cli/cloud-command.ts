/**
 * Cloud runs on the CLI: the choice at the end of a successful local run, and `cloud status`.
 *
 * A provider starts a run in RESO's cloud only from a local run that passed and can be certified, never on its
 * own. The plan and the formatters are pure and tested on their own. The Commander wiring in `index.ts` asks, or
 * reads `--start-cloud-run`, and sends the requests through `src/cloud/runs.ts`.
 */

import { type CloudConfigEntry, type LocalRunRecord, cloudEntryOf, isSuccessfulRun, localRunRecordOf } from '../cloud/local-run.js';
import type { AcceptedCloudRun, CloudRunStatusPage, CloudRunStatusRow } from '../cloud/runs.js';
import type { CoreConfig, PipelineResult } from '../sdk/types.js';
import type { EntryOutcome } from './render.js';
import { cell, renderTable } from './table.js';

/** One config entry as it ran: its label, the configuration that ran and its outcome. */
export interface RanEntry {
  readonly label: string;
  readonly config: CoreConfig;
  readonly outcome: EntryOutcome;
}

/** An entry that is not offered a cloud run, and why. */
export interface NotOffered {
  readonly label: string;
  readonly reason: string;
}

/** The body of one cloud request: the entries to run and the local run each one passed. */
export interface CloudRequestBody {
  readonly providerUoi: string;
  readonly concurrency?: number;
  readonly configs: ReadonlyArray<CloudConfigEntry>;
  readonly localRuns: ReadonlyArray<LocalRunRecord>;
}

/** One request to send. A request names one version, so entries that ran at different versions go separately. */
export interface PlannedCloudRequest {
  readonly endorsementVersion: string;
  readonly labels: ReadonlyArray<string>;
  readonly body: CloudRequestBody;
}

export interface CloudPlan {
  readonly requests: ReadonlyArray<PlannedCloudRequest>;
  readonly notOffered: ReadonlyArray<NotOffered>;
  /** How many entries passed and can start a cloud run. */
  readonly offered: number;
}

/** Why a run did not succeed, in words a person can act on. Only for display: `isSuccessfulRun` decides. */
const whyNotSuccessful = (result: PipelineResult): string => {
  if (result.status === 'incomplete') return 'it did not finish';
  if (result.status !== 'passed') return 'it failed';
  return result.certification.valid ? 'it did not pass' : `it cannot be certified: ${result.certification.reasons.join('; ')}`;
};

const NO_TARGET = 'it does not name the provider, system and recipient a cloud run is addressed to';

type Classified =
  | { readonly offered: true; readonly label: string; readonly entry: CloudConfigEntry; readonly record: LocalRunRecord }
  | { readonly offered: false; readonly label: string; readonly reason: string };

const classify = ({ label, config, outcome }: RanEntry, now: Date): Classified => {
  if ('error' in outcome) return { offered: false, label, reason: 'it stopped before producing a result' };
  if (!isSuccessfulRun(outcome.result)) return { offered: false, label, reason: whyNotSuccessful(outcome.result) };
  const entry = cloudEntryOf(config, label);
  const record = localRunRecordOf(outcome.result, config, now);
  return entry === undefined || record === undefined
    ? { offered: false, label, reason: NO_TARGET }
    : { offered: true, label, entry, record };
};

/**
 * The cloud requests a set of local runs can start. Only an entry that passed and can be certified is offered.
 * Every other entry is named with its reason, and nothing is sent for it.
 */
export const planCloudRequests = (
  providerUoi: string,
  concurrency: number | undefined,
  entries: ReadonlyArray<RanEntry>,
  now: Date = new Date()
): CloudPlan => {
  const classified = entries.map(e => classify(e, now));
  const qualified = classified.flatMap(c => (c.offered ? [c] : []));
  const notOffered = classified.flatMap(c => (c.offered ? [] : [{ label: c.label, reason: c.reason }]));

  const versions = [...new Set(qualified.map(q => q.record.endorsementVersion))];
  const requests = versions.map(endorsementVersion => {
    const group = qualified.filter(q => q.record.endorsementVersion === endorsementVersion);
    return {
      endorsementVersion,
      labels: group.map(q => q.label),
      body: {
        providerUoi,
        ...(concurrency === undefined ? {} : { concurrency }),
        configs: group.map(q => q.entry),
        localRuns: group.map(q => q.record)
      }
    };
  });
  return { requests, notOffered, offered: qualified.length };
};

/** The question asked in a terminal. The answer defaults to no. */
export const cloudRunQuestion = (offered: number, total: number): string =>
  `${offered} of ${total} passed and can be certified. Start a certification run in RESO's cloud for ${offered === 1 ? 'it' : 'them'}? [y/N] `;

/** Only an explicit yes starts anything. */
export const isYes = (answer: string): boolean => /^\s*y(es)?\s*$/i.test(answer);

/** Said when no terminal can be asked and no flag answered in advance. */
export const cloudRunHint = (offered: number): string =>
  `${offered} passed and can be certified. To start a certification run in RESO's cloud at the end of a run like this one, add --start-cloud-run.`;

/** The entries left out, one line each. */
export const formatNotOffered = (notOffered: ReadonlyArray<NotOffered>): string =>
  [`Not sent to RESO's cloud (${notOffered.length}):`, ...notOffered.map(n => `  ✗ ${n.label}: ${n.reason}`)].join('\n');

/** How the choice is made: answered in advance by `--start-cloud-run`, asked in a terminal, or neither. */
export interface CloudOfferMode {
  readonly startCloudRun: boolean;
  readonly interactive: boolean;
  /** `--output json`: what was started is printed as JSON, still on stderr, so stdout stays the run's JSON. */
  readonly json: boolean;
}

/** The offer's side effects, injected so it can be tested without a terminal or a network. */
export interface CloudOfferIo {
  readonly ask: (question: string) => Promise<string>;
  readonly say: (text: string) => void;
  readonly submit: (request: PlannedCloudRequest) => Promise<AcceptedCloudRun>;
}

export type CloudOfferOutcome = 'none' | 'hinted' | 'declined' | 'started' | 'failed';

/**
 * Present the choice at the end of a run. Nothing is started without a yes: `--start-cloud-run`, or "y" typed
 * in a terminal. A request the service refuses is reported with its reason, and the others are still sent.
 */
export const offerCloudRun = async (plan: CloudPlan, total: number, mode: CloudOfferMode, io: CloudOfferIo): Promise<CloudOfferOutcome> => {
  if (plan.offered === 0) {
    if (mode.startCloudRun) {
      io.say('No entry passed and can be certified, so no cloud run was started.');
      if (plan.notOffered.length > 0) io.say(formatNotOffered(plan.notOffered));
    }
    return 'none';
  }
  if (!mode.startCloudRun && !mode.interactive) {
    io.say(cloudRunHint(plan.offered));
    return 'hinted';
  }
  if (plan.notOffered.length > 0) io.say(formatNotOffered(plan.notOffered));
  if (!mode.startCloudRun && !isYes(await io.ask(cloudRunQuestion(plan.offered, total)))) {
    io.say('No cloud run was started.');
    return 'declined';
  }

  const sent = await plan.requests.reduce<Promise<ReadonlyArray<boolean>>>(async (done, request) => {
    const previous = await done;
    try {
      const run = await io.submit(request);
      io.say(mode.json ? JSON.stringify(run) : formatAcceptedRun(run, 'Web API Core'));
      return [...previous, true];
    } catch (error) {
      io.say(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return [...previous, false];
    }
  }, Promise.resolve([]));
  return sent.every(Boolean) ? 'started' : 'failed';
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
