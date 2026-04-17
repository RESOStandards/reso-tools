/**
 * Certification Dashboard — overview of all cert activity.
 *
 * Fully driven by live job manager data. Summary tiles, recent jobs,
 * and quality changes all come from the local results scanner and
 * any in-progress runs.
 */

import { useState, useMemo, useEffect } from 'react';
import { NavLink } from 'react-router';
import { SearchInput, FilterPill } from '../../components/metadata/shared';
import { useJobs } from '../../hooks/use-jobs';
import { useOrganizationNames } from '../../hooks/use-organization-names';
import { useEndorsements } from '../../hooks/use-endorsements';
import { initIndustryBaseline } from '../../services/industry-baseline';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

const TILE = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';
const TILE_LABEL = 'text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TILE_VALUE = 'mt-1 text-3xl font-bold tabular-nums text-gray-900 dark:text-gray-100';

// ── Helpers ──────────────────────────────────────────────────────────

const formatRelative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const isWithinDays = (iso: string, days: number): boolean => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms < days * 24 * 60 * 60 * 1000;
};

// ── Main page ───────────────────────────────────────────────────────

export const DashboardPage = () => {
  const { jobs, loading, activeCount, queuedCount } = useJobs();
  const { lookup, lookupSystem } = useOrganizationNames();
  const { endorsements } = useEndorsements({ statusFilter: ['certified'], sortByTimestamp: true });
  const [search, setSearch] = useState('');

  // Fire-and-forget: warm the industry baseline cache
  useEffect(() => { initIndustryBaseline(); }, []);

  /** Resolve a UOI to an org name, falling back to the UOI itself. */
  const orgName = (uoi: string): string => lookup(uoi) ?? uoi;

  /** Resolve a USI to a system name. Returns null if not found or systemName is null. */
  const sysName = (providerUoi: string, usi: string): string | null =>
    lookupSystem(providerUoi, usi) ?? null;


  // Compute summary from live data
  const uniqueRecipients = useMemo(() =>
    new Set(jobs.map(j => j.recipientUoi)).size,
  [jobs]);

  const recentJobs = useMemo(() => {
    const sevenDays = jobs.filter(j => j.completedAt && isWithinDays(j.completedAt, 7));
    return {
      passed: sevenDays.filter(j => j.status === 'passed').length,
      failed: sevenDays.filter(j => j.status === 'failed').length,
    };
  }, [jobs]);

  // Recent jobs for the list (most recent first, max 10)
  const recentJobList = useMemo(() => {
    const query = search.toLowerCase();
    const sorted = [...jobs].sort((a, b) => {
      const aTime = a.completedAt ?? a.startedAt ?? a.queuedAt;
      const bTime = b.completedAt ?? b.startedAt ?? b.queuedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
    const filtered = query
      ? sorted.filter(j => [j.recipientName, j.endorsement, j.version, j.providerUoi].join(' ').toLowerCase().includes(query))
      : sorted;
    return filtered.slice(0, 10);
  }, [jobs, search]);

  // Jobs with errors — for quick access
  const failedJobs = useMemo(() =>
    jobs.filter(j => j.status === 'failed'),
  [jobs]);

  const passedJobs = useMemo(() =>
    jobs.filter(j => j.status === 'passed'),
  [jobs]);

  // Expiring endorsements — certified more than 2 years ago
  const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  const expiringSoon = useMemo(() => {
    const now = Date.now();
    return endorsements
      .filter(e => {
        if (e.status !== 'certified') return false;
        const age = now - new Date(e.statusTimestamp).getTime();
        return age > TWO_YEARS_MS;
      })
      .map(e => {
        const certDate = new Date(e.statusTimestamp);
        const ageMs = Date.now() - certDate.getTime();
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        const overDays = ageDays - 730; // days past 2 years
        return { ...e, certDate: certDate.toISOString().slice(0, 10), overDays };
      })
      .sort((a, b) => b.overDays - a.overDays)
      .slice(0, 10);
  }, [endorsements]);

  const hasJobs = jobs.length > 0;

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
        <div className={`${PAGE_CONTAINER} pt-6 pb-4`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
                Certification Dashboard
              </h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {loading
                  ? 'Loading results...'
                  : hasJobs
                    ? 'Overview of local testing activity and results.'
                    : 'No test results yet. Start a new test run from the Jobs page.'}
              </p>
            </div>
            {hasJobs && (
              <div className="flex items-center gap-3">
                <div className="min-w-[300px]">
                  <SearchInput value={search} onChange={setSearch} placeholder="Filter by recipient, endorsement..." />
                </div>
                <NavLink
                  to="/cert/jobs"
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors shrink-0"
                >
                  View Jobs
                </NavLink>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`${PAGE_CONTAINER} pb-20`}>
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            Loading results...
          </div>
        )}
        {/* Summary tiles */}
        {!loading && <><div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className={TILE}>
            <p className={TILE_LABEL}>Total Runs</p>
            <p className={TILE_VALUE}>{jobs.length}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Recipients</p>
            <p className={TILE_VALUE}>{uniqueRecipients}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Active</p>
            <p className={`${TILE_VALUE} ${activeCount > 0 ? 'text-blue-600 dark:text-blue-400' : ''}`}>{activeCount}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Queued</p>
            <p className={TILE_VALUE}>{queuedCount}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Passed (7d)</p>
            <p className={`${TILE_VALUE} ${recentJobs.passed > 0 ? 'text-green-600 dark:text-green-400' : ''}`}>{recentJobs.passed}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Failed (7d)</p>
            <p className={`${TILE_VALUE} ${recentJobs.failed > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{recentJobs.failed}</p>
          </div>
        </div>

        {/* Status hero cards */}
        {hasJobs && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <div className={`${passedJobs.length > 0 ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700'} border rounded-xl p-5`}>
              <div className="flex items-center gap-2 mb-1">
                <svg className={`w-5 h-5 ${passedJobs.length > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                <p className={TILE_LABEL}>Passing</p>
              </div>
              <p className={`text-3xl font-bold tabular-nums ${passedJobs.length > 0 ? 'text-green-700 dark:text-green-300' : 'text-gray-400 dark:text-gray-500'}`}>
                {passedJobs.length}
              </p>
              {passedJobs.length > 0 && (
                <p className="mt-1 text-xs text-green-600 dark:text-green-400 truncate">
                  {passedJobs.slice(0, 3).map(j => orgName(j.recipientUoi)).join(', ')}
                </p>
              )}
            </div>
            <div className={`${failedJobs.length > 0 ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700'} border rounded-xl p-5`}>
              <div className="flex items-center gap-2 mb-1">
                <svg className={`w-5 h-5 ${failedJobs.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
                <p className={TILE_LABEL}>Failing</p>
              </div>
              <p className={`text-3xl font-bold tabular-nums ${failedJobs.length > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-400 dark:text-gray-500'}`}>
                {failedJobs.length}
              </p>
              {failedJobs.length > 0 && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 truncate">
                  {failedJobs.slice(0, 3).map(j => `${orgName(j.recipientUoi)}: ${j.error ?? 'failed'}`).join('; ')}
                </p>
              )}
            </div>
          </div>
        )}

        {hasJobs && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent jobs */}
            <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Recent Jobs</h2>
                <NavLink to="/cert/jobs" className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
                  View All
                </NavLink>
              </div>
              <div className="space-y-3">
                {recentJobList.map(job => (
                  <NavLink key={job.id} to={`/cert/jobs#job-${job.id}`} className="flex items-center justify-between gap-4 rounded-lg px-2 py-1 -mx-2 hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {job.endorsement} {job.version}
                        </span>
                        {job.local && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                            Local
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {orgName(job.recipientUoi)}
                      </p>
                      {job.providerUoi && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                          {orgName(job.providerUoi)}
                          {(() => { const sn = sysName(job.providerUoi, job.providerUsi); return sn ? ` / ${sn}` : ''; })()}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-right">
                      <span className={`text-xs font-semibold uppercase w-16 ${
                        job.status === 'passed' ? 'text-green-600 dark:text-green-400' :
                        job.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                        job.status === 'running' ? 'text-blue-600 dark:text-blue-400' :
                        'text-gray-500 dark:text-gray-400'
                      }`}>
                        {job.status === 'queued' ? 'scheduled' : job.status}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums w-12 text-right">
                        {formatRelative(job.completedAt ?? job.startedAt ?? job.queuedAt)}
                      </span>
                    </div>
                  </NavLink>
                ))}
                {recentJobList.length === 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No jobs match the current filter.</p>
                )}
              </div>
            </div>

            {/* Job results summary */}
            <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Results by Recipient</h2>
              <div className="space-y-2">
                {Array.from(
                  jobs
                    .filter(j => j.status === 'passed' || j.status === 'failed')
                    .reduce((map, j) => {
                      const key = j.recipientUoi;
                      if (!map.has(key)) map.set(key, { name: orgName(j.recipientUoi), uoi: j.recipientUoi, passed: 0, failed: 0 });
                      const entry = map.get(key)!;
                      if (j.status === 'passed') entry.passed++;
                      else entry.failed++;
                      return map;
                    }, new Map<string, { name: string; uoi: string; passed: number; failed: number }>())
                    .values()
                ).map(r => (
                  <div key={r.uoi} className="flex items-center justify-between p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/40">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">{r.uoi}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {r.passed > 0 && (
                        <span className="text-xs font-semibold text-green-600 dark:text-green-400 tabular-nums">
                          {r.passed} passed
                        </span>
                      )}
                      {r.failed > 0 && (
                        <span className="text-xs font-semibold text-red-600 dark:text-red-400 tabular-nums">
                          {r.failed} failed
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Expiring Soon */}
        {expiringSoon.length > 0 && (
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Expiring Soon</h2>
                <span className="text-xs text-gray-400 dark:text-gray-500">Certified over 2 years ago</span>
              </div>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {expiringSoon.map(e => (
                <div key={e.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {lookup(e.recipientUoi) ?? e.recipientName ?? e.recipientUoi}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {e.typeLabel} {e.version}
                      {e.providerName && <span className="text-gray-400 dark:text-gray-500"> · {e.providerName}</span>}
                      {e.systemName && <span className="text-gray-400 dark:text-gray-500"> / {e.systemName}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-semibold tabular-nums ${
                      e.overDays > 180 ? 'text-red-600 dark:text-red-400' :
                      e.overDays > 90 ? 'text-amber-600 dark:text-amber-400' :
                      'text-gray-500 dark:text-gray-400'
                    }`}>
                      {e.overDays > 365 ? `${Math.floor(e.overDays / 365)}y ${e.overDays % 365}d over` : `${e.overDays}d over`}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
                      {e.certDate}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasJobs && expiringSoon.length === 0 && (
          /* Empty state */
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-12 text-center">
            <svg className="w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">No test results yet</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
              Run certification tests to see results here.
            </p>
            <NavLink
              to="/cert/jobs"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
            >
              Go to Jobs
            </NavLink>
          </div>
        )}
        </>}
      </div>
    </div>
  );
};
