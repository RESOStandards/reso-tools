/**
 * Server Explorer — metadata browser powered by cert API data.
 *
 * Mirrors the live metadata browser layout (resource list → field list →
 * expandable detail) but uses the DD detail report for field catalog
 * and the data availability report for per-field/lookup availability.
 *
 * No live server connection needed. All data comes from:
 *   - DDDetailReport.fields[] — field catalog
 *   - DataAvailabilityReport.fields[] — per-field availability
 *   - DataAvailabilityReport.lookupValues[] — per-lookup availability
 */

import { useMemo, useState } from 'react';
import type {
  DDDetailField,
  DDDetailReport,
  DataAvailabilityField,
  DataAvailabilityLookup,
  DataAvailabilityReport,
} from '../../api/cert-client.js';

type CategoryFilter = 'all' | 'reso' | 'local' | 'payload';

const ENUM_NS = 'org.reso.metadata.enums.';

/** Build a dd.reso.org wiki URL for a field. */
const fieldWikiUrl = (version: string, fieldName: string): string =>
  `https://dd.reso.org/DD${version}/${encodeURIComponent(fieldName)}`;

/** Build a dd.reso.org wiki URL for a lookup value. */
const lookupWikiUrl = (version: string, lookupName: string, lookupValue: string): string =>
  `https://dd.reso.org/DD${version}/lookups/${encodeURIComponent(lookupName)}/${encodeURIComponent(lookupValue)}`;

/** Build a dd.reso.org wiki URL for a resource. */
const resourceWikiUrl = (version: string, resourceName: string): string =>
  `https://dd.reso.org/DD${version}/${encodeURIComponent(resourceName)}`;

/** Derive a friendly DD type from the OData type string. */
const friendlyType = (odataType: string, isCollection: boolean): string => {
  if (odataType.startsWith(ENUM_NS)) return isCollection ? 'String List, Multi' : 'String List, Single';
  const simple: Readonly<Record<string, string>> = {
    'Edm.String': 'String',
    'Edm.Boolean': 'Boolean',
    'Edm.Decimal': 'Decimal',
    'Edm.Double': 'Number',
    'Edm.Int16': 'Integer',
    'Edm.Int32': 'Integer',
    'Edm.Int64': 'Integer',
    'Edm.Date': 'Date',
    'Edm.DateTimeOffset': 'Timestamp',
  };
  return simple[odataType] ?? odataType;
};

/** Extract lookup name from enum type: org.reso.metadata.enums.Appliances → Appliances */
const extractLookupName = (odataType: string): string | null =>
  odataType.startsWith(ENUM_NS) ? odataType.slice(ENUM_NS.length) : null;

/** Color class for availability percentage. */
const availColor = (pct: number): string =>
  pct >= 75 ? 'text-green-600 dark:text-green-400'
    : pct >= 25 ? 'text-amber-600 dark:text-amber-400'
    : 'text-red-600 dark:text-red-400';

/** Availability bar. */
const AvailBar = ({ pct: value }: { readonly pct: number }) => (
  <div className="flex items-center gap-2">
    <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${
          value >= 75 ? 'bg-green-500' : value >= 25 ? 'bg-amber-500' : 'bg-red-500'
        }`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
    <span className={`text-xs font-semibold tabular-nums w-10 text-right ${availColor(value)}`}>
      {Math.round(value)}%
    </span>
  </div>
);

// ── Types ────────────────────────────────────────────────────────────

interface EnrichedField {
  readonly fieldName: string;
  readonly resourceName: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly payloads: ReadonlyArray<string>;
  readonly standardRESO: boolean;
  readonly annotations: ReadonlyArray<{ term: string; value: string }>;
  readonly availability: number | null;
  readonly frequency: number | null;
  readonly lookupName: string | null;
  readonly isEnum: boolean;
}

type SortKey = 'name' | 'type' | 'availability';
type LookupFilter = 'all' | 'reso' | 'local';

// ── Field Detail Panel ──────────────────────────────────────────────

const FieldDetailPanel = ({
  field,
  lookupValues,
  version,
}: {
  readonly field: EnrichedField;
  readonly lookupValues: ReadonlyArray<DataAvailabilityLookup>;
  readonly version: string;
}) => {
  const [activeTab, setActiveTab] = useState<'lookups' | 'dd' | 'odata' | 'annotations'>('dd');
  const [lookupFilter, setLookupFilter] = useState<LookupFilter>('all');

  const filteredLookups = useMemo(() => {
    if (lookupFilter === 'all') return lookupValues;
    if (lookupFilter === 'reso') return lookupValues.filter((l) => l.standardRESO);
    return lookupValues.filter((l) => !l.standardRESO);
  }, [lookupValues, lookupFilter]);

  const lookupCounts = useMemo(() => ({
    all: lookupValues.length,
    reso: lookupValues.filter((l) => l.standardRESO).length,
    local: lookupValues.filter((l) => !l.standardRESO).length,
  }), [lookupValues]);

  const isCollection = field.type.startsWith('Collection(') || field.isEnum;
  const underlyingType = lookupValues.length > 0 ? lookupValues[0].type : null;

  const tabs = [
    ...(lookupValues.length > 0 ? [{ key: 'lookups' as const, label: 'Lookup Values' }] : []),
    { key: 'dd' as const, label: 'Data Dictionary' },
    { key: 'odata' as const, label: 'OData Info' },
    ...(field.annotations.length > 0 ? [{ key: 'annotations' as const, label: 'Annotations' }] : []),
  ];

  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
      {/* Availability hero */}
      {field.availability !== null && (
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500 dark:text-gray-400">Availability</span>
          <div className="flex-1 max-w-xs">
            <AvailBar pct={field.availability * 100} />
          </div>
          {field.frequency !== null && (
            <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {field.frequency.toLocaleString()} records
            </span>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Lookup Values tab */}
      {activeTab === 'lookups' && (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            {(['all', 'reso', 'local'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setLookupFilter(f)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  lookupFilter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
                }`}
              >
                {f === 'all' ? 'All' : f === 'reso' ? 'RESO' : 'Local'}
                <span className={`text-[10px] tabular-nums ${lookupFilter === f ? 'text-blue-200' : 'text-gray-400'}`}>
                  ({lookupCounts[f]})
                </span>
              </button>
            ))}
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredLookups.map((l) => (
              <div key={`${l.fieldName}-${l.lookupValue}`} className="flex items-center justify-between py-1.5 text-sm">
                <div className="min-w-0">
                  <a
                    href={lookupWikiUrl(version, field.lookupName ?? field.fieldName, l.lookupValue)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {l.lookupValue}
                  </a>
                  {!l.standardRESO && (
                    <span className="ml-1.5 px-1 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      local
                    </span>
                  )}
                </div>
                <div className="w-28 shrink-0">
                  <AvailBar pct={l.availability * 100} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Dictionary tab */}
      {activeTab === 'dd' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Type</span>
            <span className="font-medium text-gray-800 dark:text-gray-200">
              {friendlyType(field.type, isCollection)}
            </span>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Payloads</span>
            <span className="font-medium text-gray-800 dark:text-gray-200">
              {field.payloads.filter(Boolean).join(', ') || '—'}
            </span>
          </div>
          {field.lookupName && (
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">Lookup Name</span>
              <span className="font-mono text-gray-800 dark:text-gray-200">{field.lookupName}</span>
            </div>
          )}
          <div className="col-span-2 sm:col-span-3">
            <a
              href={fieldWikiUrl(version, field.fieldName)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z" />
                <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 105.656 5.656l3-3a4 4 0 00-.225-5.865z" />
              </svg>
              DD Wiki
            </a>
          </div>
        </div>
      )}

      {/* OData Info tab */}
      {activeTab === 'odata' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">OData Type</span>
            <span className="font-mono text-gray-800 dark:text-gray-200">{field.type}</span>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Nullable</span>
            <span className="text-gray-800 dark:text-gray-200">{field.nullable ? 'true' : 'false'}</span>
          </div>
          {field.isEnum && (
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">Collection</span>
              <span className="text-gray-800 dark:text-gray-200">true</span>
            </div>
          )}
          {underlyingType && (
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 block">Underlying Type</span>
              <span className="font-mono text-gray-800 dark:text-gray-200">{underlyingType}</span>
            </div>
          )}
        </div>
      )}

      {/* Annotations tab */}
      {activeTab === 'annotations' && (
        <div className="space-y-1">
          {field.annotations.map((ann) => (
            <div key={ann.term} className="flex gap-2 text-sm">
              <span className="font-mono text-gray-500 dark:text-gray-400 shrink-0">{ann.term}</span>
              <span className="text-gray-800 dark:text-gray-200 break-all">{ann.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────

export const ServerExplorer = ({
  detail,
  availability,
}: {
  readonly detail: DDDetailReport;
  readonly availability: DataAvailabilityReport | null;
}) => {
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [searchQuery, setSearchQuery] = useState('');
  const [minAvailability, setMinAvailability] = useState(0);

  // Build availability lookup maps
  const fieldAvailMap = useMemo(() => {
    if (!availability) return new Map<string, DataAvailabilityField>();
    const map = new Map<string, DataAvailabilityField>();
    for (const f of availability.fields) {
      map.set(`${f.resourceName}:${f.fieldName}`, f);
    }
    return map;
  }, [availability]);

  const lookupsByField = useMemo(() => {
    if (!availability) return new Map<string, ReadonlyArray<DataAvailabilityLookup>>();
    const map = new Map<string, DataAvailabilityLookup[]>();
    for (const l of availability.lookupValues) {
      const key = `${l.resourceName}:${l.fieldName}`;
      const arr = map.get(key) ?? [];
      arr.push(l);
      map.set(key, arr);
    }
    return map as ReadonlyMap<string, ReadonlyArray<DataAvailabilityLookup>>;
  }, [availability]);

  // Group fields by resource
  const resourceNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of detail.fields) set.add(f.resourceName);
    return [...set].sort();
  }, [detail.fields]);

  // Enrich fields with availability + computed properties
  const enrichedFields = useMemo((): ReadonlyArray<EnrichedField> => {
    const resource = selectedResource;
    if (!resource) return [];

    return detail.fields
      .filter((f) => f.resourceName === resource)
      .map((f): EnrichedField => {
        const key = `${f.resourceName}:${f.fieldName}`;
        const avail = fieldAvailMap.get(key);
        const isEnum = f.type.startsWith(ENUM_NS);
        return {
          ...f,
          availability: avail?.availability ?? null,
          frequency: avail?.frequency ?? null,
          lookupName: extractLookupName(f.type),
          isEnum,
        };
      });
  }, [detail.fields, selectedResource, fieldAvailMap]);

  // Apply filters and sort
  const filteredFields = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return enrichedFields
      .filter((f) => {
        // Category filter
        if (categoryFilter === 'reso' && !f.standardRESO) return false;
        if (categoryFilter === 'local' && f.standardRESO) return false;
        if (categoryFilter === 'payload' && !f.payloads.some((p) => p && p !== '')) return false;

        // Availability threshold
        if (minAvailability > 0) {
          const pct = f.availability !== null ? f.availability * 100 : 0;
          if (pct < minAvailability) return false;
        }

        // Search — fields and lookup values
        if (query) {
          if (f.fieldName.toLowerCase().includes(query)) return true;
          const lookups = lookupsByField.get(`${f.resourceName}:${f.fieldName}`) ?? [];
          return lookups.some((l) => l.lookupValue.toLowerCase().includes(query));
        }

        return true;
      })
      .sort((a, b) => {
        if (sortKey === 'name') return a.fieldName.localeCompare(b.fieldName);
        if (sortKey === 'type') return a.type.localeCompare(b.type);
        // availability — nulls last
        const aa = a.availability ?? -1;
        const ba = b.availability ?? -1;
        return ba - aa;
      });
  }, [enrichedFields, categoryFilter, minAvailability, searchQuery, sortKey, lookupsByField]);

  // Resource-level counts for sidebar
  const resourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of detail.fields) {
      counts.set(f.resourceName, (counts.get(f.resourceName) ?? 0) + 1);
    }
    return counts;
  }, [detail.fields]);

  const categoryLabel: Readonly<Record<CategoryFilter, string>> = {
    all: 'All',
    reso: 'RESO',
    local: 'Local',
    payload: 'Payload',
  };

  return (
    <div className="space-y-4">
      {/* Search + filters bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            placeholder="Filter by field or lookup value…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {(['all', 'reso', 'local', 'payload'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setCategoryFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                categoryFilter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {categoryLabel[f]}
            </button>
          ))}
        </div>
      </div>

      {/* Availability threshold slider */}
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="shrink-0">Availability Threshold</span>
        <input
          type="range"
          min={0}
          max={100}
          value={minAvailability}
          onChange={(e) => setMinAvailability(Number(e.target.value))}
          className="flex-1 max-w-xs accent-blue-600"
        />
        <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100 w-12 text-right">
          Above {minAvailability}%
        </span>
      </div>

      {/* Two-column layout: resources + fields */}
      <div className="flex gap-4">
        {/* Resource sidebar */}
        <div className="w-48 shrink-0 space-y-1">
          {resourceNames.map((name) => {
            const isActive = selectedResource === name;
            const count = resourceCounts.get(name) ?? 0;
            return (
              <button
                key={name}
                type="button"
                onClick={() => {
                  setSelectedResource(name);
                  setExpandedField(null);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <a
                  href={resourceWikiUrl(detail.version, name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={`font-medium truncate ${isActive ? 'text-white' : 'hover:underline'}`}
                >
                  {name}
                </a>
                <span className={`text-xs tabular-nums ${isActive ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
                  ({count})
                </span>
              </button>
            );
          })}
        </div>

        {/* Field list */}
        <div className="flex-1 min-w-0">
          {!selectedResource ? (
            <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Select a resource to browse fields
            </div>
          ) : (
            <div>
              {/* Sort controls */}
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{filteredFields.length}</span>
                  {' '}of{' '}
                  <span className="tabular-nums">{enrichedFields.length}</span>
                  {' '}fields
                </p>
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">Sort:</span>
                  {(['name', 'type', 'availability'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSortKey(k)}
                      className={`px-2 py-0.5 rounded text-xs transition-colors ${
                        sortKey === k
                          ? 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-medium'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {k === 'availability' ? 'avail' : k}
                    </button>
                  ))}
                </div>
              </div>

              {/* Field rows */}
              <div className="space-y-1">
                {filteredFields.map((f) => {
                  const isExpanded = expandedField === f.fieldName;
                  const availPct = f.availability !== null ? Math.round(f.availability * 100) : null;
                  const lookups = lookupsByField.get(`${f.resourceName}:${f.fieldName}`) ?? [];

                  return (
                    <div key={f.fieldName}>
                      <button
                        type="button"
                        onClick={() => setExpandedField(isExpanded ? null : f.fieldName)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                          isExpanded
                            ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                        }`}
                      >
                        <span className="font-medium text-gray-900 dark:text-gray-100 min-w-0 truncate flex-1">
                          {f.fieldName}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 w-20 truncate">
                          {friendlyType(f.type, f.isEnum)}
                        </span>
                        {f.standardRESO ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 shrink-0">
                            RESO
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 shrink-0">
                            local
                          </span>
                        )}
                        {availPct !== null && (
                          <span className={`text-xs font-semibold tabular-nums w-10 text-right shrink-0 ${availColor(availPct)}`}>
                            {availPct}%
                          </span>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="mt-1 ml-3">
                          <FieldDetailPanel
                            field={f}
                            lookupValues={lookups}
                            version={detail.version}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
