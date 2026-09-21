/**
 * Variations review — the read side of the review pool.
 *
 * Two GETs against reso-services-v2, the same routes the web client's review
 * page uses, so the CLI and the UI read one source:
 *  - `GET /v2/certification/variations-review-items` — the items in review,
 *    provider-scoped for a provider token, org-wide for an admin token; paged
 *    by `nextCursor`, followed here until the service stops returning one.
 *  - `GET /v2/certification/endorsements/me` — the caller's submissions with
 *    their lifecycle and review status, served as `{ endorsements }`; and
 *    `GET /v2/certification/endorsements?reviewStatus=` — the admin queue.
 *
 * Both return what the service served, unchanged: no field is renamed, added
 * or dropped, so a caller reading the JSON reads the pool as it is. Auth and
 * configuration errors carry the shared `code` (see `../sdk/common`).
 */

import { mintProviderToken, serviceError } from '../sdk/common.js';

/** One submission of a variation key, as the items route reports it. */
export interface VariationReviewProvenance {
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly submittedAt: string;
  readonly environmentName: string;
  readonly submittedByProviderUoi?: string;
  readonly submittedByDisplayName?: string;
  readonly endorsementId?: string;
  readonly requestedAction?: string | null;
  readonly lastEditorUoi?: string;
  readonly lastEditorDisplayName?: string;
  readonly lastEditorEmail?: string;
  readonly lastEditorRole?: string;
  readonly lastUpdatedAt?: string;
}

/** One item in review — a variation key collapsed across every tuple that flagged it. */
export interface VariationReviewItem {
  readonly variationKey: string;
  readonly resourceName: string;
  readonly fieldName?: string | null;
  readonly lookupValue?: string | null;
  readonly status: string;
  readonly outcome?: string | null;
  readonly mapping?: Readonly<Record<string, unknown>> | null;
  readonly strategy?: string | null;
  readonly suggestions?: ReadonlyArray<Readonly<Record<string, unknown>>> | null;
  readonly provenance: ReadonlyArray<VariationReviewProvenance>;
  readonly lastUpdatedAt?: string;
  readonly lastEditorUoi?: string;
  readonly lastEditorDisplayName?: string;
  readonly lastEditorEmail?: string;
  readonly lastEditorRole?: string;
  readonly myDraft?: Readonly<Record<string, unknown>>;
  readonly otherDrafts?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/** One row of the caller's endorsements, as `endorsements/me` reports it. */
export interface EndorsementStatusRow {
  readonly providerUoi: string;
  readonly endorsementId: string;
  readonly recipientUoi?: string;
  readonly providerUsi?: string;
  readonly endorsement?: string;
  readonly version?: string;
  readonly lifecycleStatus?: string;
  readonly reviewStatus?: string;
  readonly environmentName?: string;
  readonly submittedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type VariationReviewElementType = 'resource' | 'field' | 'lookup';

interface ServiceAuthInput {
  /** Logged-in session bearer (Desktop / UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
  /** True when invoked from the CLI — points the not-configured error at `.env`. */
  readonly fromCli?: boolean;
}

export interface ListVariationReviewItemsInput extends ServiceAuthInput {
  /** Pool status to list; omitted lists every status the route serves. */
  readonly status?: string;
  readonly elementType?: VariationReviewElementType;
  /** Page size hint for the route; every page is followed regardless. */
  readonly limit?: number;
}

export type ListMyEndorsementsInput = ServiceAuthInput;

export type EndorsementReviewStatus = 'none' | 'in-review' | 'resolved';

export interface ListEndorsementsByReviewStatusInput extends ServiceAuthInput {
  /** Review status to list; the route defaults to `in-review`. */
  readonly reviewStatus?: EndorsementReviewStatus;
}

const ITEMS_ROUTE = '/v2/certification/variations-review-items';
const MY_ENDORSEMENTS_ROUTE = '/v2/certification/endorsements/me';
const ENDORSEMENTS_ROUTE = '/v2/certification/endorsements';

/** The bounded page walk: the service pages by cursor, and a cursor loop that never ends is a service defect, not a bigger pool. */
const MAX_PAGES = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const resolveServicesUrl = (): string => {
  const servicesUrl = process.env.RESO_SERVICES_URL;
  if (!servicesUrl) {
    throw serviceError('SERVICE_ERROR', 'Variations Service: RESO_SERVICES_URL is not set.');
  }
  return servicesUrl;
};

const resolveToken = async (input: ServiceAuthInput, what: string): Promise<string> => {
  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli
        ? `${what} requires authentication. Set TOKEN_URI, CLIENT_ID and CLIENT_SECRET (or CERT_AUTH_API_BASE_URL, CERT_AUTH_API_USERNAME and CERTIFICATION_API_KEY) in your .env so the CLI can mint a provider token.`
        : `${what} requires authentication. Pass a provider token (bearerToken) — e.g. the session token from logging in.`,
    );
  }
  return token;
};

/** One authenticated GET; the caller decides what a good body looks like. */
const getJson = async (url: URL, token: string, input: ServiceAuthInput, what: string): Promise<unknown> => {
  const response = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) {
    throw serviceError(
      'AUTH_REJECTED',
      input.fromCli
        ? `${what}: the provider token was rejected. Re-check your CERT_AUTH_API_* .env credentials.`
        : `${what}: your session token was rejected or has expired. Log in again to continue.`,
    );
  }
  if (!response.ok) {
    throw serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

/**
 * List the items in review. Provider-scoped for a provider token, org-wide for
 * an admin token — the scope is the service's decision, not a parameter here.
 * Follows `nextCursor` to the end; a page that fails throws, so the result is
 * never a partial list presented as the whole pool.
 */
export const listVariationReviewItemsViaService = async (
  input: ListVariationReviewItemsInput = {},
): Promise<ReadonlyArray<VariationReviewItem>> => {
  const what = 'Listing variations in review';
  const servicesUrl = resolveServicesUrl();
  const token = await resolveToken(input, what);

  const pageAt = async (cursor: string | undefined): Promise<{ items: ReadonlyArray<VariationReviewItem>; nextCursor?: string }> => {
    const url = new URL(`${servicesUrl}${ITEMS_ROUTE}`);
    if (input.status) url.searchParams.set('status', input.status);
    if (input.elementType) url.searchParams.set('elementType', input.elementType);
    if (input.limit !== undefined) url.searchParams.set('limit', String(input.limit));
    if (cursor) url.searchParams.set('cursor', cursor);

    const body = await getJson(url, token, input, what);
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw serviceError('SERVICE_ERROR', `${what} failed: the service returned no items array.`);
    }
    const nextCursor = typeof body.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : undefined;
    return { items: body.items as ReadonlyArray<VariationReviewItem>, ...(nextCursor ? { nextCursor } : {}) };
  };

  const walk = async (
    cursor: string | undefined,
    acc: ReadonlyArray<VariationReviewItem>,
    pages: number,
  ): Promise<ReadonlyArray<VariationReviewItem>> => {
    if (pages >= MAX_PAGES) {
      throw serviceError('SERVICE_ERROR', `${what} failed: the service kept returning a next page after ${MAX_PAGES} pages.`);
    }
    const page = await pageAt(cursor);
    const items = [...acc, ...page.items];
    return page.nextCursor ? walk(page.nextCursor, items, pages + 1) : items;
  };

  return walk(undefined, [], 0);
};

/**
 * The caller's endorsements with their `lifecycleStatus` / `reviewStatus` —
 * one row per submission. The route serves `{ endorsements: [...] }`.
 */
export const listMyEndorsementsViaService = async (
  input: ListMyEndorsementsInput = {},
): Promise<ReadonlyArray<EndorsementStatusRow>> => {
  const what = 'Fetching review status';
  const servicesUrl = resolveServicesUrl();
  const token = await resolveToken(input, what);

  return endorsementsAt(new URL(`${servicesUrl}${MY_ENDORSEMENTS_ROUTE}`), token, input, what);
};

/**
 * Endorsements by review status — the admin queue. An admin token sees every
 * provider's rows; a provider token gets the route's own scoping to its rows.
 */
export const listEndorsementsByReviewStatusViaService = async (
  input: ListEndorsementsByReviewStatusInput = {},
): Promise<ReadonlyArray<EndorsementStatusRow>> => {
  const what = 'Fetching review status';
  const servicesUrl = resolveServicesUrl();
  const token = await resolveToken(input, what);

  const url = new URL(`${servicesUrl}${ENDORSEMENTS_ROUTE}`);
  if (input.reviewStatus) url.searchParams.set('reviewStatus', input.reviewStatus);
  return endorsementsAt(url, token, input, what);
};

const endorsementsAt = async (url: URL, token: string, input: ServiceAuthInput, what: string): Promise<ReadonlyArray<EndorsementStatusRow>> => {
  const body = await getJson(url, token, input, what);
  if (!isRecord(body) || !Array.isArray(body.endorsements)) {
    throw serviceError('SERVICE_ERROR', `${what} failed: the service returned no endorsements array.`);
  }
  return body.endorsements as ReadonlyArray<EndorsementStatusRow>;
};
