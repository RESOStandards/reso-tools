/**
 * Notifications hook — polls services.reso.org for unread notifications
 * and exposes them for the notification bell and other consumers.
 *
 * Uses a module-level singleton for the poll loop so multiple hook
 * consumers share one timer and one network request.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from './use-auth';
import {
  searchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationEventType,
  type ServiceNotification,
} from '../api/services-client';

const POLL_INTERVAL_MS = 60_000; // 1 minute
// VARIATIONS_REPORT catches VARIATIONS_REPORT_SAVED via BEGINS_WITH prefix
// match on the server-side notificationId. VARIATIONS_RESOLVED has a
// different prefix and has to be listed explicitly, or the bell never
// sees the admin-finalize event.
const EVENT_TYPES: ReadonlyArray<NotificationEventType> = ['JOB', 'VARIATIONS_REPORT', 'VARIATIONS_RESOLVED', 'JOB_FAILED'];

// ── Singleton poll state ────────────────────────────────────────────

let singletonNotifications: ReadonlyArray<ServiceNotification> = [];
let singletonLoading = false;
let singletonTimer: ReturnType<typeof setInterval> | null = null;
let singletonFetching = false;
const listeners = new Set<() => void>();

const notify = (): void => { for (const l of listeners) l(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = (): ReadonlyArray<ServiceNotification> => singletonNotifications;

/**
 * Fetch notifications. Auth is handled inside `searchNotifications` via
 * `authedFetch`, so no token plumbing is needed here. Re-entrancy guard
 * (`singletonFetching`) prevents overlapping fetches when the timer
 * fires while a previous fetch is still in flight.
 */
const doFetch = async (): Promise<void> => {
  if (singletonFetching) return;
  singletonFetching = true;
  singletonLoading = true;
  notify();

  try {
    const results = await searchNotifications(EVENT_TYPES);
    singletonNotifications = results;
  } catch {
    // No credentials, no auth, or network error — keep stale data.
  } finally {
    singletonLoading = false;
    singletonFetching = false;
    notify();
  }
};

const startPolling = (): void => {
  if (singletonTimer) return; // Already polling
  doFetch();
  singletonTimer = setInterval(doFetch, POLL_INTERVAL_MS);
};

const stopPolling = (): void => {
  if (singletonTimer) {
    clearInterval(singletonTimer);
    singletonTimer = null;
  }
  singletonNotifications = [];
  singletonLoading = false;
  singletonFetching = false;
  notify();
};

// ── Hook ────────────────────────────────────────────────────────────

export interface UseNotificationsResult {
  readonly notifications: ReadonlyArray<ServiceNotification>;
  readonly unreadCount: number;
  readonly isLoading: boolean;
  readonly isAuthenticated: boolean;
  readonly markRead: (notificationId: string, timestamp: string) => void;
  readonly markAllRead: () => void;
  readonly refresh: () => Promise<void>;
}

export const useNotifications = (): UseNotificationsResult => {
  const auth = useAuth();
  const notifications = useSyncExternalStore(subscribe, getSnapshot);

  // Start/stop polling based on auth state. Auth is handled inside the
  // services-client functions via authedFetch — no token plumbing here.
  useEffect(() => {
    if (!auth?.isAuthenticated) {
      stopPolling();
      return;
    }
    startPolling();
    return () => {}; // Don't stop on unmount — other consumers may still need it
  }, [auth?.isAuthenticated]);

  const markRead = useCallback((notificationId: string, timestamp: string) => {
    singletonNotifications = singletonNotifications.filter(n => n.notificationId !== notificationId);
    notify();
    markNotificationRead(notificationId, timestamp).catch(() => {});
  }, []);

  const markAllRead = useCallback(() => {
    singletonNotifications = [];
    notify();
    markAllNotificationsRead(EVENT_TYPES).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!auth?.isAuthenticated) return;
    await doFetch();
  }, [auth?.isAuthenticated]);

  return {
    notifications,
    unreadCount: notifications.length,
    isLoading: singletonLoading,
    isAuthenticated: auth?.isAuthenticated ?? false,
    markRead,
    markAllRead,
    refresh,
  };
};
