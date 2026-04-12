/**
 * DD Detail Renderer — rich metadata browser with per-resource
 * field/lookup breakdowns and data availability distribution.
 *
 * Fetches DA market average data to show availability buckets and
 * industry comparisons per resource. Resource tiles are expandable —
 * click to reveal category breakdown and availability distribution.
 */

import { useState, useMemo } from 'react';
import type {
  CertReportSummary,
  CertAdvertisedResource,
  ResourceAvailability,
  AvailabilityBuckets,
} from '../../api/cert-client.js';
import { useDAMarketAverage } from '../../hooks/use-da-market-average.js';
import { useDDDetailReport } from '../../hooks/use-dd-detail-report.js';
import { useDataAvailability } from '../../hooks/use-data-availability.js';
import { ServerExplorer, type CategoryFilter as ExplorerCategory } from './server-explorer.js';
import { FilterPill } from '../metadata/shared.js';

type FieldFilter = 'all' | 'reso' | 'idx' | 'local';

const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 100) : 0;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Color class for a standardization rate. */
const stdBarColor = (rate: number): string =>
  rate >= 75 ? 'bg-green-500' : rate >= 50 ? 'bg-emerald-500' : rate >= 25 ? 'bg-amber-500' : 'bg-red-500';

/** Tile card shared styling. */
const TILE =
  'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';
const TILE_LABEL =
  'text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TILE_VALUE =
  'mt-1 text-3xl font-bold tabular-nums text-gray-900 dark:text-gray-100';
const TILE_SUB =
  'text-xs text-gray-500 dark:text-gray-400';

// ── Filter toggle button ────────────────────────────────────────────

const FILTER_LABELS: Readonly<Record<FieldFilter, string>> = {
  all: 'All',
  reso: 'RESO',
  idx: 'IDX',
  local: 'Local',
};

const FilterToggle = ({
  filter,
  count,
  active,
  onClick,
}: {
  readonly filter: FieldFilter;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
      active
        ? 'bg-blue-600 text-white shadow-sm'
        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
    }`}
  >
    {FILTER_LABELS[filter]}
    <span
      className={`inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0.5 rounded text-[10px] font-semibold tabular-nums ${
        active
          ? 'bg-blue-500 text-white'
          : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
      }`}
    >
      {count}
    </span>
  </button>
);

// ── Availability distribution ───────────────────────────────────────

/** Render availability bucket bars for a single category. */
const AvailabilityBars = ({
  label,
  buckets,
  industryBuckets,
  total,
}: {
  readonly label: string;
  readonly buckets: AvailabilityBuckets | undefined;
  readonly industryBuckets: AvailabilityBuckets | undefined;
  readonly total: number;
}) => {
  if (!buckets) return null;

  const rows: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: number;
    readonly industryValue: number;
    readonly color: string;
  }> = [
    { key: 'eq100', label: '100%', value: buckets.eq100, industryValue: industryBuckets?.eq100 ?? 0, color: 'bg-green-500' },
    { key: 'gte75', label: '≥ 75%', value: buckets.gte75, industryValue: industryBuckets?.gte75 ?? 0, color: 'bg-green-400' },
    { key: 'gte50', label: '≥ 50%', value: buckets.gte50, industryValue: industryBuckets?.gte50 ?? 0, color: 'bg-emerald-400' },
    { key: 'gte25', label: '≥ 25%', value: buckets.gte25, industryValue: industryBuckets?.gte25 ?? 0, color: 'bg-amber-400' },
    { key: 'gtZero', label: '> 0%', value: buckets.gtZero, industryValue: industryBuckets?.gtZero ?? 0, color: 'bg-amber-300 dark:bg-amber-500' },
    { key: 'eqZero', label: '0%', value: buckets.eqZero, industryValue: industryBuckets?.eqZero ?? 0, color: 'bg-gray-300 dark:bg-gray-600' },
  ];

  const maxValue = Math.max(...rows.map((r) => Math.max(r.value, r.industryValue)), 1);

  return (
    <div>
      <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">{label}</h5>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-xs">
            <span className="w-10 text-right text-gray-500 dark:text-gray-400 tabular-nums shrink-0">
              {row.label}
            </span>
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-700/50 rounded overflow-hidden relative">
                {/* Industry marker */}
                {row.industryValue > 0 && (
                  <div
                    className="absolute top-0 h-full border-r-2 border-dashed border-gray-400 dark:border-gray-500 z-10"
                    style={{ left: `${pct(row.industryValue, maxValue)}%` }}
                    title={`Industry avg: ${Math.round(row.industryValue)}`}
                  />
                )}
                {/* Provider bar */}
                <div
                  className={`h-full rounded ${row.color} transition-all`}
                  style={{ width: `${pct(row.value, maxValue)}%` }}
                />
              </div>
              <span className="w-8 text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums shrink-0">
                {Math.round(row.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {total > 0 && (
        <p className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
          out of {total.toLocaleString()} total · dashed line = industry avg
        </p>
      )}
    </div>
  );
};

// ── Expanded resource detail panel ──────────────────────────────────

const ResourceDetail = ({
  res,
  providerAvail,
  industryAvail,
}: {
  readonly res: CertAdvertisedResource;
  readonly providerAvail: ResourceAvailability | undefined;
  readonly industryAvail: ResourceAvailability | undefined;
}) => {
  const categories: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly fieldCount: number;
    readonly lookupCount: number;
    readonly color: string;
  }> = [
    { key: 'reso', label: 'RESO', fieldCount: res.fields.reso, lookupCount: res.lookups.reso, color: 'bg-green-500' },
    { key: 'idx', label: 'IDX', fieldCount: res.fields.idx, lookupCount: res.lookups.idx, color: 'bg-blue-500' },
    { key: 'local', label: 'Local', fieldCount: res.fields.local, lookupCount: res.lookups.local, color: 'bg-gray-400 dark:bg-gray-500' },
  ];

  const hasAvailability = !!providerAvail;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-3 space-y-5">
      {/* Category breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Fields */}
        <div>
          <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Fields <span className="font-normal text-gray-400">({res.fields.total.toLocaleString()} total)</span>
          </h5>
          {/* Segmented bar */}
          <div className="h-3 bg-gray-100 dark:bg-gray-700/50 rounded overflow-hidden flex mb-2">
            {categories.map((cat) =>
              cat.fieldCount > 0 ? (
                <div
                  key={cat.key}
                  className={`h-full ${cat.color} first:rounded-l last:rounded-r`}
                  style={{ width: `${pct(cat.fieldCount, res.fields.total)}%` }}
                  title={`${cat.label}: ${cat.fieldCount}`}
                />
              ) : null
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
            {categories.map((cat) => (
              <span key={cat.key} className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-sm ${cat.color}`} />
                {cat.label}: <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{cat.fieldCount.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Lookups */}
        <div>
          <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Lookups <span className="font-normal text-gray-400">({res.lookups.total.toLocaleString()} total)</span>
          </h5>
          <div className="h-3 bg-gray-100 dark:bg-gray-700/50 rounded overflow-hidden flex mb-2">
            {categories.map((cat) =>
              cat.lookupCount > 0 ? (
                <div
                  key={cat.key}
                  className={`h-full ${cat.color} first:rounded-l last:rounded-r`}
                  style={{ width: `${pct(cat.lookupCount, res.lookups.total)}%` }}
                  title={`${cat.label}: ${cat.lookupCount}`}
                />
              ) : null
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
            {categories.map((cat) => (
              <span key={cat.key} className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-sm ${cat.color}`} />
                {cat.label}: <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{cat.lookupCount.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Availability distribution */}
      {hasAvailability && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <AvailabilityBars
            label="Field Availability"
            buckets={providerAvail.fields.total}
            industryBuckets={industryAvail?.fields.total}
            total={res.fields.total}
          />
          <AvailabilityBars
            label="Lookup Availability"
            buckets={providerAvail.lookups.total}
            industryBuckets={industryAvail?.lookups.total}
            total={res.lookups.total}
          />
        </div>
      )}

      {!hasAvailability && (
        <p className="text-xs text-gray-400 dark:text-gray-500 italic">
          Data availability not available for this report
        </p>
      )}
    </div>
  );
};

// ── Chevron icon ────────────────────────────────────────────────────

const ChevronDown = ({ expanded }: { readonly expanded: boolean }) => (
  <svg
    className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
      clipRule="evenodd"
    />
  </svg>
);

// ── Main renderer ───────────────────────────────────────────────────

type DetailView = 'analytics' | 'explorer';

export const DDDetailRenderer = ({ report }: { readonly report: CertReportSummary }) => {
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FieldFilter>('all');
  const [activeView, setActiveView] = useState<DetailView>('analytics');
  const [explorerCategory, setExplorerCategory] = useState<ExplorerCategory>('all');
  const [explorerResource, setExplorerResource] = useState<string | null>(null);

  /** Navigate to the Server Explorer with a specific filter and optional resource. */
  const openExplorer = (category: ExplorerCategory, resource?: string) => {
    setExplorerCategory(category);
    setExplorerResource(resource ?? null);
    setActiveView('explorer');
  };

  const advertised = report.advertised;
  const resources = advertised ? Object.keys(advertised).sort() : [];
  const generatedOn = report.generatedOn ?? report.statusUpdatedAt;

  // Fetch DA market average for this report
  const reportIds = useMemo(() => [report.id], [report.id]);
  const { data: daData, isLoading: daLoading } = useDAMarketAverage(reportIds);

  // Fetch DD detail report + data availability for Server Explorer
  const { data: ddDetail, isLoading: ddDetailLoading } = useDDDetailReport(
    report.version,
    report.recipientUoi,
    report.providerUoi,
    report.providerUsi
  );
  const { data: dataAvail, isLoading: daAvailLoading } = useDataAvailability(report.id);

  const providerResources = daData?.availabilityReports?.[0]?.availability?.resourcesBinary;
  const industryResources = daData?.marketAverage?.resourcesBinary;

  // Roll up totals
  const totals = useMemo(() => {
    if (!advertised) return { fields: 0, resoFields: 0, idxFields: 0, localFields: 0, lookups: 0, resoLookups: 0 };
    let fields = 0, resoFields = 0, idxFields = 0, localFields = 0, lookups = 0, resoLookups = 0;
    for (const res of Object.values(advertised)) {
      fields += res.fields.total;
      resoFields += res.fields.reso;
      idxFields += res.fields.idx;
      localFields += res.fields.local;
      lookups += res.lookups.total;
      resoLookups += res.lookups.reso;
    }
    return { fields, resoFields, idxFields, localFields, lookups, resoLookups };
  }, [advertised]);

  const stdRate = pct(totals.resoFields, totals.fields);

  // Filter resources by category
  const filteredResources = useMemo(() => {
    if (!advertised || activeFilter === 'all') return resources;
    return resources.filter((name) => {
      const res = advertised[name];
      if (activeFilter === 'reso') return res.fields.reso > 0;
      if (activeFilter === 'idx') return res.fields.idx > 0;
      if (activeFilter === 'local') return res.fields.local > 0;
      return true;
    });
  }, [resources, advertised, activeFilter]);

  // Count resources per filter
  const filterCounts = useMemo(() => {
    if (!advertised) return { all: 0, reso: 0, idx: 0, local: 0 };
    const entries = Object.entries(advertised);
    return {
      all: entries.length,
      reso: entries.filter(([, r]) => r.fields.reso > 0).length,
      idx: entries.filter(([, r]) => r.fields.idx > 0).length,
      local: entries.filter(([, r]) => r.fields.local > 0).length,
    };
  }, [advertised]);

  const toggleResource = (name: string) =>
    setExpandedResource((prev) => (prev === name ? null : name));

  return (
    <div className="space-y-6">
      {/* Hero tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className={TILE}>
          <p className={TILE_LABEL}>Resources</p>
          <button type="button" onClick={() => openExplorer('all')} className={`${TILE_VALUE} hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer`}>{resources.length}</button>
        </div>
        <div className={TILE}>
          <p className={TILE_LABEL}>Fields</p>
          <button type="button" onClick={() => openExplorer('all')} className={`${TILE_VALUE} hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer`}>{totals.fields.toLocaleString()}</button>
          <p className={TILE_SUB}>
            <button type="button" onClick={() => openExplorer('reso')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer">{totals.resoFields.toLocaleString()} RESO</button>
            {' · '}
            <button type="button" onClick={() => openExplorer('local')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer">{totals.localFields.toLocaleString()} local</button>
          </p>
        </div>
        <div className={TILE}>
          <p className={TILE_LABEL}>Lookups</p>
          <button type="button" onClick={() => openExplorer('all')} className={`${TILE_VALUE} hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer`}>{totals.lookups.toLocaleString()}</button>
          <p className={TILE_SUB}>
            <button type="button" onClick={() => openExplorer('reso')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer">{totals.resoLookups.toLocaleString()} RESO</button>
            {' · '}
            <button type="button" onClick={() => openExplorer('local')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer">{(totals.lookups - totals.resoLookups).toLocaleString()} local</button>
          </p>
        </div>
        <div className={TILE}>
          <p className={TILE_LABEL}>Standardization</p>
          <p className={TILE_VALUE}>{stdRate}%</p>
          <div className="mt-2 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${stdBarColor(stdRate)}`}
              style={{ width: `${stdRate}%` }}
            />
          </div>
        </div>
        <div className={TILE}>
          <p className={TILE_LABEL}>Report Date</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {generatedOn ? formatDate(generatedOn) : '—'}
          </p>
        </div>
      </div>

      {/* View toggle: RESO Analytics / Server Explorer */}
      <div className="flex items-center gap-1">
        <FilterPill
          label="RESO Analytics"
          active={activeView === 'analytics'}
          onClick={() => setActiveView('analytics')}
        />
        <FilterPill
          label="Server Explorer"
          active={activeView === 'explorer'}
          onClick={() => setActiveView('explorer')}
        />
      </div>

      {/* ── RESO Analytics view ─────────────────────────────────── */}
      {activeView === 'analytics' && resources.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Resources</h3>
            <div className="flex items-center gap-1.5">
              {(['all', 'reso', 'idx', 'local'] as const).map((f) => (
                <FilterToggle
                  key={f}
                  filter={f}
                  count={filterCounts[f]}
                  active={activeFilter === f}
                  onClick={() => setActiveFilter(f)}
                />
              ))}
            </div>
          </div>

          {daLoading && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">Loading availability data…</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredResources.map((name) => {
              const res = advertised![name];
              const isExpanded = expandedResource === name;
              const resStdRate = pct(res.fields.reso, res.fields.total);
              const provAvail = providerResources?.[name];
              const indAvail = industryResources?.[name];

              return (
                <div
                  key={name}
                  className={`bg-white dark:bg-gray-800/60 border rounded-xl transition-colors ${
                    isExpanded
                      ? 'border-blue-400 dark:border-blue-600 col-span-1 sm:col-span-2 lg:col-span-3'
                      : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700'
                  }`}
                >
                  {/* Collapsed header — always visible */}
                  <button
                    type="button"
                    className="w-full text-left p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl"
                    onClick={() => toggleResource(name)}
                    aria-expanded={isExpanded}
                  >
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <ChevronDown expanded={isExpanded} />
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</h4>
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{resStdRate}% RESO</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
                      <div
                        className={`h-full rounded-full ${stdBarColor(resStdRate)}`}
                        style={{ width: `${resStdRate}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{res.fields.total.toLocaleString()}</span> fields
                      </span>
                      <span>
                        <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{res.lookups.total.toLocaleString()}</span> lookups
                      </span>
                      {provAvail && (
                        <span className="ml-auto flex items-center gap-3 text-[10px]">
                          <span className="text-green-600 dark:text-green-400">
                            <span className="font-semibold tabular-nums">{Math.round(provAvail.fields.total.gtZero)}</span> fields with data
                          </span>
                          <span className="text-green-600 dark:text-green-400">
                            <span className="font-semibold tabular-nums">{Math.round(provAvail.lookups.total.gtZero)}</span> lookups with data
                          </span>
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-4">
                      <ResourceDetail
                        res={res}
                        providerAvail={provAvail}
                        industryAvail={indAvail}
                      />
                      <button
                        type="button"
                        onClick={() => openExplorer('all', name)}
                        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors cursor-pointer"
                      >
                        Browse in Server Explorer
                        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638l-3.96-4.158a.75.75 0 011.08-1.04l5.25 5.5a.75.75 0 010 1.04l-5.25 5.5a.75.75 0 11-1.08-1.04l3.96-4.158H3.75A.75.75 0 013 10z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Server Explorer view ────────────────────────────────── */}
      {activeView === 'explorer' && (
        ddDetail ? (
          <ServerExplorer
            detail={ddDetail}
            availability={dataAvail}
            initialCategory={explorerCategory}
            initialResource={explorerResource}
          />
        ) : (ddDetailLoading || daAvailLoading) ? (
          <div className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            Loading server metadata…
          </div>
        ) : (
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Server metadata not available for this report
          </div>
        )
      )}
    </div>
  );
};
