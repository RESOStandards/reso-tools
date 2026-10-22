import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** A single report file found in a backup, with everything the restore needs to post it. */
export interface BackupReport {
  /** Absolute path on disk. */
  readonly path: string;
  /** Path relative to the backup root. The ledger key, and what the summary prints. */
  readonly key: string;
  /** The endorsement-type directory this sits under, e.g. `data_dictionary-2.0`. */
  readonly endorsement: string;
  /**
   * Whether this report was archived on the server it came from.
   *
   * Taken from the path rather than from a flag: the backup puts archived reports under their own
   * `archived/` tree, so the directory already knows. A flag would let a run mark a live report
   * archived, or restore an archived one as live, and nothing would catch it.
   */
  readonly archived: boolean;
}

const REPORT_FILE = /\.json(\.gz)?$/;

/** Endorsement directory name to the `type` the server expects, for backups that predate the field. */
const TYPE_BY_ENDORSEMENT: Readonly<Record<string, string>> = {
  data_dictionary: 'data_dictionary',
  web_api_server_core: 'web_api_server_core',
  reso_common_format: 'reso_common_format',
  add_edit: 'add_edit',
  webhooks: 'webhooks'
};

/**
 * The `type` a directory implies, and only when the document agrees.
 *
 * An older backup can hold a report written before `type` existed, which the server refuses. The
 * directory names the endorsement and the version, and the document carries its own `version`. A
 * type is derived ONLY when those two agree - one source alone would be a guess, and writing a
 * guessed type into a certification record is worse than leaving the record out.
 *
 * Returns undefined when they disagree, when the directory is unrecognized, or when the document
 * is a different shape entirely, such as an archived record rather than a report.
 */
export const deriveReportType = (endorsement: string, documentVersion: unknown): string | undefined => {
  const separator = endorsement.lastIndexOf('-');
  if (separator <= 0) return undefined;
  const name = endorsement.slice(0, separator);
  const directoryVersion = endorsement.slice(separator + 1);
  if (directoryVersion !== documentVersion) return undefined;
  return TYPE_BY_ENDORSEMENT[name];
};

/** Every report file under `root`, depth-first and in a stable order. */
export const findBackupReports = (root: string): ReadonlyArray<BackupReport> => {
  const base = resolve(root);

  const walk = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir)
      .sort()
      .flatMap(entry => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : REPORT_FILE.test(entry) ? [full] : [];
      });

  return walk(base).map(path => {
    const key = relative(base, path);
    const segments = key.split(sep);
    const archived = segments[0] === 'archived';
    return {
      path,
      key,
      // Under `archived/` the type directory is one level deeper.
      endorsement: (archived ? segments[1] : segments[0]) ?? 'unknown',
      archived
    };
  });
};

/** Read one report, transparently gunzipping the `.gz` the backup actually contains. */
export const readBackupReport = (path: string): unknown => {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
};

/**
 * The credential to present, from the environment.
 *
 * `CLIENT_SECRET` first: it is what the certification site's downloaded file carries, and it is
 * already `base64(keyId:apiKey)` - the exact bytes the server's Bearer envelope decodes - so one
 * downloaded file drives this tool with nothing to convert. `CERTIFICATION_API_KEY` is accepted
 * for an environment already set up for the older tools.
 */
export const resolveRestoreCredential = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.CLIENT_SECRET ?? env.CERTIFICATION_API_KEY;

export interface RestoreOutcome {
  readonly key: string;
  readonly status: number;
  readonly message: string;
}

/** Read the ledger, which holds one already-restored key per line. */
const readLedger = (path: string): ReadonlySet<string> =>
  existsSync(path) ? new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean)) : new Set();

export interface RestoreOptions {
  readonly path: string;
  readonly url: string;
  readonly execute: boolean;
  readonly limit?: number;
  readonly concurrency: number;
  readonly ledgerPath: string;
  /** Supply a missing `type` where the directory and the document's own version agree. */
  readonly deriveMissingType: boolean;
}

export interface RestoreSummary {
  readonly considered: number;
  readonly alreadyDone: number;
  readonly sent: number;
  readonly succeeded: number;
  readonly failures: ReadonlyArray<RestoreOutcome>;
  readonly byEndorsement: ReadonlyMap<string, number>;
  /** Reports with no `type` of their own. Refused by the server unless one is derived. */
  readonly missingType: number;
  /** Of those, how many a type could be derived for. The rest are a different shape. */
  readonly derivable: number;
}

/**
 * Post one report to the server's restore endpoint.
 *
 * The credential is sent as a Bearer. The response body is read for its message only - it is an
 * error message, and the point of reading it is to say WHY a report was refused rather than just
 * that it was.
 */
const postReport = async (url: string, credential: string, report: unknown): Promise<Omit<RestoreOutcome, 'key'>> => {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/v1/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify(report)
    });
    const text = await response.text();
    return { status: response.status, message: text.slice(0, 300) };
  } catch (error) {
    return { status: 0, message: error instanceof Error ? error.message : String(error) };
  }
};

/** Run `tasks` with at most `limit` in flight, preserving nothing but the side effects. */
const withConcurrency = async <T>(items: ReadonlyArray<T>, limit: number, run: (item: T) => Promise<void>): Promise<void> => {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await run(next);
  });
  await Promise.all(workers);
};

/**
 * Restore a backup to a certification server.
 *
 * Defaults to a dry run. Nothing is sent without `execute`, because this writes to whatever server
 * it is pointed at and the cost of discovering that afterwards is a reindex.
 */
export const runRestore = async (options: RestoreOptions, log: (line: string) => void): Promise<RestoreSummary> => {
  const credential = resolveRestoreCredential();
  if (options.execute && !credential) {
    throw new Error('No credential. Set CLIENT_SECRET (the value from the downloaded credentials file) or CERTIFICATION_API_KEY.');
  }

  const done = readLedger(options.ledgerPath);
  const all = findBackupReports(options.path);
  const pending = all.filter(report => !done.has(report.key));
  const selected = options.limit ? pending.slice(0, options.limit) : pending;

  const byEndorsement = new Map<string, number>();
  const failures: RestoreOutcome[] = [];
  let succeeded = 0;
  let missingType = 0;
  let derivable = 0;

  for (const report of selected) {
    byEndorsement.set(report.endorsement, (byEndorsement.get(report.endorsement) ?? 0) + 1);
  }

  /** The body to send: the document, plus anything the directory knows that it does not. */
  const bodyFor = (report: BackupReport): unknown => {
    const document = readBackupReport(report.path);
    if (typeof document !== 'object' || document === null) return document;
    const record = document as Record<string, unknown>;
    const withArchived = report.archived ? { ...record, archived: true } : record;
    if (record.type !== undefined || record.isPlaceholderReport === true) return withArchived;

    missingType += 1;
    const derived = deriveReportType(report.endorsement, record.version);
    if (!derived) return withArchived;
    derivable += 1;
    return options.deriveMissingType ? { ...withArchived, type: derived } : withArchived;
  };

  if (!options.execute) {
    for (const report of selected) bodyFor(report);
    return {
      considered: all.length,
      alreadyDone: all.length - pending.length,
      sent: 0,
      succeeded: 0,
      failures: [],
      byEndorsement,
      missingType,
      derivable
    };
  }

  await withConcurrency(selected, options.concurrency, async report => {
    const outcome = await postReport(options.url, credential as string, bodyFor(report));
    if (outcome.status >= 200 && outcome.status < 300) {
      succeeded += 1;
      appendFileSync(options.ledgerPath, `${report.key}\n`);
    } else {
      failures.push({ key: report.key, ...outcome });
      log(`  ${outcome.status} ${report.key} - ${outcome.message}`);
    }
  });

  return {
    considered: all.length,
    alreadyDone: all.length - pending.length,
    sent: selected.length,
    succeeded,
    failures,
    byEndorsement,
    missingType,
    derivable
  };
};
