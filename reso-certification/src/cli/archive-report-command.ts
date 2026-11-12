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

import { registerCertApiSecrets, resolveCertApiAuthorization, resolveCertApiOrigin } from './cert-api-credential.js';

export { certApiOriginFromTokenUri, resolveCertApiOrigin } from './cert-api-credential.js';

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
  /** True only when the server confirmed the archive with `201 success`. */
  readonly archived: boolean;
  /** The status of the archive answer, or of the read that stopped the command, or 0 when the request itself failed. */
  readonly status?: number;
  /**
   * After an archive answer other than `201 success`, the report read again: `gone` when it is no
   * longer listed, `listed` when it still is, `unreadable` when the second read failed. Absent when
   * no archive was attempted or the server confirmed it.
   */
  readonly reread?: Reread;
  /** The server's words after an archive request; before one, the line the command printed. */
  readonly message: string;
}

/**
 * What a second read of the report found. The server deletes the report before it sends the
 * notification and only then answers 201, and the notification can fail, so an answer that is not
 * 201 does not say whether the report is still there. Only reading it again does.
 */
export type Reread = 'gone' | 'listed' | 'unreadable';
const REREAD_GONE: Reread = 'gone';
const REREAD_LISTED: Reread = 'listed';
const REREAD_UNREADABLE: Reread = 'unreadable';

/** The report type the site names by the dictionary rather than by its description. */
const DATA_DICTIONARY_TYPE = 'data_dictionary';
const DATA_DICTIONARY_LABEL = 'Data Dictionary';

/** The site's words, from its archive modal. */
const WARNING_TITLE = 'Archive Endorsement?';
const WARNING_TAIL = 'will no longer be available in the RESO Certification System.';
const WARNING_NOTIFICATION = "You will receive a notification it's been archived.";

/** The only body that means the archive happened, with the status the controller sends it with. Compared with surrounding whitespace removed, which carries nothing. */
const ARCHIVED_STATUS = 201;
const ARCHIVED_BODY = 'success';

/** As many characters of a server message as are repeated, as `restore` does. */
const MESSAGE_LIMIT = 300;

/**
 * A report id as the certification store assigns one: URL-safe characters only. Anything else is refused
 * before a request, because an id that needs escaping to fit in a path is not one the store issued.
 */
const REPORT_ID = /^[A-Za-z0-9_-]+$/;

export const NOTHING_ARCHIVED = 'Nothing was archived. Rerun with --confirm to proceed.';

/** Said after a second read finds the report gone without the server having confirmed the archive. */
const REMOVED_UNCONFIRMED =
  'Whether its archive record or only the notification failed is not known from here. Check the certification site for it rather than rerunning this command.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

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

/**
 * A failed request in words: the error's message, then the cause's when there is one. Node's fetch
 * says only `fetch failed` and puts the reason, a refused connection or an unknown host, on `cause`.
 */
const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined ? error.message : `${error.message} (${cause})`;
};

/**
 * One request. A redirect is never followed: the archive POST would otherwise be replayed to a
 * host the operator did not name, and that host's answer counted. A 3xx comes back as itself and
 * is reported with its status like any other answer that is not the one expected.
 */
const request = async (url: string, init: RequestInit): Promise<Answer> => {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual' });
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
    return { status: 0, text: '', json: undefined, error: errorText(error) };
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

/** `absent` marks the one failure that is the server's own answer: a list that does not hold the id. */
type ReportRead = { readonly report: ReportSummary } | { readonly failure: string; readonly status: number; readonly absent?: true };

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
  if (answer.json === undefined) {
    return {
      failure: `The report could not be read: the server answered ${answer.status} with a body that is not JSON. Is the address the Cert API rather than the certification site?`,
      status: answer.status
    };
  }
  if (!Array.isArray(answer.json)) {
    return {
      failure: `The report could not be read: the server answered ${answer.status} with a body that is not a list of reports.`,
      status: answer.status
    };
  }
  const found = answer.json.find((row): row is Record<string, unknown> => isRecord(row) && row.id === reportId);
  return found === undefined
    ? { failure: `No report with id ${reportId} was found.`, status: answer.status, absent: true }
    : { report: summaryOf(found) };
};

/**
 * The report read again, after an archive answer that was not `201 success`, and what that read
 * says in one line. A report the server lists is not archived. One it no longer lists was removed,
 * as an archive does, but the server did not say what failed after the removal, its archive record
 * or only the notification, so that is said rather than guessed. A failed read says nothing.
 */
const rereadAfter = async (
  origin: string,
  authorization: string,
  reportId: string
): Promise<{ readonly reread: Reread; readonly line: string }> => {
  const read = await readReport(origin, authorization, reportId);
  if ('report' in read) {
    return { reread: REREAD_LISTED, line: `Read again, report ${reportId} is still listed, so it was not archived.` };
  }
  if (read.absent === true) {
    const removed = `Read again, report ${reportId} is no longer listed: the server removed it, as an archive does, but did not confirm the archive.`;
    return { reread: REREAD_GONE, line: `${removed} ${REMOVED_UNCONFIRMED}` };
  }
  return {
    reread: REREAD_UNREADABLE,
    line: `Read again, the report could not be read (${read.failure}), so whether it was archived is not known. Check the certification site.`
  };
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
 * Refuses, by throwing, before any request when the credential, the id or the origin is missing or
 * malformed: those are usage, and the caller exits 2. Everything the server says comes back in the
 * result instead, for the caller to print and to turn into an exit code with `archiveExitCode`.
 *
 * The credential is resolved and registered with the masker before anything else is examined, and
 * the id refusal names the rule rather than the value: an argument given in the id's place can be
 * the credential itself (a shell slip, a pasted line from the credentials file), and a refusal that
 * quoted it would print it.
 */
export const runArchiveReport = async (options: ArchiveReportOptions, log: (line: string) => void): Promise<ArchiveReportResult> => {
  const env = options.env ?? process.env;
  registerCertApiSecrets(env);
  const reportId = options.reportId.trim();
  if (!REPORT_ID.test(reportId)) {
    throw new Error(
      `A report id is letters, digits, '-' and '_' only, and the ${options.reportId.length}-character argument given is not one.`
    );
  }
  const origin = resolveCertApiOrigin({ ...(options.url === undefined ? {} : { url: options.url }), env });
  const authorization = await resolveCertApiAuthorization({ env, origin });
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
  const archived = answer.status === ARCHIVED_STATUS && answer.text.trim() === ARCHIVED_BODY;
  log('');
  if (archived) {
    log(`Archived report ${reportId} (${answer.status} ${answer.text.trim()}).`);
    return { reportId, origin, warning, report, confirmed, archived, status: answer.status, message: messageOf(answer) };
  }
  log(describe(`The server did not confirm the archive of report ${reportId}`, answer));
  const after = await rereadAfter(origin, authorization, reportId);
  log(after.line);
  return {
    reportId,
    origin,
    warning,
    report,
    confirmed,
    archived,
    status: answer.status,
    reread: after.reread,
    message: messageOf(answer)
  };
};
