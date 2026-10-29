/**
 * Cloud certification runs: starting one, and reading where each stands.
 *
 * Three routes on reso-services-v2, the ones the desktop calls, so the CLI and the UI share them:
 *  - `POST /v2/certification/reservations/{endorsementName}/{endorsementVersion}/{providerUoi}` reserves a
 *    request ID as a local run starts, so the service records when it started. It takes the targets only, never
 *    a credential.
 *  - `POST /v2/certification/requests/{endorsementName}/{endorsementVersion}/{providerUoi}` starts the cloud
 *    run from that reservation, with the entries that passed and a record of each one's local run. The
 *    credentials in the entries go to the service, which seals them for the run. It never echoes them back.
 *  - `GET /v2/certification/requests/status` lists the caller's runs in the environment their token
 *    names, newest change first.
 *
 * What the service accepts (which endorsements, which versions, how many entries) is its decision, so
 * nothing here checks it again. A refusal comes back with the service's own reason.
 */

import { cliAuthRejectedMessage, cliAuthRequiredMessage, mintProviderToken, resolveServicesUrl, serviceError } from '../sdk/common.js';

/** The endorsement names the request route takes. */
export const CLOUD_ENDORSEMENT = {
  webApiCore: 'web-api-core',
  dataDictionary: 'data-dictionary'
} as const;

export const CLOUD_RUNS_SERVICE = 'Cloud runs';

const REQUESTS_ROUTE = '/v2/certification/requests';
const RESERVATIONS_ROUTE = '/v2/certification/reservations';
const STATUS_ROUTE = '/v2/certification/requests/status';

/** The most of a failure's body worth showing. Enough for any reason the service writes. */
const MAX_DETAIL_LENGTH = 300;

interface CloudAuthInput {
  /** Logged-in session bearer (desktop or UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
  /** True when invoked from the CLI, so an auth failure points at `.env`. */
  readonly fromCli?: boolean;
}

/** One recipient a reservation is for: what the cloud run will be addressed to. No credential. */
export interface CloudRunTarget {
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly serviceRootUri: string;
}

export interface ReserveCloudRunInput extends CloudAuthInput {
  readonly endorsementName: string;
  readonly endorsementVersion: string;
  readonly providerUoi: string;
  readonly targets: ReadonlyArray<CloudRunTarget>;
}

/** A request ID reserved for a local run, and until when a cloud run can start from it. */
export interface CloudRunReservation {
  readonly certificationRequestId: string;
  readonly expiresAt: string;
  readonly recipients: ReadonlyArray<CloudRunRecipient>;
}

export interface SubmitCloudRunInput extends CloudAuthInput {
  readonly endorsementName: string;
  readonly endorsementVersion: string;
  /** The configuration file's content, `{ providerUoi, configs: [...] }`. Sent as it is. */
  readonly config: unknown;
}

/** One recipient a run was recorded for. Identifiers only. */
export interface CloudRunRecipient {
  readonly recipientUoi: string;
  readonly providerUsi: string;
}

/** What the service recorded. Poll the status route with its id to follow the run. */
export interface AcceptedCloudRun {
  readonly certificationRequestId: string;
  readonly providerUoi: string;
  readonly endorsementName: string;
  readonly endorsementVersion: string;
  readonly recipients: ReadonlyArray<CloudRunRecipient>;
}

export interface CloudRunStatusInput extends CloudAuthInput {
  /** Changed since: an ISO timestamp or epoch milliseconds, passed to the service as given. */
  readonly since?: string;
  /** Only runs in these statuses. The service names the ones it knows when it refuses one. */
  readonly statuses?: ReadonlyArray<string>;
  /** Only runs still scheduled or running. */
  readonly inProgressOnly?: boolean;
  readonly limit?: number;
}

/** One row per recipient of a run, with the fields the service shows the caller. */
export type CloudRunStatusRow = Readonly<Record<string, unknown>>;

export interface CloudRunStatusPage {
  readonly results: ReadonlyArray<CloudRunStatusRow>;
  /** True when more runs matched than were returned. Narrow with `since`. */
  readonly hasMore: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The organization a configuration file certifies. The request's path names it, so a file without one
 * is refused. It is never filled in: a placeholder would start a run for an organization nobody named.
 */
export const configProviderUoi = (config: unknown): string => {
  if (isRecord(config) && nonEmpty(config.providerUoi)) return config.providerUoi;
  throw serviceError('SERVICE_ERROR', 'The configuration file has no "providerUoi". A cloud run is started for the organization it names.');
};

const resolveToken = async (input: CloudAuthInput): Promise<string> => {
  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli
        ? cliAuthRequiredMessage(CLOUD_RUNS_SERVICE)
        : `${CLOUD_RUNS_SERVICE} requires authentication. Pass a provider token (bearerToken), such as the session token from logging in.`
    );
  }
  return token;
};

const authRejected = (input: CloudAuthInput): Error =>
  serviceError(
    'AUTH_REJECTED',
    input.fromCli
      ? cliAuthRejectedMessage(CLOUD_RUNS_SERVICE)
      : `${CLOUD_RUNS_SERVICE}: your session token was rejected or has expired. Log in again to continue.`
  );

/** The `message` a handler wrote, when the body has one. */
const messageOf = (body: unknown): string | undefined =>
  isRecord(body) && nonEmpty(body.message) ? body.message.slice(0, MAX_DETAIL_LENGTH) : undefined;

/**
 * The gateway's own refusal of a token reads `{"message":"Forbidden"}`. The route's 403s say which
 * organization the caller may not act for, and that is worth showing as it is. Calling it a rejected
 * token would send the caller to check credentials that are fine.
 */
const GATEWAY_FORBIDDEN = 'Forbidden';

/** A failure the caller can act on, in the service's words where it gave any. */
const failure = async (response: Response, input: CloudAuthInput, what: string): Promise<Error> => {
  if (response.status === 401) return authRejected(input);
  const text = await response.text().catch(() => '');
  const body: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  const message = messageOf(body);
  if (response.status === 403) {
    return message === undefined || message === GATEWAY_FORBIDDEN
      ? authRejected(input)
      : serviceError('SERVICE_ERROR', `${what} was refused: ${message}`);
  }
  if (response.status === 400 || response.status === 503) {
    return serviceError('SERVICE_ERROR', `${what} was refused: ${message ?? `${response.status} ${response.statusText}`}`);
  }
  // A server fault's body can carry an exception's raw text, which is not the caller's to read.
  if (response.status >= 500) return serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}`);
  const detail = text.trim().slice(0, MAX_DETAIL_LENGTH);
  return serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
};

const isRecipient = (value: unknown): value is CloudRunRecipient =>
  isRecord(value) && nonEmpty(value.recipientUoi) && typeof value.providerUsi === 'string';

const acceptedRunOf = (body: unknown): AcceptedCloudRun | undefined => {
  if (!isRecord(body) || !nonEmpty(body.certificationRequestId) || !Array.isArray(body.recipients)) return undefined;
  if (!body.recipients.every(isRecipient)) return undefined;
  if (!nonEmpty(body.providerUoi) || !nonEmpty(body.endorsementName) || !nonEmpty(body.endorsementVersion)) return undefined;
  return {
    certificationRequestId: body.certificationRequestId,
    providerUoi: body.providerUoi,
    endorsementName: body.endorsementName,
    endorsementVersion: body.endorsementVersion,
    recipients: body.recipients.map(r => ({ recipientUoi: r.recipientUoi, providerUsi: r.providerUsi }))
  };
};

const reservationOf = (body: unknown): CloudRunReservation | undefined => {
  if (!isRecord(body) || !nonEmpty(body.certificationRequestId) || !nonEmpty(body.expiresAt) || !Array.isArray(body.recipients)) {
    return undefined;
  }
  if (!body.recipients.every(isRecipient)) return undefined;
  return {
    certificationRequestId: body.certificationRequestId,
    expiresAt: body.expiresAt,
    recipients: body.recipients.map(r => ({ recipientUoi: r.recipientUoi, providerUsi: r.providerUsi }))
  };
};

/**
 * Reserve a request ID as a local run starts. Only the targets are sent: the recipient, the system and the
 * server each entry will test. The cloud run is started from the ID once the run has passed, within the window
 * the service gives (`expiresAt`).
 */
export const reserveCloudRun = async (input: ReserveCloudRunInput): Promise<CloudRunReservation> => {
  const what = `Reserving the ${input.endorsementName} ${input.endorsementVersion} run`;
  const servicesUrl = resolveServicesUrl(CLOUD_RUNS_SERVICE);
  const token = await resolveToken(input);

  const path = [input.endorsementName, input.endorsementVersion, input.providerUoi].map(encodeURIComponent).join('/');
  const response = await fetch(`${servicesUrl}${RESERVATIONS_ROUTE}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      providerUoi: input.providerUoi,
      configs: input.targets.map(t => ({ recipientUoi: t.recipientUoi, providerUsi: t.providerUsi, serviceRootUri: t.serviceRootUri }))
    })
  });
  if (!response.ok) throw await failure(response, input, what);

  const reservation = reservationOf(await response.json().catch(() => undefined));
  if (reservation === undefined) {
    throw serviceError('SERVICE_ERROR', `${what}: the service answered ${response.status} without a request ID and its window.`);
  }
  return reservation;
};

/**
 * Start a run in RESO's cloud from a reservation. Returns once the service has recorded it, not when it
 * finishes: follow it with {@link listCloudRunStatus}.
 */
export const submitCloudRun = async (input: SubmitCloudRunInput): Promise<AcceptedCloudRun> => {
  const what = `Starting the ${input.endorsementName} ${input.endorsementVersion} run`;
  const providerUoi = configProviderUoi(input.config);
  const servicesUrl = resolveServicesUrl(CLOUD_RUNS_SERVICE);
  const token = await resolveToken(input);

  const path = [input.endorsementName, input.endorsementVersion, providerUoi].map(encodeURIComponent).join('/');
  const response = await fetch(`${servicesUrl}${REQUESTS_ROUTE}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input.config)
  });
  if (!response.ok) throw await failure(response, input, what);

  const accepted = acceptedRunOf(await response.json().catch(() => undefined));
  if (accepted === undefined) {
    throw serviceError('SERVICE_ERROR', `${what}: the service answered ${response.status} without a request id and its recipients.`);
  }
  return accepted;
};

const statusUrl = (servicesUrl: string, input: CloudRunStatusInput): string => {
  const params = new URLSearchParams();
  if (input.since !== undefined) params.set('since', input.since);
  if (input.statuses !== undefined && input.statuses.length > 0) params.set('statuses', input.statuses.join(','));
  if (input.inProgressOnly === true) params.set('inProgressOnly', 'true');
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  const query = params.toString();
  return `${servicesUrl}${STATUS_ROUTE}${query ? `?${query}` : ''}`;
};

/** The caller's runs, as the service served them: no field renamed, added or dropped. */
export const listCloudRunStatus = async (input: CloudRunStatusInput = {}): Promise<CloudRunStatusPage> => {
  const what = 'Reading cloud run status';
  const servicesUrl = resolveServicesUrl(CLOUD_RUNS_SERVICE);
  const token = await resolveToken(input);

  const response = await fetch(statusUrl(servicesUrl, input), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await failure(response, input, what);

  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !Array.isArray(body.results) || !body.results.every(isRecord)) {
    throw serviceError('SERVICE_ERROR', `${what}: the service answered ${response.status} without a list of runs.`);
  }
  return { results: body.results, hasMore: body.hasMore === true };
};
