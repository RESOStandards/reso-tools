/**
 * `reso-cert archive-report`: archive a certification report, as the certification site does.
 *
 * The site's archive is one POST behind a warning. This command makes the same POST, with the same
 * credential the downloaded credentials file carries, and shows the same warning first, filled in
 * from the report. Nothing is archived without `--confirm`: the warning is printed and the command
 * stops, so a person has read what will go before it goes.
 *
 * Three requests at most, in this order: the report by id, the provider's organization name (only
 * when the provider and recipient differ, as on the site), then the archive. A read that fails or
 * finds nothing stops the command before the archive. A value that cannot be read is never guessed.
 */

import { ensureHttps } from '../sdk/common.js';
import { MISSING_CERT_API_CREDENTIAL, resolveCertApiCredential } from './cert-api-credential.js';
import { registerSecret } from './secrets.js';

/** The report fields the warning and the summary use. Every one optional: the server, not the CLI, fills them. */
export interface ReportSummary {
  readonly id?: string;
  readonly type?: string;
  readonly description?: string;
  readonly version?: string;
  readonly providerUoi?: string;
  readonly recipientUoi?: string;
  /** The provider organization's name, when it was read. */
  readonly providerName?: string;
  /** Why the name was not read, when it was not. The UOI stands in for it in the warning. */
  readonly providerNameUnavailable?: string;
}

export interface ArchiveReportOptions {
  readonly reportId: string;
  /** `--confirm`: make the archive request. Without it the warning is shown and nothing is archived. */
  readonly confirm: boolean;
  /** `--url`: the Cert API origin. Without it the origin is taken from `TOKEN_URI`. */
  readonly url?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** What happened, for a person and for `--json`. The credential is never part of it. */
export interface ArchiveReportResult {
  readonly reportId: string;
  readonly origin: string;
  /** The site's warning with the report's values filled in. Absent when the report could not be read. */
  readonly warning?: string;
  readonly report?: ReportSummary;
  readonly confirmed: boolean;
  readonly archived: boolean;
  /** The status of the last answer received, or 0 when the request itself failed. */
  readonly status?: number;
  readonly message: string;
}

/** The report type the site names by the dictionary rather than by its description. */
const DATA_DICTIONARY_TYPE = 'data_dictionary';
const DATA_DICTIONARY_LABEL = 'Data Dictionary';

/** The site's words, from its archive modal. */
const WARNING_TITLE = 'Archive Endorsement?';
const WARNING_TAIL = 'will no longer be available in the RESO Certification System.';
const WARNING_NOTIFICATION = "You will receive a notification it's been archived.";

/** The only body that means the archive happened, with the status the controller sends it with. */
const ARCHIVED_STATUS = 201;
const ARCHIVED_BODY = 'success';

/** The token endpoint paths the downloaded credentials file can name. `/oauth2` is the legacy prefix. */
const TOKEN_PATHS: ReadonlySet<string> = new Set(['/api/v1/oauth/token', '/api/v1/oauth2/token']);

/** As many characters of a server message as are repeated, as `restore` does. */
const MESSAGE_LIMIT = 300;

/**
 * A report id as the certification store assigns one: URL-safe characters only. Anything else is refused
 * before a request, because an id that needs escaping to fit in a path is not one the store issued.
 */
const REPORT_ID = /^[A-Za-z0-9_-]+$/;

export const NOTHING_ARCHIVED = 'Nothing was archived. Rerun with --confirm to proceed.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The Cert API origin a `TOKEN_URI` names, or undefined.
 *
 * Only when the path is exactly the token endpoint. The file's own comment records that older files
 * were built from the site host, where `/api/v1` answers the single-page app with a 200, so a value
 * with any other path says nothing reliable about where the API is.
 */
export const certApiOriginFromTokenUri = (tokenUri: string): string | undefined => {
  try {
    const parsed = new URL(tokenUri.trim());
    return TOKEN_PATHS.has(parsed.pathname) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The Cert API origin: `--url` when given, else from `TOKEN_URI`, either way as https.
 *
 * A `--url` with a path is refused rather than trimmed: a `TOKEN_URI` pasted here would otherwise
 * silently become a different address.
 */
export const resolveCertApiOrigin = (input: { readonly url?: string; readonly env: NodeJS.ProcessEnv }): string => {
  if (input.url !== undefined) {
    const secured = ensureHttps(input.url, '--url');
    const parsed = new URL(secured);
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`--url must be the Cert API origin without a path, such as ${parsed.origin}.`);
    }
    return parsed.origin;
  }
  const tokenUri = input.env.TOKEN_URI;
  const origin = tokenUri === undefined ? undefined : certApiOriginFromTokenUri(ensureHttps(tokenUri, 'TOKEN_URI'));
  if (origin === undefined) {
    throw new Error(
      tokenUri === undefined
        ? 'No Cert API address. Pass --url, or run where the downloaded credentials file (TOKEN_URI) can be read.'
        : 'TOKEN_URI does not name the Cert API token endpoint (/api/v1/oauth/token), so the API address cannot be taken from it. Pass --url.'
    );
  }
  return origin;
};

/** The site's warning, with the report's values filled in. The provider is named only when it differs from the recipient. */
export const archiveWarning = (report: ReportSummary, providerName: string | undefined): string => {
  const label = report.type === DATA_DICTIONARY_TYPE ? DATA_DICTIONARY_LABEL : (report.description ?? report.type ?? 'unknown type');
  const version = report.version ?? 'unknown version';
  const sameOrganization = report.providerUoi === report.recipientUoi;
  const provider = sameOrganization ? undefined : (providerName ?? report.providerUoi);
  const subject = [`the ${label} ${version} Endorsement`, ...(provider === undefined ? [] : [`for ${provider}`])].join(' ');
  return `${WARNING_TITLE}\n\nBy proceeding, ${subject} ${WARNING_TAIL}\n${WARNING_NOTIFICATION}`;
};

/** `0` when the archive happened or the warning was shown without `--confirm`, `1` otherwise. */
export const archiveExitCode = (result: ArchiveReportResult): 0 | 1 =>
  result.archived || (!result.confirmed && result.report !== undefined) ? 0 : 1;

/** One answer from the server, read once: its status, its text and the JSON the text holds, if any. */
interface Answer {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  /** Set when the request itself failed, before any answer. */
  readonly error?: string;
}

const request = async (url: string, init: RequestInit): Promise<Answer> => {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const json = ((): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    return { status: response.status, text, json };
  } catch (error) {
    return { status: 0, text: '', json: undefined, error: error instanceof Error ? error.message : String(error) };
  }
};

/** The server's message: the JSON `message` field when there is one, else the text, cut as `restore` cuts it. */
const messageOf = (answer: Answer): string => {
  if (answer.error !== undefined) return answer.error;
  const fromJson = isRecord(answer.json) ? stringOf(answer.json.message) : undefined;
  return (fromJson ?? answer.text).slice(0, MESSAGE_LIMIT);
};

/** A failed request or a refused one, in one line with the status when there was one. */
const describe = (what: string, answer: Answer): string =>
  answer.error !== undefined ? `${what}: ${answer.error}` : `${what}: ${answer.status} ${messageOf(answer)}`;

const summaryOf = (record: Record<string, unknown>): ReportSummary => ({
  id: stringOf(record.id),
  type: stringOf(record.type),
  description: stringOf(record.description),
  version: stringOf(record.version),
  providerUoi: stringOf(record.providerUoi),
  recipientUoi: stringOf(record.recipientUoi)
});

type ReportRead = { readonly report: ReportSummary } | { readonly failure: string; readonly status: number };

/** The report, as the site reads one: `filter/list` with the one id. */
const readReport = async (origin: string, authorization: string, reportId: string): Promise<ReportRead> => {
  const answer = await request(`${origin}/api/v1/certification_reports/filter/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({ ids: [reportId] })
  });
  if (answer.error !== undefined || answer.status !== 200) {
    return { failure: describe('The report could not be read', answer), status: answer.status };
  }
  if (!Array.isArray(answer.json)) {
    return {
      failure: `The report could not be read: the server answered ${answer.status} with a body that is not JSON. Is the address the Cert API rather than the certification site?`,
      status: answer.status
    };
  }
  const found = answer.json.find((row): row is Record<string, unknown> => isRecord(row) && row.id === reportId);
  return found === undefined
    ? { failure: `No report with id ${reportId} was found.`, status: answer.status }
    : { report: summaryOf(found) };
};

type NameRead = { readonly name: string } | { readonly unavailable: string };

/** The organization's name, or why it could not be read. Never a guess. */
const readOrganizationName = async (origin: string, authorization: string, uoi: string): Promise<NameRead> => {
  const answer = await request(`${origin}/api/v1/organization?uoi=${encodeURIComponent(uoi)}`, {
    method: 'GET',
    headers: { Authorization: authorization }
  });
  if (answer.error !== undefined || answer.status !== 200) return { unavailable: describe('the organization could not be read', answer) };
  const name = isRecord(answer.json) ? stringOf(answer.json.name) : undefined;
  return name === undefined ? { unavailable: `the organization answer carries no name (status ${answer.status})` } : { name };
};

/** The one archive request: the site's route, no query string, no body. */
const archive = async (origin: string, authorization: string, reportId: string): Promise<Answer> =>
  request(`${origin}/api/v1/certification_reports/archive/${encodeURIComponent(reportId)}`, {
    method: 'POST',
    headers: { Authorization: authorization }
  });

/**
 * Archive one report, or show what archiving it would do.
 *
 * Refuses, by throwing, before any request when the id, the credential or the origin is missing or
 * malformed: those are usage, and the caller exits 2. Everything the server says comes back in the
 * result instead, for the caller to print and to turn into an exit code with `archiveExitCode`.
 */
export const runArchiveReport = async (options: ArchiveReportOptions, log: (line: string) => void): Promise<ArchiveReportResult> => {
  const env = options.env ?? process.env;
  const reportId = options.reportId.trim();
  if (!REPORT_ID.test(reportId)) {
    throw new Error(`A report id is letters, digits, '-' and '_' only, got ${JSON.stringify(options.reportId)}.`);
  }
  const credential = resolveCertApiCredential(env);
  if (credential === undefined) throw new Error(MISSING_CERT_API_CREDENTIAL);
  registerSecret(credential);
  const origin = resolveCertApiOrigin({ ...(options.url === undefined ? {} : { url: options.url }), env });
  const authorization = `Bearer ${credential}`;
  const confirmed = options.confirm;

  const read = await readReport(origin, authorization, reportId);
  if ('failure' in read) {
    log(read.failure);
    log('Nothing was archived.');
    return { reportId, origin, confirmed, archived: false, status: read.status, message: read.failure };
  }

  const { providerUoi, recipientUoi } = read.report;
  const nameRead =
    providerUoi !== undefined && providerUoi !== recipientUoi ? await readOrganizationName(origin, authorization, providerUoi) : undefined;
  const report: ReportSummary = {
    ...read.report,
    ...(nameRead !== undefined && 'name' in nameRead ? { providerName: nameRead.name } : {}),
    ...(nameRead !== undefined && 'unavailable' in nameRead ? { providerNameUnavailable: nameRead.unavailable } : {})
  };

  const warning = archiveWarning(report, report.providerName);
  log(warning);
  if (report.providerNameUnavailable !== undefined) {
    log(
      `The provider organization's name could not be read (${report.providerNameUnavailable}), so its UOI ${providerUoi} is shown instead.`
    );
  }

  if (!confirmed) {
    log('');
    log(NOTHING_ARCHIVED);
    return { reportId, origin, warning, report, confirmed, archived: false, message: NOTHING_ARCHIVED };
  }

  const answer = await archive(origin, authorization, reportId);
  const archived = answer.status === ARCHIVED_STATUS && answer.text === ARCHIVED_BODY;
  log('');
  log(
    archived
      ? `Archived report ${reportId} (${answer.status} ${answer.text}).`
      : describe(`The server did not archive report ${reportId}`, answer)
  );
  return { reportId, origin, warning, report, confirmed, archived, status: answer.status, message: messageOf(answer) };
};
