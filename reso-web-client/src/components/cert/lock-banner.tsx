/**
 * Lock Banner — shows lock status at the top of the variations review page.
 *
 * Three states:
 * - No lock: shows "Request Lock" button
 * - Locked by you: green banner with expiry countdown and release button
 * - Locked by someone else: red banner with their info, mailto link, read-only
 *
 * Polls every 30s to detect lock changes.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  searchLocks,
  createLock,
  deleteLock,
  variationsLockResourceId,
  type LockRecord,
  type CreateLockPayload,
} from '../../services/variations-service';

// ── Types ────────────────────────────────────────────────────────────

interface LockBannerProps {
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly onLockStateChange: (isReadOnly: boolean) => void;
}

const POLL_INTERVAL = 30_000;
const EXPIRY_WARNING_MINUTES = 15;

// ── Component ────────────────────────────────────────────────────────

export const LockBanner = ({
  version,
  providerUoi,
  providerUsi,
  recipientUoi,
  userName,
  userEmail,
  onLockStateChange,
}: LockBannerProps) => {
  const [locks, setLocks] = useState<ReadonlyArray<LockRecord>>([]);
  const [loading, setLoading] = useState(false);
  const [expiryWarning, setExpiryWarning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resourceId = variationsLockResourceId(version, providerUoi, providerUsi, recipientUoi);

  const myLock = locks.find(l => l.email === userEmail || l.username === userName);
  const otherLock = locks.find(l => l.email !== userEmail && l.username !== userName);
  const isLockedByMe = !!myLock;
  const isLockedByOther = !!otherLock;
  const isReadOnly = isLockedByOther;

  // Notify parent of lock state
  useEffect(() => {
    onLockStateChange(isReadOnly);
  }, [isReadOnly, onLockStateChange]);

  // Check expiry warning
  useEffect(() => {
    if (!myLock) { setExpiryWarning(false); return; }
    const ttl = myLock.lockUnixTimestampTTL * 1000;
    const remaining = ttl - Date.now();
    setExpiryWarning(remaining < EXPIRY_WARNING_MINUTES * 60 * 1000 && remaining > 0);
  }, [myLock]);

  const fetchLocks = useCallback(async () => {
    const results = await searchLocks(resourceId, providerUoi);
    setLocks(results);
  }, [resourceId, providerUoi]);

  // Initial fetch + polling
  useEffect(() => {
    fetchLocks();
    pollRef.current = setInterval(fetchLocks, POLL_INTERVAL);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchLocks]);

  const handleRequestLock = useCallback(async () => {
    setLoading(true);
    const payload: CreateLockPayload = {
      resourceId,
      providerUoi,
      username: userName,
      displayName: userName,
      email: userEmail,
    };
    await createLock(payload);
    await fetchLocks();
    setLoading(false);
  }, [resourceId, providerUoi, userName, userEmail, fetchLocks]);

  const handleReleaseLock = useCallback(async () => {
    setLoading(true);
    await deleteLock(resourceId, providerUoi);
    await fetchLocks();
    setLoading(false);
  }, [resourceId, providerUoi, fetchLocks]);

  const handleReissue = useCallback(async () => {
    setLoading(true);
    await deleteLock(resourceId, providerUoi);
    const payload: CreateLockPayload = {
      resourceId,
      providerUoi,
      username: userName,
      displayName: userName,
      email: userEmail,
    };
    await createLock(payload);
    await fetchLocks();
    setExpiryWarning(false);
    setLoading(false);
  }, [resourceId, providerUoi, userName, userEmail, fetchLocks]);

  // No lock
  if (!isLockedByMe && !isLockedByOther) {
    return (
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg mb-4">
        <span className="text-xs text-gray-500 dark:text-gray-400">No one is editing this report.</span>
        <button
          type="button"
          onClick={handleRequestLock}
          disabled={loading}
          className="px-3 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {loading ? 'Requesting...' : 'Start Editing'}
        </button>
      </div>
    );
  }

  // Locked by me
  if (isLockedByMe) {
    const expiresAt = myLock ? new Date(myLock.lockUnixTimestampTTL * 1000) : null;

    return (
      <div className={`flex items-center justify-between px-4 py-2 rounded-lg mb-4 border ${
        expiryWarning
          ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700'
          : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700'
      }`}>
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${expiryWarning ? 'bg-amber-400 animate-pulse' : 'bg-green-400'}`} />
          <span className="text-xs text-gray-700 dark:text-gray-300">
            {expiryWarning
              ? 'Lock expiring soon'
              : 'You have the lock'}
            {expiresAt && (
              <span className="text-gray-400 dark:text-gray-500 ml-1">
                — expires {expiresAt.toLocaleTimeString()}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {expiryWarning && (
            <button
              type="button"
              onClick={handleReissue}
              disabled={loading}
              className="px-2.5 py-1 text-[10px] font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 transition-colors"
            >
              Extend Lock
            </button>
          )}
          <button
            type="button"
            onClick={handleReleaseLock}
            disabled={loading}
            className="px-2.5 py-1 text-[10px] font-medium rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            Release
          </button>
        </div>
      </div>
    );
  }

  // Locked by someone else
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg mb-4">
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="text-xs text-red-700 dark:text-red-300">
          Locked by <strong>{otherLock?.displayName ?? otherLock?.username}</strong>
          <span className="text-red-400 dark:text-red-500 ml-1">— read only</span>
        </span>
      </div>
      {otherLock?.email && (
        <a
          href={`mailto:${otherLock.email}?subject=Variations Report Lock`}
          className="px-2.5 py-1 text-[10px] font-medium rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
        >
          Contact
        </a>
      )}
    </div>
  );
};
