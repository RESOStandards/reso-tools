/**
 * Variations Service — API client for services.reso.org variations,
 * locks, and variations report endpoints.
 *
 * Auth: Bearer token from the provider token obtained via Cert QA login.
 * All requests go through the web API proxy to avoid CORS issues.
 *
 * Only authenticated endpoints use the token — never send tokens to
 * public endpoints.
 */

const SERVICES_ORIGIN = 'https://services.reso.org';

/** Build a proxied URL for a services.reso.org path. */
const proxiedUrl = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${SERVICES_ORIGIN}${path}`)}`;

/** Build Bearer auth headers. */
const bearerHeaders = (token: string, contentType = 'application/json'): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'Content-Type': contentType,
});

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
  metadataReport: { readonly fields: ReadonlyArray<unknown>; readonly lookups: ReadonlyArray<unknown> },
  token: string
): Promise<VariationsSuggestionsMap> => {
  const res = await fetch(proxiedUrl('/certification/variations/search'), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify(metadataReport),
  });
  if (!res.ok) return {};
  return (await res.json()) as VariationsSuggestionsMap;
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
  `/certification/variations-reports/${encodeURIComponent(version)}/${encodeURIComponent(providerUoi)}/${encodeURIComponent(providerUsi)}/${encodeURIComponent(recipientUoi)}/${encodeURIComponent(certRequestId)}`;

/** Fetch an existing variations report from S3. */
export const getVariationsReport = async (
  version: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string,
  certRequestId: string,
  token: string
): Promise<VariationsReportPayload | null> => {
  const res = await fetch(
    proxiedUrl(variationsReportPath(version, providerUoi, providerUsi, recipientUoi, certRequestId)),
    { headers: bearerHeaders(token) }
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
  payload: VariationsReportPayload,
  token: string
): Promise<boolean> => {
  const res = await fetch(
    proxiedUrl(variationsReportPath(version, providerUoi, providerUsi, recipientUoi, certRequestId)),
    {
      method: 'POST',
      headers: bearerHeaders(token),
      body: JSON.stringify(payload),
    }
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
  providerUoi: string,
  token: string
): Promise<ReadonlyArray<LockRecord>> => {
  const res = await fetch(proxiedUrl('/locks/search'), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify({ resourceId, providerUoi }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.results ?? data) as ReadonlyArray<LockRecord>;
};

/** Create a lock on a resource. Returns the expiration timestamp. */
export const createLock = async (
  payload: CreateLockPayload,
  token: string
): Promise<{ expirationTimestamp: string } | null> => {
  const res = await fetch(proxiedUrl('/locks'), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  return (await res.json()) as { expirationTimestamp: string };
};

/** Delete a lock on a resource. */
export const deleteLock = async (
  resourceId: string,
  providerUoi: string,
  token: string
): Promise<boolean> => {
  const res = await fetch(proxiedUrl('/locks'), {
    method: 'DELETE',
    headers: bearerHeaders(token),
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
