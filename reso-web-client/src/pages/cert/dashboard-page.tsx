/**
 * Certification Dashboard — overview of all cert activity for the
 * authenticated user.
 *
 * Shows: recent jobs, expiring endorsements, version-over-version
 * quality trends, and anomaly alerts.
 *
 * This is a stub with placeholder UI for layout review.
 */

import { useState, useMemo } from 'react';
import { NavLink } from 'react-router';
import { StatusPill } from '../../components/cert/status-pill';
import { SearchInput, FilterPill } from '../../components/metadata/shared';
import { useJobs } from '../../hooks/use-jobs';
import type { Job } from '../../services/job-manager';
import type { EndorsementStatus } from '../../api/cert-fixtures';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

const TILE = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';
const TILE_LABEL = 'text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TILE_VALUE = 'mt-1 text-3xl font-bold tabular-nums text-gray-900 dark:text-gray-100';

// ── Fixture data ────────────────────────────────────────────────────

interface DashboardSummary {
  readonly totalOrgs: number;
  readonly activeJobs: number;
  readonly scheduledJobs: number;
  readonly passedThisWeek: number;
  readonly failedThisWeek: number;
  readonly expiringSoon: number;
}

interface RecentJob {
  readonly id: string;
  readonly endorsement: string;
  readonly version: string;
  readonly recipientName: string;
  readonly status: 'passed' | 'failed' | 'running' | 'scheduled';
  readonly timestamp: string;
  readonly local: boolean;
}

interface ExpiringEndorsement {
  readonly recipientName: string;
  readonly recipientUoi: string;
  readonly endorsement: string;
  readonly version: string;
  readonly certifiedDate: string;
  readonly daysRemaining: number;
}

interface QualityDelta {
  readonly recipientName: string;
  readonly endorsement: string;
  readonly version: string;
  readonly metric: string;
  readonly previous: number;
  readonly current: number;
  readonly improved: boolean;
}

const SAMPLE_SUMMARY: DashboardSummary = {
  totalOrgs: 47,
  activeJobs: 2,
  scheduledJobs: 5,
  passedThisWeek: 12,
  failedThisWeek: 3,
  expiringSoon: 8,
};

const SAMPLE_RECENT_JOBS: ReadonlyArray<RecentJob> = [
  { id: '1', endorsement: 'Data Dictionary', version: '2.0', recipientName: 'Aberdeen Area AOR', status: 'running', timestamp: '2026-04-12T21:00:00Z', local: true },
  { id: '2', endorsement: 'Web API Core', version: '2.0.0', recipientName: 'Aberdeen Area AOR', status: 'scheduled', timestamp: '2026-04-12T21:15:00Z', local: true },
  { id: '3', endorsement: 'Data Dictionary', version: '2.0', recipientName: 'bridgeMLS', status: 'passed', timestamp: '2026-04-12T20:14:47Z', local: false },
  { id: '4', endorsement: 'Data Dictionary', version: '2.0', recipientName: 'State-Wide MLS', status: 'failed', timestamp: '2026-04-12T19:44:15Z', local: true },
  { id: '5', endorsement: 'Web API Core', version: '2.0.0', recipientName: 'bridgeMLS', status: 'passed', timestamp: '2026-04-12T18:30:00Z', local: false },
];

const SAMPLE_EXPIRING: ReadonlyArray<ExpiringEndorsement> = [
  { recipientName: 'Mountain View MLS', recipientUoi: 'M00000789', endorsement: 'Data Dictionary', version: '1.7', certifiedDate: '2024-06-15', daysRemaining: 12 },
  { recipientName: 'Coastal Realty Board', recipientUoi: 'M00000456', endorsement: 'Web API Core', version: '2.0.0', certifiedDate: '2024-05-22', daysRemaining: 35 },
  { recipientName: 'Heartland AOR', recipientUoi: 'M00000321', endorsement: 'Data Dictionary', version: '1.7', certifiedDate: '2024-07-01', daysRemaining: 42 },
];

const SAMPLE_DELTAS: ReadonlyArray<QualityDelta> = [
  { recipientName: 'bridgeMLS', endorsement: 'DD 2.0', version: '2.0', metric: 'Standardization', previous: 62, current: 66, improved: true },
  { recipientName: 'bridgeMLS', endorsement: 'DD 2.0', version: '2.0', metric: 'Fields with Data', previous: 523, current: 540, improved: true },
  { recipientName: 'State-Wide MLS', endorsement: 'DD 2.0', version: '2.0', metric: 'Schema Errors', previous: 0, current: 3, improved: false },
  { recipientName: 'State-Wide MLS', endorsement: 'DD 2.0', version: '2.0', metric: 'Standardization', previous: 71, current: 68, improved: false },
  { recipientName: 'Aberdeen Area AOR', endorsement: 'Core 2.0.0', version: '2.0.0', metric: 'Response Time', previous: 1.2, current: 0.9, improved: true },
  { recipientName: 'Aberdeen Area AOR', endorsement: 'DD 2.0', version: '2.0', metric: 'Fields with Data', previous: 410, current: 455, improved: true },
  { recipientName: 'Mountain View MLS', endorsement: 'DD 2.0', version: '2.0', metric: 'Lookups', previous: 1682, current: 1590, improved: false },
];

// ── Helpers ──────────────────────────────────────────────────────────

const formatRelative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

// ── Main page ───────────────────────────────────────────────────────

export const DashboardPage = () => {
  const { jobs: liveJobs, activeCount, queuedCount } = useJobs();
  const [search, setSearch] = useState('');
  const [deltaFilter, setDeltaFilter] = useState<'all' | 'improved' | 'degraded'>('all');

  // Blend live job manager data into summary tiles
  const summary: DashboardSummary = useMemo(() => ({
    ...SAMPLE_SUMMARY,
    activeJobs: SAMPLE_SUMMARY.activeJobs + activeCount,
    scheduledJobs: SAMPLE_SUMMARY.scheduledJobs + queuedCount,
    passedThisWeek: SAMPLE_SUMMARY.passedThisWeek + liveJobs.filter(j => j.status === 'passed').length,
    failedThisWeek: SAMPLE_SUMMARY.failedThisWeek + liveJobs.filter(j => j.status === 'failed').length,
  }), [liveJobs, activeCount, queuedCount]);

  // Merge live jobs into recent jobs list (live first, then fixtures)
  const liveRecentJobs: ReadonlyArray<RecentJob> = useMemo(() =>
    liveJobs.slice(0, 10).map(j => ({
      id: j.id,
      endorsement: j.endorsement,
      version: j.version,
      recipientName: j.recipientName,
      status: j.status === 'queued' ? 'scheduled' as const : j.status === 'cancelled' ? 'failed' as const : j.status,
      timestamp: j.completedAt ?? j.startedAt ?? j.queuedAt,
      local: j.local,
    })),
  [liveJobs]);

  const improvements = useMemo(() => SAMPLE_DELTAS.filter(d => d.improved), []);
  const degradations = useMemo(() => SAMPLE_DELTAS.filter(d => !d.improved), []);

  const filteredDeltas = useMemo(() => {
    const query = search.toLowerCase();
    return SAMPLE_DELTAS.filter(d => {
      if (deltaFilter === 'improved' && !d.improved) return false;
      if (deltaFilter === 'degraded' && d.improved) return false;
      if (query) {
        const searchable = [d.recipientName, d.endorsement, d.metric].join(' ').toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });
  }, [search, deltaFilter]);

  const allRecentJobs = useMemo(() =>
    [...liveRecentJobs, ...SAMPLE_RECENT_JOBS].slice(0, 10),
  [liveRecentJobs]);

  const filteredJobs = useMemo(() => {
    const query = search.toLowerCase();
    if (!query) return allRecentJobs;
    return allRecentJobs.filter(j => {
      const searchable = [j.recipientName, j.endorsement, j.version].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [search, allRecentJobs]);

  const filteredExpiring = useMemo(() => {
    const query = search.toLowerCase();
    if (!query) return SAMPLE_EXPIRING;
    return SAMPLE_EXPIRING.filter(e => {
      const searchable = [e.recipientName, e.endorsement, e.recipientUoi].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [search]);

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className={`${PAGE_CONTAINER} pt-6 pb-20`}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
              Certification Dashboard
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Overview of testing activity, results, and endorsement health.
            </p>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Filter by recipient, endorsement..." />
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className={TILE}>
            <p className={TILE_LABEL}>Organizations</p>
            <p className={TILE_VALUE}>{summary.totalOrgs}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Active Jobs</p>
            <p className={`${TILE_VALUE} ${summary.activeJobs > 0 ? 'text-blue-600 dark:text-blue-400' : ''}`}>{summary.activeJobs}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Queued</p>
            <p className={TILE_VALUE}>{summary.scheduledJobs}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Passed (7d)</p>
            <p className={`${TILE_VALUE} text-green-600 dark:text-green-400`}>{summary.passedThisWeek}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Failed (7d)</p>
            <p className={`${TILE_VALUE} ${summary.failedThisWeek > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{summary.failedThisWeek}</p>
          </div>
          <div className={TILE}>
            <p className={TILE_LABEL}>Expiring Soon</p>
            <p className={`${TILE_VALUE} ${summary.expiringSoon > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{summary.expiringSoon}</p>
          </div>
        </div>

        {/* Improvements / Degradations — hero section */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-5 h-5 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd" />
              </svg>
              <p className={TILE_LABEL}>Improvements (7d)</p>
            </div>
            <p className="text-3xl font-bold tabular-nums text-green-700 dark:text-green-300">{improvements.length}</p>
            <p className="mt-1 text-xs text-green-600 dark:text-green-400">
              {improvements.map(d => d.metric).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
            </p>
          </div>
          <div className={`${degradations.length > 0 ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700'} border rounded-xl p-5`}>
            <div className="flex items-center gap-2 mb-1">
              <svg className={`w-5 h-5 ${degradations.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M12 13a1 1 0 100 2h5a1 1 0 001-1V9a1 1 0 10-2 0v2.586l-4.293-4.293a1 1 0 00-1.414 0L8 9.586 3.707 5.293a1 1 0 00-1.414 1.414l5 5a1 1 0 001.414 0L11 9.414 14.586 13H12z" clipRule="evenodd" />
              </svg>
              <p className={TILE_LABEL}>Degradations (7d)</p>
            </div>
            <p className={`text-3xl font-bold tabular-nums ${degradations.length > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-400 dark:text-gray-500'}`}>{degradations.length}</p>
            {degradations.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {degradations.map(d => `${d.recipientName}: ${d.metric}`).join('; ')}
              </p>
            )}
          </div>
        </div>

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
              {filteredJobs.map(job => (
                <div key={job.id} className="flex items-center justify-between">
                  <div className="min-w-0">
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
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{job.recipientName}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-semibold uppercase ${
                      job.status === 'passed' ? 'text-green-600 dark:text-green-400' :
                      job.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                      job.status === 'running' ? 'text-blue-600 dark:text-blue-400' :
                      'text-gray-500 dark:text-gray-400'
                    }`}>
                      {job.status}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                      {formatRelative(job.timestamp)}
                    </span>
                  </div>
                </div>
              ))}
              {filteredJobs.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No jobs match the current filter.</p>
              )}
            </div>
          </div>

          {/* Quality changes — detailed breakdown */}
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Quality Changes</h2>
              <div className="flex items-center gap-1">
                <FilterPill label="All" active={deltaFilter === 'all'} onClick={() => setDeltaFilter('all')} />
                <FilterPill label={`Improved (${improvements.length})`} active={deltaFilter === 'improved'} onClick={() => setDeltaFilter('improved')} />
                <FilterPill label={`Degraded (${degradations.length})`} active={deltaFilter === 'degraded'} onClick={() => setDeltaFilter('degraded')} />
              </div>
            </div>
            <div className="space-y-2">
              {filteredDeltas.map((delta, i) => {
                const d = delta.current - delta.previous;
                const pct = delta.previous > 0 ? Math.round(Math.abs(d / delta.previous) * 100) : 0;
                return (
                  <div key={i} className={`flex items-center justify-between p-2.5 rounded-lg ${
                    delta.improved
                      ? 'bg-green-50/50 dark:bg-green-900/10'
                      : 'bg-red-50/50 dark:bg-red-900/10'
                  }`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {delta.recipientName}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {delta.endorsement} · {delta.metric}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">{delta.previous}</span>
                      <svg className={`w-4 h-4 ${delta.improved ? 'text-green-500' : 'text-red-500 rotate-180'}`} viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
                      </svg>
                      <div className="text-right">
                        <span className={`text-sm font-bold tabular-nums ${delta.improved ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {delta.current}
                        </span>
                        {pct > 0 && (
                          <span className={`ml-1 text-[10px] font-medium ${delta.improved ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                            {delta.improved ? '+' : '-'}{pct}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredDeltas.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No quality changes match the current filter.</p>
              )}
            </div>
          </div>

          {/* Expiring endorsements */}
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Expiring Endorsements</h2>
              <button type="button" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
                Re-run All Expiring
              </button>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {filteredExpiring.map((exp, i) => (
                <div key={i} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{exp.recipientName}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {exp.endorsement} {exp.version} · Certified {exp.certifiedDate}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-semibold tabular-nums ${
                      exp.daysRemaining <= 30 ? 'text-red-600 dark:text-red-400' :
                      exp.daysRemaining <= 60 ? 'text-amber-600 dark:text-amber-400' :
                      'text-gray-500 dark:text-gray-400'
                    }`}>
                      {exp.daysRemaining} days
                    </span>
                    <button type="button" className="px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
                      Re-run
                    </button>
                  </div>
                </div>
              ))}
              {filteredExpiring.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No expiring endorsements match the current filter.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
