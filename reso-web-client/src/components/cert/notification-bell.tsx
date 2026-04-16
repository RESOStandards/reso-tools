/**
 * Notification bell — shows unread count and a dropdown of recent
 * notifications from services.reso.org.
 *
 * Notification types:
 * - JOB: certification job completed (passed/failed)
 * - VARIATIONS_REPORT: variations report ready for review
 * - JOB_FAILED: certification job failed
 */

import { useEffect, useRef, useState } from 'react';
import { useNotifications } from '../../hooks/use-notifications';
import type { ServiceNotification } from '../../api/services-client';

const formatTimestamp = (ts: string): string => {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
};

const notificationIcon = (type: string): string => {
  if (type === 'VARIATIONS_REPORT' || type === 'variations') return '📋';
  if (type === 'JOB_FAILED' || type === 'failed') return '❌';
  return '✅';
};

const notificationLabel = (n: ServiceNotification): string => {
  const type = n.notificationType ?? n.type ?? '';
  if (type === 'VARIATIONS_REPORT' || type === 'variations') return 'Variations Report';
  if (type === 'JOB_FAILED' || type === 'failed') return 'Job Failed';
  return 'Job Completed';
};

export const NotificationBell = () => {
  const { notifications, unreadCount, markRead, markAllRead, isAuthenticated } = useNotifications();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!isAuthenticated) return null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors cursor-pointer"
        title={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}` : 'No notifications'}
        aria-label="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => { markAllRead(); }}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                No notifications
              </div>
            ) : (
              notifications.map(n => (
                <button
                  key={n.notificationId ?? n.certificationRequestId ?? n.notificationTimestamp}
                  type="button"
                  onClick={() => {
                    if (n.notificationId && n.notificationTimestamp) {
                      markRead(n.notificationId, n.notificationTimestamp);
                    }
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-50 dark:border-gray-700/50 last:border-0 cursor-pointer"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="text-base mt-0.5">{notificationIcon(n.notificationType ?? '')}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {notificationLabel(n)}
                        </span>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                          {formatTimestamp(n.notificationTimestamp ?? n.statusTimestamp ?? '')}
                        </span>
                      </div>
                      {n.status && (
                        <span className={`text-xs ${n.status === 'PASSED' ? 'text-green-600 dark:text-green-400' : n.status === 'FAILED' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                          {n.status}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
