/**
 * RESO Services API client (services.reso.org).
 *
 * Handles notifications, certification job status, and variations
 * submissions. Auth handled by `authedFetch` from `auth-service.ts` —
 * functions here never see or accept tokens.
 *
 * Requests are routed through the web API proxy to avoid CORS issues
 * (same proxy used for OData and Cert API calls).
 */

import { authedFetch } from '../services/auth-service';

const SERVICES_ORIGIN = 'https://services.reso.org';

/** Build a proxied URL for a services.reso.org path. */
const proxiedServicesUrl = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${SERVICES_ORIGIN}${path}`)}`;

const jsonHeaders: Readonly<Record<string, string>> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

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
  eventTypes: ReadonlyArray<NotificationEventType>,
  showUnreadOnly = true,
): Promise<ReadonlyArray<ServiceNotification>> => {
  const res = await authedFetch(proxiedServicesUrl('/v2/notifications/search'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ eventTypes, showUnreadOnly }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.results ?? [];
};

/** Mark all notifications as read for the given event types. */
export const markAllNotificationsRead = async (
  eventTypes: ReadonlyArray<NotificationEventType>,
): Promise<void> => {
  await authedFetch(proxiedServicesUrl('/v2/notifications/mark-as-read'), {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ markAllRead: true, eventTypes }),
  });
};

/** Mark a single notification as read. */
export const markNotificationRead = async (
  notificationId: string,
  notificationTimestamp: string,
): Promise<void> => {
  await authedFetch(proxiedServicesUrl('/v2/notifications/mark-as-read'), {
    method: 'PATCH',
    headers: jsonHeaders,
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
  inProgressOnly = false,
): Promise<ReadonlyArray<ServiceJobStatus>> => {
  const url = inProgressOnly
    ? '/certification/requests/status?inProgressOnly=true'
    : '/certification/requests/status?unread=true';
  const res = await authedFetch(proxiedServicesUrl(url), {
    headers: jsonHeaders,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.results ?? [];
};

/** Mark jobs as read. */
export const markJobsRead = async (
  jobIds: ReadonlyArray<string>,
): Promise<void> => {
  await authedFetch(proxiedServicesUrl('/certification/requests/mark-as-read'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(jobIds),
  });
};

/** Start a certification job on the cloud. */
export const startCloudCertification = async (
  type: string,
  version: string,
  providerUoi: string,
  providerEmail: string,
  configs: ReadonlyArray<Record<string, unknown>>,
): Promise<Response> =>
  authedFetch(proxiedServicesUrl(`/certification/requests/${type}/${version}/${providerUoi}`), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ providerUoi, providerEmail, configs }),
  });

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------

/** Submit a variations action (accept, ignore, fast-track). */
export const submitVariationAction = async (
  certificationRequestId: string,
  action: 'accept' | 'ignore' | 'fast-track',
  items: ReadonlyArray<Record<string, unknown>>,
): Promise<Response> =>
  authedFetch(proxiedServicesUrl(`/certification/requests/${certificationRequestId}/variations`), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ action, items }),
  });

// ---------------------------------------------------------------------------
// Payload Validation
// ---------------------------------------------------------------------------

/** Validate a RESO payload against a specific endorsement type. */
export const validatePayload = async (
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const res = await authedFetch(proxiedServicesUrl(`/certification/validate/${type}`), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  return res.json();
};
