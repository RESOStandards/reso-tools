/**
 * RESO Services API client (services.reso.org).
 *
 * Handles notifications, certification job status, and variations
 * submissions. All requests use Bearer token auth from the provider
 * token obtained during login.
 *
 * Requests are routed through the web API proxy to avoid CORS issues
 * (same proxy used for OData and Cert API calls).
 */

const SERVICES_ORIGIN = 'https://services.reso.org';

/** Build a proxied URL for a services.reso.org path. */
const proxiedServicesUrl = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${SERVICES_ORIGIN}${path}`)}`;

/** Build auth headers for services.reso.org. */
const bearerHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Event types for notification filtering. */
export type NotificationEventType = 'JOB' | 'VARIATIONS_REPORT' | 'JOB_FAILED';

/** A single notification from the services API. */
export interface ServiceNotification {
  readonly notificationId: string;
  readonly notificationType: string;
  readonly notificationTimestamp: string;
  readonly certificationRequestId?: string;
  readonly reportId?: string;
  readonly status?: string;
  readonly statusTimestamp?: string;
  readonly providerUoi?: string;
  readonly recipientUoi?: string;
  readonly type?: string;
  readonly version?: string;
  readonly [key: string]: unknown;
}

/** Search for notifications by event types. */
export const searchNotifications = async (
  token: string,
  eventTypes: ReadonlyArray<NotificationEventType>,
  showUnreadOnly = true,
): Promise<ReadonlyArray<ServiceNotification>> => {
  const res = await fetch(proxiedServicesUrl('/v2/notifications/search'), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify({ eventTypes, showUnreadOnly }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.results ?? [];
};

/** Mark all notifications as read for the given event types. */
export const markAllNotificationsRead = async (
  token: string,
  eventTypes: ReadonlyArray<NotificationEventType>,
): Promise<void> => {
  await fetch(proxiedServicesUrl('/v2/notifications/mark-as-read'), {
    method: 'PATCH',
    headers: bearerHeaders(token),
    body: JSON.stringify({ markAllRead: true, eventTypes }),
  });
};

/** Mark a single notification as read. */
export const markNotificationRead = async (
  token: string,
  notificationId: string,
  notificationTimestamp: string,
): Promise<void> => {
  await fetch(proxiedServicesUrl('/v2/notifications/mark-as-read'), {
    method: 'PATCH',
    headers: bearerHeaders(token),
    body: JSON.stringify({ notificationId, notificationTimestamp }),
  });
};

// ---------------------------------------------------------------------------
// Certification Jobs
// ---------------------------------------------------------------------------

/** Job status from the services API. */
export interface ServiceJobStatus {
  readonly certificationRequestId: string;
  readonly status: string;
  readonly statusTimestamp: string;
  readonly type?: string;
  readonly version?: string;
  readonly providerUoi?: string;
  readonly recipientUoi?: string;
  readonly [key: string]: unknown;
}

/** Fetch certification job statuses. */
export const fetchJobStatuses = async (
  token: string,
  inProgressOnly = false,
): Promise<ReadonlyArray<ServiceJobStatus>> => {
  const url = inProgressOnly
    ? '/certification/requests/status?inProgressOnly=true'
    : '/certification/requests/status?unread=true';
  const res = await fetch(proxiedServicesUrl(url), {
    headers: bearerHeaders(token),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.results ?? [];
};

/** Mark jobs as read. */
export const markJobsRead = async (
  token: string,
  jobIds: ReadonlyArray<string>,
): Promise<void> => {
  await fetch(proxiedServicesUrl('/certification/requests/mark-as-read'), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify(jobIds),
  });
};

/** Start a certification job on the cloud. */
export const startCloudCertification = async (
  token: string,
  type: string,
  version: string,
  providerUoi: string,
  providerEmail: string,
  configs: ReadonlyArray<Record<string, unknown>>,
): Promise<Response> =>
  fetch(proxiedServicesUrl(`/certification/requests/${type}/${version}/${providerUoi}`), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify({ providerUoi, providerEmail, configs }),
  });

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------

/** Submit a variations action (accept, ignore, fast-track). */
export const submitVariationAction = async (
  token: string,
  certificationRequestId: string,
  action: 'accept' | 'ignore' | 'fast-track',
  items: ReadonlyArray<Record<string, unknown>>,
): Promise<Response> =>
  fetch(proxiedServicesUrl(`/certification/requests/${certificationRequestId}/variations`), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify({ action, items }),
  });

// ---------------------------------------------------------------------------
// Payload Validation
// ---------------------------------------------------------------------------

/** Validate a RESO payload against a specific endorsement type. */
export const validatePayload = async (
  token: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const res = await fetch(proxiedServicesUrl(`/certification/validate/${type}`), {
    method: 'POST',
    headers: bearerHeaders(token),
    body: JSON.stringify(payload),
  });
  return res.json();
};
