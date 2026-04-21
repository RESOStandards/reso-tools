/**
 * Notifications hook — polls services.reso.org for unread notifications
 * and exposes them for the notification bell and other consumers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [notifications, setNotifications] = useState<ReadonlyArray<ServiceNotification>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNotifications = useCallback(async () => {
    if (!auth?.isAuthenticated) return;
    let token: string;
    try {
      token = await auth.ensureFreshProviderToken();
    } catch {
      return; // No provider token available yet
    }

    setIsLoading(true);
    try {
      const results = await searchNotifications(token, EVENT_TYPES);
      setNotifications(results);
    } catch {
      // Network error — keep stale data
    } finally {
      setIsLoading(false);
    }
  }, [auth]);

  // Initial fetch + polling
  useEffect(() => {
    if (!auth?.isAuthenticated) {
      setNotifications([]);
      return;
    }

    // Initial fetch + polling — both gated by ensureFreshProviderToken inside fetchNotifications
    fetchNotifications();
    timerRef.current = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [auth?.isAuthenticated, fetchNotifications]);

  const markRead = useCallback((notificationId: string, timestamp: string) => {
    // Optimistic: remove from UI immediately, fire API call in background
    setNotifications(prev => prev.filter(n => n.notificationId !== notificationId));
    const header = auth?.getProviderHeader();
    if (!header) return;
    const token = header.Authorization.replace('Bearer ', '');
    markNotificationRead(token, notificationId, timestamp).catch(() => {});
  }, [auth]);

  const markAllRead = useCallback(() => {
    // Optimistic: clear UI immediately, fire API call in background
    setNotifications([]);
    const header = auth?.getProviderHeader();
    if (!header) return;
    const token = header.Authorization.replace('Bearer ', '');
    markAllNotificationsRead(token, EVENT_TYPES).catch(() => {});
  }, [auth]);

  return {
    notifications,
    unreadCount: notifications.length,
    isLoading,
    isAuthenticated: auth?.isAuthenticated ?? false,
    markRead,
    markAllRead,
    refresh: fetchNotifications,
  };
};
