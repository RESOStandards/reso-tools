/**
 * Notifications hook — polls services.reso.org for unread notifications
 * and exposes them for the notification bell and other consumers.
 *
 * Uses a module-level singleton for the poll loop so multiple hook
 * consumers share one timer and one network request.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from './use-auth';
import {
  searchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationEventType,
  type ServiceNotification,
} from '../api/services-client';

const POLL_INTERVAL_MS = 60_000; // 1 minute
const EVENT_TYPES: ReadonlyArray<NotificationEventType> = ['JOB', 'VARIATIONS_REPORT', 'JOB_FAILED'];

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

/** Fetch notifications using the provided token getter. */
const doFetch = async (getToken: () => Promise<string>): Promise<void> => {
  if (singletonFetching) return;
  singletonFetching = true;
  singletonLoading = true;
  notify();

  try {
    const token = await getToken();
    const results = await searchNotifications(token, EVENT_TYPES);
    singletonNotifications = results;
  } catch {
    // No token or network error — keep stale data
  } finally {
    singletonLoading = false;
    singletonFetching = false;
    notify();
  }
};

const startPolling = (getToken: () => Promise<string>): void => {
  if (singletonTimer) return; // Already polling
  doFetch(getToken);
  singletonTimer = setInterval(() => doFetch(getToken), POLL_INTERVAL_MS);
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

  // Start/stop polling based on auth state
  useEffect(() => {
    if (!auth?.isAuthenticated) {
      stopPolling();
      return;
    }
    const getToken = () => auth.ensureFreshProviderToken();
    startPolling(getToken);
    return () => {}; // Don't stop on unmount — other consumers may still need it
  }, [auth?.isAuthenticated]);

  const markRead = useCallback((notificationId: string, timestamp: string) => {
    singletonNotifications = singletonNotifications.filter(n => n.notificationId !== notificationId);
    notify();
    auth?.ensureFreshProviderToken()
      .then(token => markNotificationRead(token, notificationId, timestamp))
      .catch(() => {});
  }, [auth]);

  const markAllRead = useCallback(() => {
    singletonNotifications = [];
    notify();
    auth?.ensureFreshProviderToken()
      .then(token => markAllNotificationsRead(token, EVENT_TYPES))
      .catch(() => {});
  }, [auth]);

  const refresh = useCallback(async () => {
    if (!auth?.isAuthenticated) return;
    await doFetch(() => auth.ensureFreshProviderToken());
  }, [auth]);

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
