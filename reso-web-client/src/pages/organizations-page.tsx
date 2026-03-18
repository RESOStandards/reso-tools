import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOrganizations } from '../hooks/use-organizations';
import type { ResoOrganization } from '../types';

/** Multi-select dropdown with checkmarks rendered as an overlay. */
const MultiSelect = ({ label, options, selected, onChange }: {
  readonly label: string;
  readonly options: ReadonlyArray<string>;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const count = selected.size;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:border-gray-400 dark:hover:border-gray-500 focus:ring-2 focus:ring-blue-500 outline-none transition-colors"
      >
        <span className="truncate">
          {count === 0 ? label : `${label} (${count})`}
        </span>
        <svg className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg">
          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700"
            >
              Clear all
            </button>
          )}
          {options.map(opt => {
            const checked = selected.has(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 ${
                  checked
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-gray-300 dark:border-gray-500'
                }`}>
                  {checked && (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span className="truncate text-gray-900 dark:text-white">{opt}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Tiny copy-to-clipboard button. */
const CopyButton = ({ value }: { readonly value: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); copy(); }}
      className="inline-flex items-center ml-1 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <title>Copied</title>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <title>Copy</title>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
};

/** Unique sorted values from an array of organizations for a given key. */
const uniqueValues = (orgs: ReadonlyArray<ResoOrganization>, key: keyof ResoOrganization): string[] =>
  [...new Set(orgs.map(o => String(o[key] ?? '')).filter(Boolean))].sort();

/** Format an ISO date string for display. */
const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

type SortColumn = 'name' | 'type' | 'location' | 'status' | 'endorsements';

/** Sortable column header with arrow indicator. */
const SortHeader = ({ label, column, current, asc, onSort, className = '' }: {
  readonly label: string;
  readonly column: SortColumn;
  readonly current: SortColumn;
  readonly asc: boolean;
  readonly onSort: (col: SortColumn) => void;
  readonly className?: string;
}) => {
  const active = current === column;
  return (
    <th
      className={`text-left px-4 py-3 font-medium cursor-pointer select-none transition-colors ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'} ${className}`}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <svg className={`w-4 h-4 transition-transform ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-400'} ${active && !asc ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
        </svg>
      </span>
    </th>
  );
};

export const OrganizationsPage = () => {
  const { organizations, generatedOn, isLoading, error, refresh } = useOrganizations();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ReadonlySet<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string>>(new Set());
  const [stateFilter, setStateFilter] = useState<ReadonlySet<string>>(new Set());

  // Debounce search input by 150ms
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 150);
    return () => clearTimeout(id);
  }, [searchInput]);
  // Defer heavy table render so header/filters paint first
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (organizations.length > 0 && !ready) {
      const id = setTimeout(() => setReady(true), 50);
      return () => clearTimeout(id);
    }
  }, [organizations.length, ready]);

  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortColumn>('name');
  const [sortAsc, setSortAsc] = useState(true);

  const orgTypes = useMemo(() => uniqueValues(organizations, 'OrganizationType'), [organizations]);
  const certStatuses = useMemo(() => uniqueValues(organizations, 'CertificationStatus'), [organizations]);
  const states = useMemo(() => uniqueValues(organizations, 'OrganizationStateOrProvince'), [organizations]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return organizations.filter(o => {
      if (typeFilter.size > 0 && !typeFilter.has(o.OrganizationType)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(o.CertificationStatus)) return false;
      if (stateFilter.size > 0 && !stateFilter.has(o.OrganizationStateOrProvince)) return false;
      if (q && !(o.OrganizationName ?? '').toLowerCase().includes(q)
            && !(o.OrganizationCity ?? '').toLowerCase().includes(q)
            && !(o.OrganizationUniqueId ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [organizations, search, typeFilter, statusFilter, stateFilter]);

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = (a.OrganizationName ?? '').localeCompare(b.OrganizationName ?? ''); break;
        case 'type': cmp = (a.OrganizationType ?? '').localeCompare(b.OrganizationType ?? ''); break;
        case 'location': cmp = `${a.OrganizationCity},${a.OrganizationStateOrProvince}`.localeCompare(`${b.OrganizationCity},${b.OrganizationStateOrProvince}`); break;
        case 'status': cmp = (a.CertificationStatus ?? '').localeCompare(b.CertificationStatus ?? ''); break;
        case 'endorsements': cmp = (a.Endorsements?.length ?? 0) - (b.Endorsements?.length ?? 0); break;
      }
      return cmp * dir;
    });
  }, [filtered, sortKey, sortAsc]);

  // Summary counts by type
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of filtered) {
      counts.set(o.OrganizationType, (counts.get(o.OrganizationType) ?? 0) + 1);
    }
    return counts;
  }, [filtered]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Organizations &amp; Endorsements</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              RESO organizations directory
              {generatedOn && (
                <span> &middot; Updated {formatDate(generatedOn)}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors shrink-0"
          >
            <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Refresh</title>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded-lg px-4 py-3 text-sm mb-4">
            {error}
          </div>
        )}

        {/* Loading — spinner for initial fetch or deferred table render */}
        {(!ready || isLoading) && !organizations.length && (
          <div className="flex items-center justify-center py-20">
            <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading organizations...
            </div>
          </div>
        )}
        {!ready && organizations.length > 0 && (
          <div className="flex items-center justify-center py-20">
            <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading organizations...
            </div>
          </div>
        )}

        {ready && organizations.length > 0 && (
          <>
            {/* Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <input
                type="text"
                placeholder="Search by name, city, or ID..."
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              <MultiSelect label="All Types" options={orgTypes} selected={typeFilter} onChange={setTypeFilter} />
              <MultiSelect label="All Statuses" options={certStatuses} selected={statusFilter} onChange={setStatusFilter} />
              <MultiSelect label="All States/Provinces" options={states} selected={stateFilter} onChange={setStateFilter} />
            </div>

            {/* Summary badges */}
            <div className="flex flex-wrap gap-2 mb-4">
              <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                {filtered.length.toLocaleString()} organization{filtered.length !== 1 ? 's' : ''}
              </span>
              {[...typeCounts.entries()].map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    const next = new Set(typeFilter);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    setTypeFilter(next);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
                    typeFilter.has(type)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {type}: {count.toLocaleString()}
                </button>
              ))}
            </div>

            {/* Results table */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden max-h-[calc(100vh-320px)] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    <SortHeader label="Organization" column="name" current={sortKey} asc={sortAsc} onSort={toggleSort} />
                    <SortHeader label="Type" column="type" current={sortKey} asc={sortAsc} onSort={toggleSort} className="hidden sm:table-cell" />
                    <SortHeader label="Location" column="location" current={sortKey} asc={sortAsc} onSort={toggleSort} className="hidden md:table-cell" />
                    <SortHeader label="Status" column="status" current={sortKey} asc={sortAsc} onSort={toggleSort} className="min-w-[140px]" />
                    <SortHeader label="Endorsements" column="endorsements" current={sortKey} asc={sortAsc} onSort={toggleSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sorted.map((org, idx) => (
                      <OrgRow
                        key={org.OrganizationUniqueId}
                        org={org}
                        stripe={idx % 2 === 1}
                        expanded={expandedOrg === org.OrganizationUniqueId}
                        onToggle={() => setExpandedOrg(expandedOrg === org.OrganizationUniqueId ? null : org.OrganizationUniqueId)}
                      />
                    ))}
                  </tbody>
                </table>
              {filtered.length === 0 && (
                <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                  <p className="text-lg">No organizations match your filters</p>
                  <p className="text-sm mt-1">Try adjusting your search criteria.</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Certification status badge color — matches RESO certification map legend. */
const statusColor = (status: string | undefined) => {
  const s = (status ?? '').toLowerCase();
  if (s === 'certified current')  return 'bg-blue-900 text-white dark:bg-blue-800 dark:text-blue-100';
  if (s === 'passed current')     return 'bg-blue-500 text-white dark:bg-blue-600 dark:text-blue-100';
  if (s === 'certified legacy')   return 'bg-amber-500 text-white dark:bg-amber-600 dark:text-amber-100';
  if (s === 'passed legacy')      return 'bg-amber-500 text-white dark:bg-amber-600 dark:text-amber-100';
  return 'bg-gray-400 text-white dark:bg-gray-500 dark:text-gray-100';
};

const OrgRow = ({ org, stripe, expanded, onToggle }: {
  readonly org: ResoOrganization;
  readonly stripe: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) => {
  const endorsements = org.Endorsements ?? [];
  return (
  <>
    <tr
      className={`${stripe ? 'bg-gray-100 dark:bg-gray-700/40' : ''} hover:bg-gray-200/60 dark:hover:bg-gray-800/50 cursor-pointer transition-colors`}
      onClick={onToggle}
    >
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900 dark:text-white">{org.OrganizationName}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 sm:hidden">{org.OrganizationType}</div>
        {org.OrganizationWebsite && (
          <a
            href={org.OrganizationWebsite}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {org.OrganizationWebsite.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </a>
        )}
      </td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden sm:table-cell">{org.OrganizationType}</td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell">
        {org.OrganizationCity}, {org.OrganizationStateOrProvince}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${statusColor(org.CertificationStatus)}`}>
          {org.CertificationStatus}
        </span>
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        {endorsements.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {endorsements.map((e, i) => (
              <span key={i} className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                {e.Endorsement} {e.Version}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-gray-400 dark:text-gray-500 text-xs">None</span>
        )}
      </td>
    </tr>
    {expanded && (
      <tr className="bg-gray-50 dark:bg-gray-800/30">
        <td colSpan={5} className="px-4 py-4">
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Details — aligned label/value grid */}
            <div className="flex-1 text-sm">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-baseline">
                <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">ID:</span>
                <span className="flex items-center gap-1">
                  <span className="text-gray-900 dark:text-white font-mono text-xs">{org.OrganizationUniqueId}</span>
                  <CopyButton value={org.OrganizationUniqueId} />
                </span>

                {org.OrganizationCertName && (<>
                  <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">Org Name:</span>
                  <span className="flex items-center gap-1">
                    <span className="text-gray-900 dark:text-white">{org.OrganizationCertName}</span>
                    <CopyButton value={org.OrganizationCertName} />
                  </span>
                </>)}

                <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">Address:</span>
                <span className="text-gray-900 dark:text-white">
                  {[org.OrganizationAddress1, org.OrganizationCity, [org.OrganizationStateOrProvince, org.OrganizationPostalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                </span>

                {org.OrganizationMemberCount != null && (<>
                  <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">Members:</span>
                  <span className="text-gray-900 dark:text-white">{org.OrganizationMemberCount.toLocaleString()}</span>
                </>)}

                <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">Certification:</span>
                <a
                  href={org.CertificationSummaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View Summary
                </a>

                {endorsements.length > 0 && (<>
                  <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap self-start mt-0.5">Endorsements:</span>
                  <div className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-1 items-center text-xs w-fit">
                    {endorsements.map((e, i) => (
                      <Fragment key={i}>
                        <span className="text-gray-900 dark:text-white font-medium">{e.Endorsement} {e.Version}</span>
                        <span className={`inline-block px-2 py-0.5 rounded-full font-medium text-center min-w-[70px] ${statusColor(e.Status)}`}>{e.Status}</span>
                        <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap">
                          {formatDate(e.StatusUpdatedAt)}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                </>)}
              </div>
            </div>

            {/* OpenStreetMap embed */}
            {org.OrganizationLatitude !== 0 && org.OrganizationLongitude !== 0 && (
              <div className="shrink-0 w-full lg:w-64 h-48 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-600">
                <iframe
                  title={`Map for ${org.OrganizationName}`}
                  width="100%"
                  height="100%"
                  style={{ border: 0 }}
                  loading="lazy"
                  src={`https://www.openstreetmap.org/export/embed.html?bbox=${org.OrganizationLongitude - 0.02},${org.OrganizationLatitude - 0.015},${org.OrganizationLongitude + 0.02},${org.OrganizationLatitude + 0.015}&layer=mapnik&marker=${org.OrganizationLatitude},${org.OrganizationLongitude}`}
                />
              </div>
            )}
          </div>
        </td>
      </tr>
    )}
  </>
  );
};
