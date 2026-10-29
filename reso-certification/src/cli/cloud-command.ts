/**
 * `cloud core` and `cloud status`: certification runs in RESO's cloud, from the CLI. The configuration
 * reader and the formatters are here (tested on their own). The Commander wiring in `index.ts` calls
 * `src/cloud/runs.ts` and prints either the JSON (`--json`) or these lines.
 */

import { readFile } from 'node:fs/promises';
import type { AcceptedCloudRun, CloudRunStatusPage, CloudRunStatusRow } from '../cloud/runs.js';
import { registerSecret } from './secrets.js';
import { cell, renderTable } from './table.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringAt = (record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
};

/** The entries of either shape a configuration file uses. */
const entriesOf = (config: unknown): ReadonlyArray<unknown> => {
  if (!isRecord(config)) return [];
  if (Array.isArray(config.configs)) return config.configs;
  if (Array.isArray(config.recipients)) return config.recipients;
  return [];
};

/**
 * Every credential a configuration file carries: a bearer token or a client secret, at the top of an
 * entry (the CLI's shape) or under `auth` (the desktop's export).
 */
export const credentialsIn = (config: unknown): ReadonlyArray<string> =>
  entriesOf(config)
    .filter(isRecord)
    .flatMap(entry => {
      const clientCredentials = isRecord(entry.clientCredentials) ? entry.clientCredentials : undefined;
      const auth = isRecord(entry.auth) ? entry.auth : undefined;
      return [
        stringAt(entry, 'token'),
        stringAt(clientCredentials, 'clientSecret'),
        stringAt(auth, 'authToken'),
        stringAt(auth, 'clientSecret')
      ];
    })
    .filter((value): value is string => value !== undefined && value !== '');

/**
 * A configuration file for a cloud run, parsed and not normalized, so the service reads what was
 * written. Its credentials are registered for masking first, because anything printed after this
 * could quote one.
 *
 * A file that is not JSON is refused without the parser's own message, which quotes the text around
 * the fault and so can quote a credential.
 */
export const readCloudConfig = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf-8');
  const config: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`The configuration file ${path} is not valid JSON.`);
    }
  })();
  for (const secret of credentialsIn(config)) registerSecret(secret);
  return config;
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
