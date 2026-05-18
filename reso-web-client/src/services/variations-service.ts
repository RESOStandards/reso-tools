/**
 * Variations Service — API client for services.reso.org variations,
 * locks, and variations report endpoints.
 *
 * Auth: handled by `authedFetch` from `auth-service.ts`. Functions in this
 * module never see or accept tokens — they call `authedFetch` and the
 * service handles attach-header / lazy-refresh / 401-retry. This is the
 * "components shouldn't handle auth logic" pattern — extended to API
 * clients too. All requests go through the web API proxy to avoid CORS.
 */

import { authedFetch } from './auth-service';

const SERVICES_ORIGIN = 'https://services.reso.org';

/** Build a proxied URL for a services.reso.org path. */
const proxiedUrl = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${SERVICES_ORIGIN}${path}`)}`;

/**
 * Standard headers for JSON-bearing requests. Authorization is injected
 * by `authedFetch` itself — callers never construct it here.
 */
const jsonHeaders: Readonly<Record<string, string>> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

// ── Variations Search ────────────────────────────────────────────────

/** Suggestions map from the variations service — keyed by resource/field/lookup. */
export interface VariationsSuggestionsMap {
  readonly [resourceName: string]: {
    readonly suggestions?: ReadonlyArray<VariationSuggestion>;
    readonly ignored?: boolean;
    readonly isFastTrack?: boolean;
    readonly isAdminReview?: boolean;
    readonly [fieldName: string]: unknown;
  };
}

export interface VariationSuggestion {
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly strategy?: string;
  readonly ddWikiUrl?: string;
  readonly isFastTrack?: boolean;
  readonly isAdminReview?: boolean;
}

/** Search the variations service for suggestions matching a metadata report. */
export const searchVariations = async (
  metadataReport: { readonly fields: ReadonlyArray<unknown>; readonly lookups: ReadonlyArray<unknown> }
): Promise<VariationsSuggestionsMap> => {
  const res = await authedFetch(proxiedUrl('/v2/certification/variations/search'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(metadataReport),
  });
  if (!res.ok) return {};
  return (await res.json()) as VariationsSuggestionsMap;
};

/** Fetch variations index stats (counts, resources, fields). */
export const getVariationsStats = async (): Promise<Record<string, unknown> | null> => {
  const res = await authedFetch(proxiedUrl('/v2/certification/variations/stats'), {
    headers: jsonHeaders,
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
};

// ── Variations Reports (S3) ──────────────────────────────────────────

/** Editor info attached to a variations report save. */
export interface VariationsEditorInfo {
  readonly displayName: string;
  readonly editedOn: string;
  readonly email: string;
  readonly providerUoi: string;
  readonly username: string;
  readonly changeId?: string;
}

/** A single change in a variations report. */
export interface VariationsChange {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly flaggedForFastTrack?: boolean;
  readonly ignore?: boolean;
  readonly conversations?: ReadonlyArray<VariationsComment>;
  readonly changeId?: string;
}

/** A comment in a variations conversation thread. */
export interface VariationsComment {
  readonly timestamp: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly resourceKey?: string;
  readonly fieldKey?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly attachments?: ReadonlyArray<{ readonly displayText: string; readonly url: string }>;
}

/** Full variations report payload for save/load. */
export interface VariationsReportPayload {
  readonly description?: string;
  readonly version: string;
  readonly certificationRequestId: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  /**
   * Admin-only one-shot transition. When true and the caller is an
   * admin, the backend flips the endorsement's reviewStatus to
   * 'resolved' and fires a VARIATIONS_RESOLVED notification.
   * Ignored for non-admins.
   */
  readonly finalize?: boolean;
  readonly changes: ReadonlyArray<VariationsChange>;
  readonly editorInfo: ReadonlyArray<VariationsEditorInfo>;
  readonly lastUpdatedOn?: string;
}

/** Build the S3 path for a variations report. */
const variationsReportPath = (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string,
  certRequestId: string
): string =>
  `/v2/certification/variations-reports/${encodeURIComponent(version)}/${encodeURIComponent(providerUoi)}/${encodeURIComponent(providerUsi)}/${encodeURIComponent(recipientUoi)}/${encodeURIComponent(certRequestId)}`;

// ── Endorsements list endpoints (Layer 2A) ──

/**
 * One row in the endorsements DDB table; mirrors `EndorsementRecord`
 * from the v2 layer. Used by the provider list (`/me`) and the admin
 * queue (`?reviewStatus=...`) endpoints.
 */
export interface EndorsementRow {
  readonly providerUoi: string;
  readonly endorsementId: string;
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly endorsement: string;
  readonly version: string;
  readonly lifecycleStatus: string;
  readonly reviewStatus: string;
  readonly manifestS3Path?: string;
  readonly failedStep?: string;
  readonly jobId?: string;
  readonly reportId?: string;
  readonly environmentName: string;
  readonly submittedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** List endorsements for the currently-authenticated provider. */
export const getMyEndorsements = async (): Promise<ReadonlyArray<EndorsementRow>> => {
  const res = await authedFetch(
    proxiedUrl('/v2/certification/endorsements/me'),
    { headers: jsonHeaders }
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { endorsements?: ReadonlyArray<EndorsementRow> };
  return body.endorsements ?? [];
};

/**
 * Admin queue: list endorsements by review status. Provider auth
 * receives only their own slice (server-side post-filter).
 */
export const listEndorsementsByReviewStatus = async (
  reviewStatus: 'none' | 'in-review' | 'resolved' = 'in-review'
): Promise<ReadonlyArray<EndorsementRow>> => {
  const res = await authedFetch(
    proxiedUrl(`/v2/certification/endorsements?reviewStatus=${encodeURIComponent(reviewStatus)}`),
    { headers: jsonHeaders }
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { endorsements?: ReadonlyArray<EndorsementRow> };
  return body.endorsements ?? [];
};

/** Fetch an existing variations report from S3. */
export const getVariationsReport = async (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string,
  certRequestId: string
): Promise<VariationsReportPayload | null> => {
  const res = await authedFetch(
    proxiedUrl(variationsReportPath(version, providerUoi, providerUsi, recipientUoi, certRequestId)),
    { headers: jsonHeaders }
  );
  if (!res.ok) return null;
  return (await res.json()) as VariationsReportPayload;
};

/** Save a variations report to S3. */
export const saveVariationsReport = async (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string,
  certRequestId: string,
  payload: VariationsReportPayload
): Promise<boolean> => {
  const res = await authedFetch(
    proxiedUrl(variationsReportPath(version, providerUoi, providerUsi, recipientUoi, certRequestId)),
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }
  );
  // 304 = idempotent re-submit (server already has this exact payload);
  // treat as success so the UI clears its dirty state.
  return res.ok || res.status === 304;
};

// ── Items-screen feed (variationsReview pool) ────────────────────────
//
// `GET /v2/certification/variations-review-items` is the items-screen
// dashboard feed. Server scans the variationsReview pool, scope-filters
// by viewer role (admin = full pool; provider = own partition only),
// groups by variationKey, attaches one provenance entry per underlying
// pool row, joins drafts (myDraft + otherDrafts for cross-editor
// visibility), and emits cursor-based pages. Driven by the design in
// RESOStandards/reso-tools#150.

/** Lifecycle status of a pool row. */
export type VariationItemStatus = 'pending' | 'ft-submitted' | 'resolved';

/** Terminal decision recorded when an item is resolved. */
export type VariationOutcome = 'ignored' | 'removed' | 'accepted' | 'ft-mapped';

/** Submitter's preferred outcome carried forward from the cert-report. */
export type VariationRequestedAction = 'ignore' | 'remove' | 'fast-track';

/** Action enum for draft + Submit decisions. */
export type VariationDraftAction = 'ignore' | 'remove' | 'accept' | 'submit-to-ft' | 'ft-mapped';

/** Role of the editor whose action most recently touched a row. */
export type VariationEditorRole = 'provider' | 'admin' | 'ft-admin';

/** Canonical mapping target — what gets written to the canonical store
 *  for `accept` / `ft-mapped` outcomes. Mirrors the canonical CSV schema. */
export interface VariationMapping {
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedStandardLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  readonly notes?: string;
}

/** One `(providerUoi, providerUsi, recipientUoi)` provenance entry on
 *  an items-screen row. The accordion-per-provider detail view renders
 *  one collapsible section per entry. */
export interface VariationProvenance {
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly requestedAction?: VariationRequestedAction;
  readonly submittedByProviderUoi: string;
  readonly submittedByDisplayName?: string;
  readonly submittedAt: string;
  readonly endorsementId: string;
  readonly environmentName: string;
  /** Per-row lastEditor metadata, denormalized on the pool row by the
   *  backend so the UI can render the per-provider ball indicator
   *  without loading the per-record S3 file. */
  readonly lastEditorUoi?: string;
  readonly lastEditorDisplayName?: string;
  readonly lastEditorEmail?: string;
  readonly lastEditorRole?: VariationEditorRole;
  readonly lastUpdatedAt?: string;
}

/** Draft state for the requesting user on a given item. Absent when
 *  the user hasn't drafted anything yet. */
export interface VariationItemMyDraft {
  readonly action: VariationDraftAction;
  readonly mapping?: VariationMapping;
  readonly draftedAt: string;
}

/** Draft state for another editor on the same item. The items-screen
 *  surfaces these so editors can see "X has a different draft" before
 *  Submit. */
export interface VariationItemOtherDraft {
  readonly userUoi: string;
  readonly userDisplayName?: string;
  readonly action: VariationDraftAction;
  readonly draftedAt: string;
}

/** A single row in the items-screen feed response. */
export interface VariationItem {
  readonly variationKey: string;
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly status: VariationItemStatus;
  readonly outcome?: VariationOutcome;
  readonly mapping?: VariationMapping;
  readonly provenance: ReadonlyArray<VariationProvenance>;
  /** High-water `lastUpdatedAt` across all underlying rows. Used by the
   *  client-side diff to detect "moved since you loaded." */
  readonly lastUpdatedAt: string;
  /** Editor metadata from the most-recently-touched row. Drives the
   *  items-screen "ball with whom" pill. */
  readonly lastEditorUoi?: string;
  readonly lastEditorDisplayName?: string;
  readonly lastEditorEmail?: string;
  readonly lastEditorRole?: VariationEditorRole;
  readonly myDraft?: VariationItemMyDraft;
  readonly otherDrafts: ReadonlyArray<VariationItemOtherDraft>;
}

/** One page of the items-screen feed plus an opaque cursor for the
 *  next page. `nextCursor` is absent when the scan is exhausted. */
export interface VariationItemsPage {
  readonly items: ReadonlyArray<VariationItem>;
  readonly nextCursor?: string;
}

/** Query options for `listVariationItems`. All optional — defaults
 *  produce the first page of every pool row the caller's role permits. */
export interface ListVariationItemsOptions {
  readonly status?: VariationItemStatus;
  readonly elementType?: 'resource' | 'field' | 'lookup';
  /** Opaque cursor from the prior page's `nextCursor`. */
  readonly cursor?: string;
  /** Cap items per page (defaults to DDB's native 1 MB page size). */
  readonly limit?: number;
}

/**
 * Fetch one page of items-screen rows. Server applies scope based on
 * the caller's auth context (admin sees full pool; provider sees own
 * partition only), so callers don't pass scope explicitly.
 *
 * Returns an empty page (`{ items: [] }`) on non-2xx; callers should
 * treat that as no-data, not error, since the items-screen surfaces
 * its own loading/empty/error UI from page state.
 */
export const listVariationItems = async (
  options?: ListVariationItemsOptions
): Promise<VariationItemsPage> => {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.elementType) params.set('elementType', options.elementType);
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/v2/certification/variations-review-items${qs ? `?${qs}` : ''}`;
  const res = await authedFetch(proxiedUrl(path), { headers: jsonHeaders });
  if (!res.ok) return { items: [] };
  return (await res.json()) as VariationItemsPage;
};

// ── Drafts (variationsReviewDrafts pool) ─────────────────────────────
//
// Per-user, server-side scratch state for the items-screen. Save is
// idempotent and unlocked — concurrent editors each have their own
// row. 30-day TTL is enforced by the backend's `variationsReviewDrafts`
// table. See reso-tools#150 and cert-backend PR #103.

/** Payload for POST /v2/certification/variations-review-drafts. */
export interface SaveDraftBody {
  readonly variationKey: string;
  readonly action: VariationDraftAction;
  /** Required for `accept` / `ft-mapped`. Server returns 400 if
   *  missing. */
  readonly mapping?: VariationMapping;
  /** Optional — surfaces in other editors' `otherDrafts` so they
   *  see who's drafting. */
  readonly userDisplayName?: string;
}

/** Response from save — the affected item's current state so the
 *  client can diff against its load-time snapshot and prompt the
 *  user inline if something moved while they were drafting (status
 *  drift, other editors' new drafts). */
export interface SaveDraftResult {
  readonly variationKey: string;
  readonly myDraft?: VariationItemMyDraft;
  readonly otherDrafts: ReadonlyArray<VariationItemOtherDraft>;
  readonly status: VariationItemStatus;
  readonly lastUpdatedAt: string;
}

/**
 * Save or update the requesting user's draft on a single item.
 * Returns the affected item's current pool state so the caller can
 * detect drift since drawer-open time.
 *
 * Returns null on non-2xx. Callers should surface error state — a
 * 400 typically means the action's mapping requirements weren't met
 * (`accept` / `ft-mapped` need a target).
 */
export const saveDraft = async (body: SaveDraftBody): Promise<SaveDraftResult | null> => {
  const res = await authedFetch(proxiedUrl('/v2/certification/variations-review-drafts'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as SaveDraftResult;
};

/**
 * Discard the user's draft on a single item. Idempotent — DELETE on
 * a key that has no draft still returns ok.
 */
export const deleteDraft = async (variationKey: string): Promise<boolean> => {
  const res = await authedFetch(
    proxiedUrl(`/v2/certification/variations-review-drafts/${encodeURIComponent(variationKey)}`),
    { method: 'DELETE', headers: jsonHeaders }
  );
  return res.ok;
};

// ── Locks ────────────────────────────────────────────────────────────

/** Lock record from the locks service. */
export interface LockRecord {
  readonly providerUoi: string;
  readonly resourceId: string;
  readonly lockUnixTimestamp: number;
  readonly lockUnixTimestampTTL: number;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
}

/** Create lock payload. */
export interface CreateLockPayload {
  readonly resourceId: string;
  readonly providerUoi: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
}

/** Build the lock resourceId for a variations report. */
export const variationsLockResourceId = (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string
): string =>
  `variations/${version}/${providerUoi}/${providerUsi}/${recipientUoi}`;

/** Search for existing locks on a resource. */
export const searchLocks = async (
  resourceId: string,
  providerUoi: string
): Promise<ReadonlyArray<LockRecord>> => {
  const res = await authedFetch(proxiedUrl('/v2/locks/search'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ resourceId, providerUoi }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.results ?? data) as ReadonlyArray<LockRecord>;
};

/** Create a lock on a resource. Returns the expiration timestamp. */
export const createLock = async (
  payload: CreateLockPayload
): Promise<{ expirationTimestamp: string } | null> => {
  const res = await authedFetch(proxiedUrl('/v2/locks'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  return (await res.json()) as { expirationTimestamp: string };
};

/** Delete a lock on a resource. */
export const deleteLock = async (
  resourceId: string,
  providerUoi: string
): Promise<boolean> => {
  const res = await authedFetch(proxiedUrl('/v2/locks'), {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ resourceId, providerUoi }),
  });
  return res.ok;
};

// ── Deterministic Cert Request ID ────────────────────────────────────

/**
 * Generate a deterministic certification request ID from test params.
 * Same inputs always produce the same ID — maps to the same S3 conversation thread.
 */
export const generateCertRequestId = async (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string
): Promise<string> => {
  const input = `${version}:${providerUoi}:${providerUsi}:${recipientUoi}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 15);
};
