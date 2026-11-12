/**
 * Restore a certification run's stored results to a Cert API: publish them as the run itself would have.
 *
 * A stored run is the results directory a cloud run keeps, laid out as it is stored:
 *
 *   <endorsement>-<version>/<providerUoi>-<providerUsi>/<recipientUoi>/<run id>/
 *       metadata-report.json  data-availability-report.json  report.json  ...
 *
 * so `--path` can be any directory above it, down to the run itself. The path is the run's identity: nothing
 * about who the report belongs to is guessed or taken from a flag that could disagree with it.
 *
 * Only a Data Dictionary run, and only one that passed and is certifiable. A failed result posted over a
 * provider's standing passed report replaces it, so a failed run is refused rather than sent. A certified or
 * revoked report is never replaced by the API, whatever is posted.
 *
 * Publishing is the same two posts a cloud run makes: the metadata report, cut to the keys the route accepts,
 * then the availability report against the report id the first post returned. The provider is emailed only
 * when asked, and only once both reports are on file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** The files a stored run holds that restore reads. */
export const RUN_FILES = {
  METADATA: 'metadata-report.json',
  AVAILABILITY: 'data-availability-report.json',
  SUMMARY: 'report.json'
} as const;

/** The stored endorsement names restore can publish, and the Cert API report type each posts as. */
const PUBLISHABLE_ENDORSEMENTS: Readonly<Record<string, string>> = {
  'data-dictionary': 'data_dictionary'
};

/**
 * The top-level keys the Cert API's report route accepts. Its body schema is closed, so a key outside this list
 * (a Data Dictionary metadata report carries `resources`, `actions` and `functions`) is refused with a 400.
 * Items inside `fields` and `lookups` are open objects and pass through untouched.
 */
export const CERT_API_METADATA_REPORT_KEYS: ReadonlyArray<string> = [
  'description',
  'version',
  'generatedOn',
  'odataVersion',
  'authentication',
  'fields',
  'lookups',
  'parameters',
  'status',
  'totalResourcesCount',
  'localResourcesCount',
  'localLookupsCount',
  'advertised',
  'iDXFieldsCount',
  'iDXLookupsCount',
  'iDXResourcesCount',
  'totalLookupsCount',
  'standardLookupsCount',
  'localFieldsCount',
  'standardFieldsCount',
  'standardResourcesCount',
  'totalFieldsCount',
  'remarks',
  'softwareVersion',
  'outcome'
];

/** The keys the route requires, all strings. */
const REQUIRED_METADATA_REPORT_KEYS: ReadonlyArray<string> = ['description', 'version', 'generatedOn'];

/** The administrator route that emails the provider about a report already on file. */
export const NOTIFY_PROVIDER_PATH = '/api/v1/certification/provider/notify';

/** The route emails the provider by default when this header is absent, so every post sends it. */
const SEND_NOTIFICATION_HEADER = 'send_notification';

/** As many characters of a server message as are repeated. */
const MESSAGE_LIMIT = 300;

/** Who a stored run belongs to and what it is, read from its path. */
export interface RunIdentity {
  readonly endorsement: string;
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly runId: string;
}

/** A stored run found under `--path`. */
export interface StoredRun extends RunIdentity {
  /** Absolute path of the run's directory. */
  readonly path: string;
  /** The run's directory relative to `--path`. The ledger key, and what the summary prints. */
  readonly key: string;
}

/** A path segment that can be part of an identity: no separators, no dot-segments, nothing blank. */
const isSegment = (value: string): boolean => value !== '' && value !== '.' && value !== '..' && !/[\\/\s]/.test(value);

/** Split `<name>-<suffix>` at its last dash, or undefined when either side would be empty. */
const splitLastDash = (value: string): readonly [string, string] | undefined => {
  const at = value.lastIndexOf('-');
  return at > 0 && at < value.length - 1 ? [value.slice(0, at), value.slice(at + 1)] : undefined;
};

/**
 * A run's identity from its directory's last four path segments, or undefined when they do not have the
 * stored layout. The endorsement directory is `<endorsement>-<version>` (`data-dictionary-2.1`), so the
 * version is what follows the dash that precedes the first digit.
 */
export const parseRunPath = (runPath: string): RunIdentity | undefined => {
  const segments = resolve(runPath).split(sep).filter(Boolean);
  if (segments.length < 4) return undefined;
  const [endorsementDir, providerDir, recipientUoi, runId] = segments.slice(-4) as [string, string, string, string];
  const endorsementMatch = /^(.+?)-(\d[\w.]*)$/.exec(endorsementDir);
  const provider = splitLastDash(providerDir);
  if (!endorsementMatch || !provider) return undefined;
  const [, endorsement, version] = endorsementMatch as unknown as [string, string, string];
  const [providerUoi, providerUsi] = provider;
  const parts = [endorsement, version, providerUoi, providerUsi, recipientUoi, runId];
  return parts.every(isSegment) ? { endorsement, version, providerUoi, providerUsi, recipientUoi, runId } : undefined;
};

/** True when a directory holds the three files that make it a stored run. */
const isRunDirectory = (dir: string): boolean =>
  [RUN_FILES.METADATA, RUN_FILES.AVAILABILITY, RUN_FILES.SUMMARY].every(name => existsSync(join(dir, name)));

/**
 * Every stored run at or under `root`, in a stable order. A directory that holds the run files but not the
 * stored layout is reported separately, so the summary can say why it was left alone.
 */
export const findStoredRuns = (root: string): { readonly runs: ReadonlyArray<StoredRun>; readonly unplaced: ReadonlyArray<string> } => {
  const base = resolve(root);
  const walk = (dir: string): ReadonlyArray<string> => {
    if (isRunDirectory(dir)) return [dir];
    return readdirSync(dir)
      .sort()
      .map(entry => join(dir, entry))
      .filter(full => statSync(full).isDirectory())
      .flatMap(walk);
  };
  const found = existsSync(base) && statSync(base).isDirectory() ? walk(base) : [];
  const placed = found.map(path => ({ path, identity: parseRunPath(path) }));
  return {
    runs: placed.flatMap(({ path, identity }) =>
      identity ? [{ ...identity, path, key: relative(base, path) || relative(resolve(base, '..'), path) }] : []
    ),
    unplaced: placed.filter(({ identity }) => !identity).map(({ path }) => path)
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJsonObject = (path: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} does not hold a JSON object`);
  return parsed;
};

/**
 * Whether a run may be published, from its `report.json`: only `outcome: "passed"` with no `certification`
 * key, which the SDK writes only when a run is NOT eligible for certification.
 */
export const runVerdict = (summary: unknown): { readonly publishable: true } | { readonly publishable: false; readonly reason: string } => {
  if (!isRecord(summary)) return { publishable: false, reason: 'report.json does not hold a report' };
  if (summary.outcome !== 'passed') {
    return {
      publishable: false,
      reason: `the run's outcome is ${JSON.stringify(summary.outcome ?? null)}, and only a passed run is restored`
    };
  }
  if (summary.certification !== undefined) {
    return { publishable: false, reason: 'the run passed but is not eligible for certification' };
  }
  return { publishable: true };
};

/** The metadata report cut to the keys the route accepts, and the keys that were cut. */
export const projectMetadataReport = (
  report: Readonly<Record<string, unknown>>
): { readonly body: Readonly<Record<string, unknown>>; readonly droppedKeys: ReadonlyArray<string> } => {
  const missing = REQUIRED_METADATA_REPORT_KEYS.filter(key => typeof report[key] !== 'string' || report[key] === '');
  if (missing.length > 0) throw new Error(`The metadata report is missing ${missing.join(', ')}`);
  const accepted = new Set(CERT_API_METADATA_REPORT_KEYS);
  const entries = Object.entries(report);
  return {
    body: Object.fromEntries(entries.filter(([key]) => accepted.has(key))),
    droppedKeys: entries
      .map(([key]) => key)
      .filter(key => !accepted.has(key))
      .sort()
  };
};

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RunRestoreOptions {
  readonly path: string;
  /** The Cert API origin, `https://` and no path. */
  readonly origin: string;
  readonly execute: boolean;
  /** Ask the API to email each provider once both of its reports are on file. */
  readonly notifyProvider: boolean;
  /** Runs already restored, by key, and where to record new ones. */
  readonly done: ReadonlySet<string>;
  readonly record: (key: string) => void;
  /** Only called when there is something to send, so a dry run needs no credential. */
  readonly authorize: () => Promise<string>;
  readonly limit?: number;
  readonly fetchFn?: FetchFn;
}

export type RunRestoreStatus = 'published' | 'would-publish' | 'refused' | 'failed' | 'already-done';

export interface RunRestoreOutcome {
  readonly key: string;
  readonly identity: RunIdentity;
  readonly status: RunRestoreStatus;
  readonly reportId?: string;
  readonly reason?: string;
  readonly droppedKeys?: ReadonlyArray<string>;
}

/** A failed request's status and the first part of what the server said. */
const failureOf = async (step: string, response: Response): Promise<string> =>
  `${step}: HTTP ${response.status} ${(await response.text()).slice(0, MESSAGE_LIMIT)}`;

/**
 * Restore every stored run under `options.path`, one at a time.
 *
 * A dry run reads each run and reports what would be posted, and sends nothing. With `execute`, each
 * publishable run is posted, recorded in the ledger once both reports are on file, and its provider emailed
 * when `notifyProvider` is set. A run that fails is reported and the next one is tried.
 */
export const runRunRestore = async (
  options: RunRestoreOptions,
  log: (line: string) => void
): Promise<{ readonly outcomes: ReadonlyArray<RunRestoreOutcome>; readonly unplaced: ReadonlyArray<string> }> => {
  const { runs, unplaced } = findStoredRuns(options.path);
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const selected = options.limit === undefined ? runs : runs.slice(0, options.limit);
  // Minted at most once, and only when the first run is actually sent.
  const authorization = ((): (() => Promise<string>) => {
    let pending: Promise<string> | undefined;
    return () => {
      if (pending === undefined) pending = options.authorize();
      return pending;
    };
  })();

  // A redirect is never followed: each request carries the credential, and a 307 or 308 would replay it, body
  // and all, to whatever host the redirect names. A 3xx comes back as itself and is reported as a failure.
  const send = (url: string, init: RequestInit): Promise<Response> => fetchFn(url, { ...init, redirect: 'manual' });

  const publish = async (run: StoredRun, reportType: string, body: unknown, availability: unknown): Promise<string> => {
    const json = { Authorization: await authorization(), 'Content-Type': 'application/json' };
    const created = await send(`${options.origin}/api/v1/certification_reports/${reportType}/${encodeURIComponent(run.providerUoi)}`, {
      method: 'POST',
      headers: { ...json, recipientUoi: run.recipientUoi, providerUsi: run.providerUsi, [SEND_NOTIFICATION_HEADER]: 'false' },
      body: JSON.stringify(body)
    });
    if (!created.ok) throw new Error(await failureOf('Metadata report post', created));
    const createdBody: unknown = JSON.parse(await created.text());
    const reportId = isRecord(createdBody) && typeof createdBody.id === 'string' ? createdBody.id : undefined;
    if (reportId === undefined) throw new Error('Metadata report post succeeded but returned no report id');

    const posted = await send(`${options.origin}/api/v1/payload/data_availability/${encodeURIComponent(reportId)}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(availability)
    });
    if (!posted.ok) throw new Error(await failureOf(`Availability report post for report ${reportId}`, posted));
    await posted.text();
    options.record(run.key);

    if (options.notifyProvider) {
      const notified = await send(`${options.origin}${NOTIFY_PROVIDER_PATH}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: reportId })
      });
      if (notified.ok) await notified.text();
      // Both reports are on file and recorded; only the email failed, and it can be sent again on its own.
      else log(`  ${run.key}: published as ${reportId}, but the provider email failed: ${await failureOf('Provider email', notified)}`);
    }
    return reportId;
  };

  const restoreOne = async (run: StoredRun): Promise<RunRestoreOutcome> => {
    const { path, key, ...identity } = run;
    const base = { key, identity };
    if (options.done.has(key)) return { ...base, status: 'already-done' };
    const reportType = PUBLISHABLE_ENDORSEMENTS[identity.endorsement];
    if (reportType === undefined) {
      return { ...base, status: 'refused', reason: `restore publishes Data Dictionary runs only, and this is ${identity.endorsement}` };
    }
    try {
      const verdict = runVerdict(readJsonObject(join(path, RUN_FILES.SUMMARY)));
      if (!verdict.publishable) return { ...base, status: 'refused', reason: verdict.reason };
      const { body, droppedKeys } = projectMetadataReport(readJsonObject(join(path, RUN_FILES.METADATA)));
      const availability = readJsonObject(join(path, RUN_FILES.AVAILABILITY));
      if (!options.execute) return { ...base, status: 'would-publish', droppedKeys };
      const reportId = await publish(run, reportType, body, availability);
      return { ...base, status: 'published', reportId, droppedKeys };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`  ${key}: ${reason}`);
      return { ...base, status: 'failed', reason };
    }
  };

  // One run at a time, in order: each publish is a pair of writes to a live API.
  const outcomes = await selected.reduce<Promise<ReadonlyArray<RunRestoreOutcome>>>(
    async (previous, run) => [...(await previous), await restoreOne(run)],
    Promise.resolve([])
  );
  return { outcomes, unplaced };
};
