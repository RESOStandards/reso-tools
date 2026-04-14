/**
 * Cert Error Report renderers — display failure details for each
 * endorsement type and failure category.
 *
 * Supports both legacy report formats (from the cert API) and new
 * formats (from reso-tools local and cloud testing). The report
 * format is always driven by reso-tools regardless of where it runs.
 *
 * Stub with fixture data for layout review.
 */

import { useState, useMemo } from 'react';
import { SearchInput, FilterPill, Badge, AvailBar } from '../metadata/shared.js';

// ── Types ────────────────────────────────────────────────────────────

interface SchemaError {
  readonly resourceName: string;
  readonly fieldName: string;
  readonly message: string;
  readonly lookups?: ReadonlyArray<{ lookupValue: string; count: number }>;
}

interface SchemaValidationReport {
  readonly type: 'schema-validation';
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly errors: ReadonlyArray<SchemaError>;
}

interface VariationSuggestion {
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly strategy: 'Fast Track' | 'Substring' | 'Edit Distance';
  readonly ddWikiUrl?: string;
}

interface Variation {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: ReadonlyArray<VariationSuggestion>;
  // UI state — maps to backend write-back: ignore=true or flaggedForFastTrack=true
  readonly status?: 'pending' | 'accepted' | 'ignored' | 'fast-track';
}

interface VariationsReport {
  readonly type: 'variations';
  readonly description?: string;
  readonly version?: string;
  readonly generatedOn?: string;
  readonly fuzziness?: number;
  readonly fields: ReadonlyArray<Variation>;
  readonly lookups: ReadonlyArray<Variation>;
  readonly resources: ReadonlyArray<Variation>;
}

interface StepError {
  readonly stepName: string;
  readonly message: string;
  readonly detail?: string;
  readonly httpStatus?: number;
}

interface GenericFailureReport {
  readonly type: 'generic';
  readonly endorsement: string;
  readonly failedStep: string;
  readonly errors: ReadonlyArray<StepError>;
}

export type ErrorReport = SchemaValidationReport | VariationsReport | GenericFailureReport;

// ── Fixture Data ─────────────────────────────────────────────────────

export const SAMPLE_SCHEMA_REPORT: SchemaValidationReport = {
  type: 'schema-validation',
  totalErrors: 47,
  totalWarnings: 0,
  errors: [
    {
      resourceName: 'Property',
      fieldName: 'BuyerAgentAOR',
      message: 'MUST be equal to one of the allowed values',
      lookups: [
        { lookupValue: 'AOR-7158', count: 12 },
        { lookupValue: 'AOR-3028', count: 8 },
        { lookupValue: 'AOR-9549', count: 5 },
      ],
    },
    {
      resourceName: 'Property',
      fieldName: 'CoBuyerAgentAOR',
      message: 'MUST be equal to one of the allowed values',
      lookups: [
        { lookupValue: 'AOR-4407', count: 15 },
        { lookupValue: 'AOR-6500', count: 3 },
      ],
    },
    {
      resourceName: 'Property',
      fieldName: 'ListAgentNickname',
      message: 'Fields MUST be advertised in the metadata',
    },
    {
      resourceName: 'Property',
      fieldName: 'ListAgentCity',
      message: 'Fields MUST be advertised in the metadata',
    },
    {
      resourceName: 'Property',
      fieldName: 'CeilingHeight',
      message: 'numeric field overflow',
    },
    {
      resourceName: 'Member',
      fieldName: 'MemberAOR',
      message: 'MUST be equal to one of the allowed values',
      lookups: [
        { lookupValue: 'AOR-1234', count: 200 },
      ],
    },
  ],
};

export const SAMPLE_VARIATIONS_REPORT: VariationsReport = {
  type: 'variations',
  description: 'Data Dictionary Variations Report',
  version: '2.0',
  generatedOn: '2026-04-13T03:14:41.814Z',
  fuzziness: 0.25,
  fields: [],
  lookups: [
    // Same-field mapping
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'EnergyStarQualifiedAppliances',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Appliances', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appliances+Field', suggestedLookupValue: 'ENERGY STAR Qualified Appliances' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'ExhaustFan',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Appliances', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appliances+Field', suggestedLookupValue: 'Exhaust Fan' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'GasCooking',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Appliances', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appliances+Field', suggestedLookupValue: 'Gas Cooktop' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'MultipleDishwashers',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Appliances', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appliances+Field', suggestedLookupValue: 'Dishwasher' }], status: 'fast-track' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'SeparateIceMachine',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Appliances', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appliances+Field', suggestedLookupValue: 'Ice Maker' }], status: 'pending' },

    // Cross-field mappings (source field differs from suggested field)
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'Barbecue',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ExteriorFeatures', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ExteriorFeatures+Field', suggestedLookupValue: 'Barbecue' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'CentralVacuum',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'InteriorFeatures', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/InteriorFeatures+Field', suggestedLookupValue: 'Central Vacuum' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Appliances', legacyODataValue: 'PropaneCooking',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Heating', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Heating+Field', suggestedLookupValue: 'Propane Stove' }], status: 'ignored' },

    // Multi-suggestion items (user must pick one or ignore)
    { resourceName: 'Property', fieldName: 'ArchitecturalStyle', legacyODataValue: 'ContemporaryModern',
      suggestions: [
        { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ArchitecturalStyle+Field', suggestedLookupValue: 'Contemporary' },
        { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ArchitecturalStyle+Field', suggestedLookupValue: 'Modern' },
      ], status: 'pending' },
    { resourceName: 'Property', fieldName: 'ArchitecturalStyle', legacyODataValue: 'SpanishMediterranean',
      suggestions: [
        { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ArchitecturalStyle+Field', suggestedLookupValue: 'Spanish' },
        { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ArchitecturalStyle+Field', suggestedLookupValue: 'Mediterranean' },
      ], status: 'pending' },
    { resourceName: 'Property', fieldName: 'ArchitecturalStyle', legacyODataValue: 'TriLevel',
      suggestions: [
        { suggestedResourceName: 'Property', suggestedFieldName: 'Levels', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Levels+Field', suggestedLookupValue: 'Tri-Level' },
        { suggestedResourceName: 'Property', suggestedFieldName: 'Levels', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Levels+Field', suggestedLookupValue: 'Multi/Split' },
        { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ArchitecturalStyle+Field', suggestedLookupValue: 'Split Level' },
      ], status: 'pending' },

    // Other fields
    { resourceName: 'Property', fieldName: 'Cooling', legacyODataValue: 'HeatPump',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Heating', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Heating+Field', suggestedLookupValue: 'Heat Pump' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'BuiltInBarbecue',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ExteriorFeatures', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ExteriorFeatures+Field', suggestedLookupValue: 'Built-in Barbecue' }], status: 'fast-track' },
    { resourceName: 'Property', fieldName: 'Heating', legacyODataValue: 'CentralFurnace',
      suggestions: [
        { suggestedResourceName: 'Property', suggestedFieldName: 'Heating', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Heating+Field', suggestedLookupValue: 'Central' },
        { suggestedResourceName: 'Property', suggestedFieldName: 'Heating', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Heating+Field', suggestedLookupValue: 'Forced Air' },
      ], status: 'pending' },
    { resourceName: 'Property', fieldName: 'PropertyType', legacyODataValue: 'MultiFamily',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'PropertySubType', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/PropertySubType+Field', suggestedLookupValue: 'Multi Family' }], status: 'pending' },
    { resourceName: 'Property', fieldName: 'Sewer', legacyODataValue: 'AvailableNotConnected',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Utilities', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Utilities+Field', suggestedLookupValue: 'Sewer Available' }], status: 'ignored' },
    { resourceName: 'Property', fieldName: 'WaterSource', legacyODataValue: 'HoldingTank',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'WaterSource', strategy: 'Fast Track', ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/WaterSource+Field', suggestedLookupValue: 'Cistern' }], status: 'pending' },
  ],
  resources: [],
};

export const SAMPLE_GENERIC_REPORT: GenericFailureReport = {
  type: 'generic',
  endorsement: 'Web API Core',
  failedStep: '$filter Support',
  errors: [
    {
      stepName: '$filter with compound expression',
      message: 'Server returned HTTP 400 for $filter=ListPrice ge 100000 and ListPrice le 500000',
      detail: 'OData $filter with "and" operator is required for Web API Core compliance.',
      httpStatus: 400,
    },
    {
      stepName: '$filter with contains()',
      message: 'Server returned HTTP 501 for $filter=contains(City, \'Spring\')',
      detail: 'The contains() function is required for string matching in Web API Core.',
      httpStatus: 501,
    },
  ],
};

// ── Schema Validation Error Report ───────────────────────────────────

/** Expandable field-level error card. */
const SchemaErrorCard = ({ err }: { readonly err: SchemaError }) => {
  const [expanded, setExpanded] = useState(false);
  const totalOccurrences = err.lookups?.reduce((sum, l) => sum + l.count, 0) ?? 0;

  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Badge label={err.resourceName} color="blue" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{err.fieldName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalOccurrences > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {totalOccurrences.toLocaleString()} occurrences
            </span>
          )}
          {err.lookups && err.lookups.length > 0 && (
            <Badge label={`${err.lookups.length} values`} color="red" />
          )}
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-100 dark:border-gray-700/50 pt-3 space-y-2">
          {/* Error message — copyable */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">{err.message}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(err.message)}
              className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 cursor-pointer"
              title="Copy error message"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
              </svg>
            </button>
          </div>

          {/* Lookup values */}
          {err.lookups && err.lookups.length > 0 && (
            <div className="space-y-1">
              {err.lookups.map(l => (
                <div key={l.lookupValue} className="flex items-center justify-between text-xs pl-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-700 dark:text-gray-300 font-mono">{l.lookupValue}</span>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(l.lookupValue)}
                      className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 cursor-pointer"
                      title="Copy value"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                        <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
                      </svg>
                    </button>
                  </div>
                  <span className="text-gray-400 dark:text-gray-500 tabular-nums">{l.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const SchemaValidationErrorReport = ({ report }: { readonly report: SchemaValidationReport }) => {
  const [search, setSearch] = useState('');
  const [resourceFilter, setResourceFilter] = useState<string>('all');
  const [messageFilter, setMessageFilter] = useState<string>('all');

  const resources = useMemo(() => {
    const set = new Set(report.errors.map(e => e.resourceName));
    return ['all', ...Array.from(set).sort()];
  }, [report.errors]);

  const errorMessages = useMemo(() => {
    const set = new Set(report.errors.map(e => e.message));
    return ['all', ...Array.from(set).sort()];
  }, [report.errors]);

  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return report.errors.filter(e => {
      if (resourceFilter !== 'all' && e.resourceName !== resourceFilter) return false;
      if (messageFilter !== 'all' && e.message !== messageFilter) return false;
      if (query && !e.fieldName.toLowerCase().includes(query) && !e.message.toLowerCase().includes(query)
        && !(e.lookups ?? []).some(l => l.lookupValue.toLowerCase().includes(query))) return false;
      return true;
    });
  }, [report.errors, search, resourceFilter, messageFilter]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-red-600 dark:text-red-400 tabular-nums">
            {report.totalErrors.toLocaleString()} errors across {report.errors.length} fields
          </span>
          {report.totalWarnings > 0 && (
            <span className="text-sm font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
              {report.totalWarnings.toLocaleString()} warnings
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter by field, value, or error..." />
        <div className="flex items-center gap-1">
          {resources.map(r => (
            <FilterPill
              key={r}
              label={r === 'all' ? 'All Resources' : r}
              active={resourceFilter === r}
              onClick={() => setResourceFilter(r)}
            />
          ))}
        </div>
        {errorMessages.length > 2 && (
          <select
            value={messageFilter}
            onChange={e => setMessageFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
          >
            {errorMessages.map(m => (
              <option key={m} value={m}>{m === 'all' ? 'All Error Types' : m}</option>
            ))}
          </select>
        )}
      </div>

      {/* Field-level error cards */}
      <div className="space-y-2">
        {filtered.map((err, i) => (
          <SchemaErrorCard key={`${err.resourceName}-${err.fieldName}-${i}`} err={err} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No errors match the current filters.
        </div>
      )}
    </div>
  );
};

// ── Variations Report ────────────────────────────────────────────────

type VariationTab = 'fields' | 'lookups' | 'resources';
type VariationAction = 'pending' | 'accepted' | 'ignored' | 'fast-track';

const ACTION_COLORS: Readonly<Record<VariationAction, string>> = {
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  accepted: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  'fast-track': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export const VariationsReportView = ({ report }: { readonly report: VariationsReport }) => {
  const [activeTab, setActiveTab] = useState<VariationTab>(
    report.fields.length > 0 ? 'fields' : report.lookups.length > 0 ? 'lookups' : 'resources'
  );
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | VariationAction>('all');
  const [fieldFilter, setFieldFilter] = useState<string>('all');

  const items = activeTab === 'fields' ? report.fields : activeTab === 'lookups' ? report.lookups : report.resources;

  // Unique source fields for filtering
  const sourceFields = useMemo(() => {
    const set = new Set(items.map(v => v.fieldName).filter(Boolean) as ReadonlyArray<string>);
    return ['all', ...Array.from(set).sort()];
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = search.toLowerCase();
    return items.filter(v => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false;
      if (fieldFilter !== 'all' && v.fieldName !== fieldFilter) return false;
      if (query) {
        const searchable = [v.resourceName, v.fieldName, v.lookupValue, v.legacyODataValue, ...v.suggestions.map(s => s.suggestedFieldName ?? s.suggestedLookupValue ?? '')].join(' ').toLowerCase();
        return searchable.includes(query);
      }
      return true;
    });
  }, [items, search, statusFilter, fieldFilter]);

  const counts = {
    fields: report.fields.length,
    lookups: report.lookups.length,
    resources: report.resources.length,
  };

  const statusCounts = useMemo(() => ({
    pending: items.filter(v => !v.status || v.status === 'pending').length,
    accepted: items.filter(v => v.status === 'accepted').length,
    ignored: items.filter(v => v.status === 'ignored').length,
    'fast-track': items.filter(v => v.status === 'fast-track').length,
  }), [items]);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="font-semibold text-amber-600 dark:text-amber-400">
          {counts.fields + counts.lookups + counts.resources} variations found
        </span>
        {statusCounts.pending > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {statusCounts.pending} pending review
          </span>
        )}
        {statusCounts['fast-track'] > 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {statusCounts['fast-track']} fast-tracked
          </span>
        )}
        {statusCounts.ignored > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {statusCounts.ignored} ignored
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1">
        {(['fields', 'lookups', 'resources'] as const).map(tab => (
          <FilterPill
            key={tab}
            label={`${tab.charAt(0).toUpperCase() + tab.slice(1)} (${counts[tab]})`}
            active={activeTab === tab}
            onClick={() => { setActiveTab(tab); setFieldFilter('all'); }}
          />
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <SearchInput value={search} onChange={setSearch} placeholder="Filter variations..." />
        <div className="flex items-center gap-1">
          {(['all', 'pending', 'fast-track', 'ignored'] as const).map(s => (
            <FilterPill
              key={s}
              label={s === 'all' ? 'All' : s === 'fast-track' ? `Fast Track (${statusCounts['fast-track']})` : `${s.charAt(0).toUpperCase() + s.slice(1)} (${statusCounts[s]})`}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            />
          ))}
        </div>
        {sourceFields.length > 2 && (
          <select
            value={fieldFilter}
            onChange={e => setFieldFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
          >
            {sourceFields.map(f => (
              <option key={f} value={f}>{f === 'all' ? 'All Fields' : f}</option>
            ))}
          </select>
        )}
      </div>

      {/* Variation items */}
      <div className="space-y-2">
        {filteredItems.map((v, i) => {
          const isCrossField = v.suggestions.some(s => s.suggestedFieldName && s.suggestedFieldName !== v.fieldName);
          const isMulti = v.suggestions.length > 1;

          return (
            <div key={i} className={`bg-white dark:bg-gray-800/60 border rounded-xl p-4 ${
              v.status === 'ignored' ? 'border-gray-200 dark:border-gray-700 opacity-60' :
              v.status === 'fast-track' ? 'border-amber-200 dark:border-amber-800' :
              'border-gray-200 dark:border-gray-700'
            }`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {/* Source: field + local value */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge label={v.resourceName} color="blue" />
                    {v.fieldName && <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{v.fieldName}</span>}
                    {v.legacyODataValue && (
                      <>
                        <span className="text-gray-400 dark:text-gray-500">·</span>
                        <span className="text-sm font-mono text-red-600 dark:text-red-400">{v.legacyODataValue}</span>
                      </>
                    )}
                    {isCrossField && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">
                        Cross-field
                      </span>
                    )}
                    {isMulti && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                        {v.suggestions.length} options
                      </span>
                    )}
                  </div>

                  {/* Suggestions */}
                  <div className="mt-2 space-y-1.5">
                    {v.suggestions.map((s, si) => {
                      const targetDiffers = s.suggestedFieldName && s.suggestedFieldName !== v.fieldName;
                      return (
                        <div key={si} className="pl-4 flex items-center gap-2 text-sm">
                          <svg className="w-4 h-4 text-green-500 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638l-3.96-4.158a.75.75 0 011.08-1.04l5.25 5.5a.75.75 0 010 1.04l-5.25 5.5a.75.75 0 11-1.08-1.04l3.96-4.158H3.75A.75.75 0 013 10z" clipRule="evenodd" />
                          </svg>
                          {targetDiffers && (
                            <span className="text-purple-600 dark:text-purple-400 font-medium text-xs">
                              {s.suggestedFieldName}
                            </span>
                          )}
                          <span className="text-green-700 dark:text-green-400 font-medium">
                            {s.suggestedLookupValue ?? s.suggestedFieldName ?? s.suggestedResourceName}
                          </span>
                          {s.ddWikiUrl && (
                            <a href={s.ddWikiUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                              DD Wiki
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Action buttons — maps to backend: ignore=true or flaggedForFastTrack=true */}
                <div className="flex items-center gap-1 shrink-0">
                  {(['fast-track', 'ignored'] as const).map(action => (
                    <button
                      key={action}
                      type="button"
                      className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
                        v.status === action
                          ? ACTION_COLORS[action]
                          : 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      {action === 'fast-track' ? 'Fast Track' : 'Ignore'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        {filteredItems.length === 0 && (
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No variations match the current filters.
          </div>
        )}
      </div>
    </div>
  );
};

// ── Generic Error Report ─────────────────────────────────────────────

export const GenericErrorReport = ({ report }: { readonly report: GenericFailureReport }) => (
  <div className="space-y-4">
    <div className="flex items-center gap-3">
      <span className="text-sm font-semibold text-red-600 dark:text-red-400">
        Failed at: {report.failedStep}
      </span>
      <Badge label={report.endorsement} color="blue" />
    </div>

    <div className="space-y-2">
      {report.errors.map((err, i) => (
        <div key={i} className="bg-white dark:bg-gray-800/60 border border-red-200 dark:border-red-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{err.stepName}</span>
            {err.httpStatus && (
              <Badge label={`HTTP ${err.httpStatus}`} color="red" />
            )}
          </div>
          <p className="text-sm text-red-700 dark:text-red-300">{err.message}</p>
          {err.detail && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{err.detail}</p>
          )}
        </div>
      ))}
    </div>
  </div>
);

// ── Error Report Selector ────────────────────────────────────────────

/** Demo component showing all three report types. */
export const ErrorReportDemo = () => {
  const [activeReport, setActiveReport] = useState<'schema' | 'variations' | 'generic'>('schema');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <FilterPill label="Schema Validation" active={activeReport === 'schema'} onClick={() => setActiveReport('schema')} />
        <FilterPill label="Variations" active={activeReport === 'variations'} onClick={() => setActiveReport('variations')} />
        <FilterPill label="Step Failure" active={activeReport === 'generic'} onClick={() => setActiveReport('generic')} />
      </div>

      {activeReport === 'schema' && <SchemaValidationErrorReport report={SAMPLE_SCHEMA_REPORT} />}
      {activeReport === 'variations' && <VariationsReportView report={SAMPLE_VARIATIONS_REPORT} />}
      {activeReport === 'generic' && <GenericErrorReport report={SAMPLE_GENERIC_REPORT} />}
    </div>
  );
};

// ── Failure Report Modal ────────────────────────────────────────────

/**
 * Convert the cert-utils nested schema error format into the flat
 * SchemaError[] format used by SchemaValidationErrorReport.
 *
 * Input:  errors[message].resources[resource].fields[field].lookups[value].count
 * Output: SchemaError[]
 */
const parseRealSchemaErrors = (raw: Record<string, unknown>): SchemaValidationReport => {
  const totalErrors = (raw.totalErrors as number) ?? 0;
  const totalWarnings = (raw.totalWarnings as number) ?? 0;
  const errorsObj = (raw.errors ?? {}) as Record<string, { resources: Record<string, { fields: Record<string, { lookups?: Record<string, { count: number }> }> }> }>;

  const errors: SchemaError[] = [];
  for (const [message, data] of Object.entries(errorsObj)) {
    for (const [resourceName, resourceData] of Object.entries(data.resources ?? {})) {
      for (const [fieldName, fieldData] of Object.entries(resourceData.fields ?? {})) {
        const lookups = fieldData.lookups
          ? Object.entries(fieldData.lookups).map(([lookupValue, lv]) => ({
              lookupValue,
              count: lv.count,
            }))
          : undefined;
        errors.push({ resourceName, fieldName, message, lookups });
      }
    }
  }

  return { type: 'schema-validation', totalErrors, totalWarnings, errors };
};

/**
 * Convert the cert-utils nested variations format into the flat
 * Variation[] format used by VariationsReportView.
 */
const parseRealVariations = (raw: Record<string, unknown>): VariationsReport => {
  const variations = (raw.variations ?? raw) as Record<string, ReadonlyArray<Record<string, unknown>>>;

  const mapVariation = (v: Record<string, unknown>): Variation => ({
    resourceName: (v.resourceName as string) ?? '',
    fieldName: v.fieldName as string | undefined,
    legacyODataValue: v.legacyODataValue as string | undefined,
    suggestions: ((v.suggestions ?? []) as ReadonlyArray<Record<string, unknown>>).map(s => ({
      suggestedResourceName: s.suggestedResourceName as string | undefined,
      suggestedFieldName: s.suggestedFieldName as string | undefined,
      suggestedLookupValue: s.suggestedLookupValue as string | undefined,
      strategy: (s.strategy as VariationSuggestion['strategy']) ?? 'Fast Track',
      ddWikiUrl: s.ddWikiUrl as string | undefined,
    })),
    status: 'pending',
  });

  return {
    type: 'variations',
    description: raw.description as string | undefined,
    version: raw.version as string | undefined,
    generatedOn: raw.generatedOn as string | undefined,
    fuzziness: raw.fuzziness as number | undefined,
    fields: (variations.fields ?? []).map(mapVariation),
    lookups: (variations.lookups ?? []).map(mapVariation),
    resources: (variations.resources ?? []).map(mapVariation),
  };
};

/**
 * Resolve the appropriate error report from real Job.reports data,
 * falling back to fixtures when no real data is available.
 */
const resolveReport = (
  endorsement: string,
  failedStep?: string,
  reports?: Record<string, unknown>,
): ErrorReport => {
  // Use real report data when available
  if (reports) {
    if (reports.schemaErrors) {
      return parseRealSchemaErrors(reports.schemaErrors as Record<string, unknown>);
    }
    if (reports.variations) {
      return parseRealVariations(reports.variations as Record<string, unknown>);
    }
  }

  // Fallback to fixtures for demo
  if (endorsement.includes('Data Dictionary')) {
    if (failedStep?.includes('Schema Validation')) return SAMPLE_SCHEMA_REPORT;
    if (failedStep?.includes('Variations')) return SAMPLE_VARIATIONS_REPORT;
  }

  return {
    type: 'generic',
    endorsement,
    failedStep: failedStep ?? 'Unknown',
    errors: failedStep
      ? [{
          stepName: failedStep,
          message: `The test failed at the "${failedStep}" step. Expand the job details for more information.`,
        }]
      : SAMPLE_GENERIC_REPORT.errors,
  };
};

export const FailureReportModal = ({
  endorsement,
  version,
  recipientName,
  failedStep,
  reports,
  onClose,
}: {
  readonly endorsement: string;
  readonly version: string;
  readonly recipientName: string;
  readonly failedStep?: string;
  readonly reports?: Record<string, unknown>;
  readonly onClose: () => void;
}) => {
  const report = resolveReport(endorsement, failedStep, reports);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Failure Report
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {endorsement} {version} — {recipientName}
              {failedStep && <span className="ml-2 text-red-500 dark:text-red-400">· Failed at: {failedStep}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="p-5 overflow-y-auto">
          {report.type === 'schema-validation' && <SchemaValidationErrorReport report={report} />}
          {report.type === 'variations' && <VariationsReportView report={report} />}
          {report.type === 'generic' && <GenericErrorReport report={report} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
