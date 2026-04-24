/**
 * Cert Error Report renderers — display failure details for each
 * endorsement type and failure category.
 *
 * Supports both legacy report formats (from the cert API) and new
 * formats (from reso-tools local and cloud testing). The report
 * format is always driven by reso-tools regardless of where it runs.
 *
 * TODO: Extract a shared ReportViewer component that handles both
 * passed (compliance report) and failed (failure report) views with
 * consistent expandable step/scenario cards. Currently the compliance
 * report modal is in jobs-page.tsx and the failure renderers are here.
 * Unify into a single component with a shared step card interface.
 */

import { useEffect, useState, useMemo } from 'react';
import { SearchInput, FilterPill, Badge, AvailBar } from '../metadata/shared.js';
import { humanizeScenarioName } from '../../constants/cert';
import { RequestDetailsPanel } from './request-details';
import { DetailText } from './detail-text';
import { useReportRef } from '../../hooks/use-report-ref';

// ── Types ────────────────────────────────────────────────────────────

interface SchemaError {
  readonly resourceName: string;
  readonly fieldName: string;
  readonly message: string;
  readonly lookups?: ReadonlyArray<{ lookupValue: string; count: number }>;
  readonly keyField?: string;
  readonly keys?: ReadonlyArray<string>;
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
  readonly strategy: 'Fast Track' | 'Substring' | 'Edit Distance' | 'Suggestion';
  readonly ddWikiUrl?: string;
}

interface Variation {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: ReadonlyArray<VariationSuggestion>;
  readonly status?: 'pending' | 'accepted' | 'ignored' | 'fast-track';
  readonly message?: string;
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
  readonly expansions?: ReadonlyArray<Variation>;
}

interface StepError {
  readonly stepName: string;
  readonly message: string;
  readonly detail?: string;
  readonly httpStatus?: number;
  readonly requestDetails?: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
    readonly responseBody?: string;
  }>;
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

/** Copy icon button with brief checkmark feedback. */
const CopyButton = ({ text, title }: { readonly text: string; readonly title?: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`cursor-pointer transition-colors ${copied ? 'text-green-500 dark:text-green-400' : 'text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400'}`}
      title={copied ? 'Copied!' : (title ?? 'Copy')}
    >
      {copied ? (
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
          <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
        </svg>
      )}
    </button>
  );
};

/** Expandable field row inside an error group. */
const FieldErrorRow = ({ err }: { readonly err: SchemaError }) => {
  const [expanded, setExpanded] = useState(false);
  const hasLookups = err.lookups && err.lookups.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50/50 dark:hover:bg-gray-700/20 transition-colors">
        <div className="flex items-center gap-2 min-w-0">
          {hasLookups ? (
            <>
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="cursor-pointer flex items-center gap-2"
              >
                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                </svg>
                <Badge label={err.resourceName} color="blue" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{err.fieldName}</span>
              </button>
              <CopyButton text={err.fieldName} title="Copy field name" />
            </>
          ) : (
            <div className="flex items-center gap-2 pl-5">
              <Badge label={err.resourceName} color="blue" />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{err.fieldName}</span>
              <CopyButton text={err.fieldName} title="Copy field name" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasLookups && (
            <Badge label={`${err.lookups!.length} values`} color="gray" />
          )}
        </div>
      </div>

      {expanded && hasLookups && (
        <div className="px-4 pb-3 pl-11">
          <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
            {err.lookups!.map(l => (
              <div key={l.lookupValue} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-700 dark:text-gray-300 font-mono">{l.lookupValue}</span>
                  <CopyButton text={l.lookupValue} title="Copy value" />
                </div>
                <span className="text-gray-400 dark:text-gray-500 tabular-nums">{l.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/** Expandable error group — groups fields by error message. */
const ErrorGroup = ({ message, errors }: { readonly message: string; readonly errors: ReadonlyArray<SchemaError> }) => {
  const [expanded, setExpanded] = useState(true);
  const totalValues = errors.reduce((sum, e) => sum + (e.lookups?.length ?? 0), 0);

  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/30 cursor-pointer hover:bg-red-100/50 dark:hover:bg-red-900/30 transition-colors"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <svg className={`w-4 h-4 text-red-400 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
            <span className="text-sm font-semibold text-red-800 dark:text-red-200 truncate">{message}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge label={`${errors.length} fields`} color="red" />
            {totalValues > 0 && (
              <Badge label={`${totalValues.toLocaleString()} values`} color="gray" />
            )}
            {errors[0]?.keys && errors[0].keys.length > 0 && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  const keys = errors[0].keys ?? [];
                  const keyField = errors[0].keyField ?? 'Key';
                  const csv = [keyField, ...keys].join('\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${message.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-keys.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer font-medium"
              >
                <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                  <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                </svg>
                {errors[0].keys.length.toLocaleString()} keys
              </button>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {errors.map((err, i) => (
            <FieldErrorRow key={`${err.resourceName}-${err.fieldName}-${i}`} err={err} />
          ))}
        </div>
      )}
    </div>
  );
};

export const SchemaValidationErrorReport = ({ report }: { readonly report: SchemaValidationReport }) => {
  const [search, setSearch] = useState('');
  const [resourceFilter, setResourceFilter] = useState<string>('all');

  const resources = useMemo(() => {
    const set = new Set(report.errors.map(e => e.resourceName));
    return ['all', ...Array.from(set).sort()];
  }, [report.errors]);

  // Group by error message, then filter
  const grouped = useMemo(() => {
    const query = search.toLowerCase();
    const filtered = report.errors.filter(e => {
      if (resourceFilter !== 'all' && e.resourceName !== resourceFilter) return false;
      if (query && !e.fieldName.toLowerCase().includes(query) && !e.message.toLowerCase().includes(query)
        && !(e.lookups ?? []).some(l => l.lookupValue.toLowerCase().includes(query))) return false;
      return true;
    });

    const groups = new Map<string, SchemaError[]>();
    for (const err of filtered) {
      const existing = groups.get(err.message);
      if (existing) existing.push(err);
      else groups.set(err.message, [err]);
    }
    return groups;
  }, [report.errors, search, resourceFilter]);

  const totalFilteredFields = Array.from(grouped.values()).reduce((sum, g) => sum + g.length, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-red-600 dark:text-red-400 tabular-nums">
            {totalFilteredFields} {totalFilteredFields === 1 ? 'field' : 'fields'} with errors
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {grouped.size} error {grouped.size === 1 ? 'type' : 'types'}
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
      </div>

      {/* Error groups */}
      <div className="space-y-3">
        {Array.from(grouped.entries()).map(([message, errors]) => (
          <ErrorGroup key={message} message={message} errors={errors} />
        ))}
      </div>

      {grouped.size === 0 && (
        <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No errors match the current filters.
        </div>
      )}
    </div>
  );
};

// ── Variations Report ────────────────────────────────────────────────

type VariationTab = 'fields' | 'lookups' | 'resources' | 'expansions';
type VariationAction = 'pending' | 'accepted' | 'ignored' | 'fast-track';

const ACTION_COLORS: Readonly<Record<VariationAction, string>> = {
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  accepted: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  'fast-track': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export const VariationsReportView = ({ report }: { readonly report: VariationsReport }) => {
  const [activeTab, setActiveTab] = useState<VariationTab>(
    report.fields.length > 0 ? 'fields' : report.lookups.length > 0 ? 'lookups' : (report.expansions?.length ?? 0) > 0 ? 'expansions' : 'resources'
  );
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | VariationAction>('all');
  const [fieldFilter, setFieldFilter] = useState<string>('all');

  const items = activeTab === 'fields' ? report.fields : activeTab === 'lookups' ? report.lookups : activeTab === 'expansions' ? (report.expansions ?? []) : report.resources;

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
    expansions: report.expansions?.length ?? 0,
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
        <span className="text-xs text-gray-400 dark:text-gray-500 italic">
          Read-only preview · open Variations Review to triage
        </span>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1">
        {(['fields', 'lookups', 'resources', 'expansions'] as const).filter(tab => counts[tab] > 0).map(tab => (
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

                  {/* Message */}
                  {v.message && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{v.message}</p>
                  )}

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

                {/* Read-only status badge. Triage happens on the Variations Review page. */}
                <div className="flex items-center gap-1 shrink-0">
                  {v.status && v.status !== 'pending' && (
                    <span className={`px-2 py-1 rounded text-[11px] font-medium ${ACTION_COLORS[v.status]}`}>
                      {v.status === 'fast-track' ? 'Fast Track' : v.status.charAt(0).toUpperCase() + v.status.slice(1)}
                    </span>
                  )}
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

const GenericErrorCard = ({ err }: { readonly err: StepError }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(err.detail);

  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/80 ${hasDetail ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/60' : ''} transition-colors`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasDetail && (
            <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
          )}
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{err.stepName}</span>
          <CopyButton text={`${err.stepName}: ${err.message}`} title="Copy error details" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {err.httpStatus && <Badge label={`HTTP ${err.httpStatus}`} color="red" />}
        </div>
      </button>

      {!expanded && (
        <div className="px-4 pb-3">
          <DetailText text={err.message} className="text-xs text-red-600 dark:text-red-400" />
        </div>
      )}

      {expanded && hasDetail && (
        <div className="px-4 pb-3 border-t border-gray-100 dark:border-gray-700/50 pt-3 space-y-3">
          <DetailText text={err.message} className="text-xs text-red-600 dark:text-red-400" />

          {/* Request details — show the query URL and response */}
          {err.requestDetails && err.requestDetails.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Request</p>
              <RequestDetailsPanel details={err.requestDetails} />
            </div>
          )}

          {/* Assertion details */}
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Assertions</p>
            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
              {err.detail!.split('\n').map((line, i) => {
                const isIndented = line.startsWith('  ');
                return (
                  <div key={i} className={`flex items-start gap-2 text-xs ${isIndented ? 'pl-4' : ''}`}>
                    <span className={isIndented ? 'text-gray-500 dark:text-gray-400 font-mono text-[11px]' : 'text-gray-700 dark:text-gray-300'}>{line}</span>
                    {!isIndented && <CopyButton text={line} title="Copy assertion" />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const GenericErrorReport = ({ report }: { readonly report: GenericFailureReport }) => {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return report.errors;
    const query = search.toLowerCase();
    return report.errors.filter(e =>
      e.stepName.toLowerCase().includes(query) ||
      e.message.toLowerCase().includes(query) ||
      (e.detail ?? '').toLowerCase().includes(query)
    );
  }, [report.errors, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-red-600 dark:text-red-400">
            {report.errors.length} {report.errors.length === 1 ? 'failure' : 'failures'}
          </span>
          <Badge label={report.endorsement} color="blue" />
        </div>
      </div>

      {report.errors.length > 3 && (
        <SearchInput value={search} onChange={setSearch} placeholder="Filter by scenario or error..." />
      )}

      <div className="space-y-2">
        {filtered.map((err, i) => (
          <GenericErrorCard key={i} err={err} />
        ))}
        {filtered.length === 0 && (
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No errors match the current filter.
          </div>
        )}
      </div>
    </div>
  );
};

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
  const errorsObj = (raw.errors ?? {}) as Record<string, {
    resources: Record<string, {
      keyField?: string;
      keys?: ReadonlyArray<string> | Record<string, boolean>;
      fields: Record<string, { lookups?: Record<string, { count: number }> }>;
    }>;
  }>;

  const errors: SchemaError[] = [];
  for (const [message, data] of Object.entries(errorsObj)) {
    for (const [resourceName, resourceData] of Object.entries(data.resources ?? {})) {
      const keyField = resourceData.keyField;
      const keys = Array.isArray(resourceData.keys)
        ? resourceData.keys
        : resourceData.keys
        ? Object.keys(resourceData.keys)
        : undefined;

      for (const [fieldName, fieldData] of Object.entries(resourceData.fields ?? {})) {
        const lookups = fieldData.lookups
          ? Object.entries(fieldData.lookups).map(([lookupValue, lv]) => ({
              lookupValue,
              count: lv.count,
            }))
          : undefined;
        errors.push({ resourceName, fieldName, message, lookups, keyField, keys });
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
    // The pipeline puts suggestion data at the top level of each variation,
    // not nested in a suggestions array. Map it accordingly.
    suggestions: v.suggestions
      ? ((v.suggestions as ReadonlyArray<Record<string, unknown>>).map(s => ({
          suggestedResourceName: s.suggestedResourceName as string | undefined,
          suggestedFieldName: s.suggestedFieldName as string | undefined,
          suggestedLookupValue: s.suggestedLookupValue as string | undefined,
          strategy: (s.strategy as VariationSuggestion['strategy']) ?? 'Suggestion',
          ddWikiUrl: s.ddWikiUrl as string | undefined,
        })))
      : [{
          suggestedResourceName: v.suggestedResourceName as string | undefined,
          suggestedFieldName: v.suggestedFieldName as string | undefined ?? v.fieldName as string | undefined,
          suggestedLookupValue: v.suggestedLookupValue as string | undefined,
          strategy: (v.strategy as VariationSuggestion['strategy']) ?? 'Suggestion',
          ddWikiUrl: v.ddWikiUrl as string | undefined,
        }],
    status: 'pending',
    message: v.message as string | undefined,
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
    expansions: (variations.expansions ?? []).map(mapVariation),
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
  steps?: ReadonlyArray<{ name: string; status: string; detail?: string; summary?: string; errors?: ReadonlyArray<string>; requestDetails?: ReadonlyArray<{ method: string; url: string; status?: number; error?: string; responseBody?: string }> }>,
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

  // Use detailed report for Core/Add-Edit/EntityEvent when available
  if (reports?.reportDetailed) {
    const detailed = reports.reportDetailed as Record<string, unknown>;
    const rawResourceReports = (detailed.resourceReports ?? []) as ReadonlyArray<Record<string, unknown>>;

    // Normalize scenario shapes — Core uses name/passed/assertions[{message,passed}],
    // Add/Edit uses scenario/passed/assertions[{description,status}],
    // EE uses scenario/passed/assertions[{description,status}]
    const normalizeAssertion = (a: Record<string, unknown>): { description: string; passed: boolean; expected?: string; actual?: string } => ({
      description: (a.description ?? a.message ?? '') as string,
      passed: a.passed === true || a.status === 'pass',
      expected: a.expected as string | undefined,
      actual: a.actual as string | undefined,
    });

    const normalizeScenario = (s: Record<string, unknown>): { name: string; passed: boolean; skipped: boolean; assertions: ReadonlyArray<ReturnType<typeof normalizeAssertion>> } => ({
      name: ((s.name ?? s.scenario) as string) ?? 'Unknown',
      passed: s.passed === true,
      skipped: s.skipped === true,
      assertions: ((s.assertions ?? []) as ReadonlyArray<Record<string, unknown>>).map(normalizeAssertion),
    });

    // Extract all failed scenarios across all resources
    const failedScenarios: ReadonlyArray<StepError> = rawResourceReports.flatMap(r => {
      const resource = (r.resource as string) ?? '';
      const scenarios = ((r.scenarios ?? []) as ReadonlyArray<Record<string, unknown>>).map(normalizeScenario);

      return scenarios
        .filter(s => !s.passed && !s.skipped)
        .map(s => {
          const raw = ((r.scenarios ?? []) as ReadonlyArray<Record<string, unknown>>).find(
            rs => (rs.name ?? rs.scenario) === (s.name)
          );
          const requestUrl = (raw?.requestUrl as string) ?? undefined;
          const responseBody = (raw?.responseBody as string) ?? undefined;
          const failedAssertions = s.assertions.filter(a => !a.passed);
          const failCount = failedAssertions.length;

          // Human-friendly summary for collapsed view
          const summary = failCount > 0
            ? `${failCount} assertion${failCount !== 1 ? 's' : ''} failed — ${failedAssertions.slice(0, 2).map(a => a.description).filter(Boolean).join(', ')}${failCount > 2 ? ` and ${failCount - 2} more` : ''}`
            : `Scenario "${s.name}" failed`;

          // Detailed view: each assertion on its own line with expected/actual when available
          const detailLines = failedAssertions.map(a => {
            const parts = [a.description];
            if (a.expected) parts.push(`  Expected: ${a.expected}`);
            if (a.actual) parts.push(`  Actual: ${a.actual}`);
            return parts.join('\n');
          });

          return {
            stepName: `${resource}: ${humanizeScenarioName(s.name)}`,
            message: summary,
            detail: detailLines.length > 0 ? detailLines.join('\n\n') : undefined,
            httpStatus: undefined,
            requestDetails: requestUrl ? [{ method: 'GET', url: requestUrl, responseBody }] : undefined,
          };
        });
    });

    if (failedScenarios.length > 0) {
      const detailedSteps = (detailed.steps ?? []) as ReadonlyArray<Record<string, unknown>>;
      const summaryStep = detailedSteps.find(s => s.status === 'failed');
      return {
        type: 'generic',
        endorsement,
        failedStep: (summaryStep?.name as string) ?? failedStep ?? 'Test Scenarios',
        errors: failedScenarios,
      };
    }
  }

  // Build generic report from step data when available
  if (steps && steps.length > 0) {
    const failedSteps = steps.filter(s => s.status === 'failed');
    if (failedSteps.length > 0) {
      return {
        type: 'generic',
        endorsement,
        failedStep: failedSteps[0].name,
        errors: failedSteps.map(s => {
          const message = s.detail ?? s.errors?.join('; ') ?? `Step "${s.name}" failed`;

          // Add guidance for common DD failure modes
          const guidance = s.name.includes('metadata')
            ? 'Check that the server returns well-formed OData 4.0 CSDL XML at the $metadata endpoint.'
            : s.name.includes('Service check')
            ? 'Verify the server URL is correct, the server is running, and authentication succeeded.'
            : s.name.includes('authentication') || s.name.includes('auth')
            ? 'Verify the auth token or client credentials are correct and not expired.'
            : undefined;

          // Include individual errors (e.g., semantic validation details)
          const individualErrors = s.errors ?? [];
          const errorDetails = individualErrors.length > 0
            ? individualErrors.join('\n')
            : undefined;

          return {
            stepName: s.name,
            message,
            detail: [s.summary, errorDetails, guidance].filter(Boolean).join('\n'),
            requestDetails: s.requestDetails,
          };
        }),
      };
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

// ── Scenario display names ──────────────────────────────────────────

/** Humanize kebab-case scenario tags into readable names. */
// humanizeScenarioName imported from constants/cert.ts

// ── Spec links by endorsement ───────────────────────────────────────

const SPEC_LINKS: Readonly<Record<string, { label: string; url: string }>> = {
  'Data Dictionary': { label: 'Data Dictionary Specification', url: 'https://dd.reso.org' },
  'Web API Core': { label: 'Web API Core Specification', url: 'https://transport.reso.org/proposals/web-api-core' },
  'Web API Add/Edit': { label: 'Web API Add/Edit Specification', url: 'https://transport.reso.org/proposals/web-api-add-edit' },
  'EntityEvent': { label: 'EntityEvent Specification', url: 'https://transport.reso.org/proposals/entity-event' },
};

const getSpecLink = (endorsement: string): { label: string; url: string } | undefined =>
  Object.entries(SPEC_LINKS).find(([key]) => endorsement.includes(key))?.[1];

export const FailureReportModal = ({
  endorsement,
  version,
  recipientName,
  failedStep,
  reports,
  steps,
  onClose,
  onReviewVariations,
}: {
  readonly endorsement: string;
  readonly version: string;
  readonly recipientName: string;
  readonly failedStep?: string;
  /** Map of reportKey → reference (absolute filesystem path or HTTPS URL). */
  readonly reports?: Record<string, string>;
  readonly steps?: ReadonlyArray<{ name: string; status: string; detail?: string; summary?: string; errors?: ReadonlyArray<string>; requestDetails?: ReadonlyArray<{ method: string; url: string; status?: number; error?: string; responseBody?: string }>; artifacts?: ReadonlyArray<{ label: string; path: string }> }>;
  readonly onClose: () => void;
  /** Optional handler to jump to the full Variations Review page. When provided and the report is a variations report, a button appears in the footer. */
  readonly onReviewVariations?: () => void;
}) => {
  // Resolve each ref the resolver might consume. Hooks run unconditionally per the rules;
  // undefined refs are no-ops in useReportRef.
  const schemaErrors = useReportRef<Record<string, unknown>>(reports?.schemaErrors);
  const variations = useReportRef<Record<string, unknown>>(reports?.variations);
  const reportDetailed = useReportRef<Record<string, unknown>>(reports?.reportDetailed);

  const anyLoading = schemaErrors.loading || variations.loading || reportDetailed.loading;
  const anyMissing = schemaErrors.missing || variations.missing || reportDetailed.missing;
  const anyError = (!schemaErrors.missing && schemaErrors.error)
                || (!variations.missing && variations.error)
                || (!reportDetailed.missing && reportDetailed.error);

  const resolvedReports = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (schemaErrors.data) out.schemaErrors = schemaErrors.data;
    if (variations.data) out.variations = variations.data;
    if (reportDetailed.data) out.reportDetailed = reportDetailed.data;
    return out;
  }, [schemaErrors.data, variations.data, reportDetailed.data]);

  const report = resolveReport(endorsement, failedStep, resolvedReports, steps);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
            {(() => {
              const spec = getSpecLink(endorsement);
              return spec ? (
                <a href={spec.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline mt-1">
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z" />
                    <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 005.656 5.656l3-3a4 4 0 00-.225-5.865z" />
                  </svg>
                  {spec.label}
                </a>
              ) : null;
            })()}
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
          {anyLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-6">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
              Loading report data...
            </div>
          )}
          {anyMissing && !anyLoading && (
            <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300">
              One or more report files are missing from disk. They may have been deleted outside the app. Re-run the job to regenerate them.
            </div>
          )}
          {anyError && !anyLoading && !anyMissing && (
            <div className="p-4 rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300">
              Failed to load report data: {anyError.message}
            </div>
          )}
          {!anyLoading && !anyMissing && !anyError && (
            <>
              {report.type === 'schema-validation' && <SchemaValidationErrorReport report={report} />}
              {report.type === 'variations' && <VariationsReportView report={report} />}
              {report.type === 'generic' && <GenericErrorReport report={report} />}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            {Object.keys(resolvedReports).length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(resolvedReports, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${endorsement.toLowerCase().replace(/\s+/g, '-')}-${version}-errors.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                  <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                </svg>
                Download Results
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onReviewVariations && report.type === 'variations' && (
              <button
                type="button"
                onClick={() => { onClose(); onReviewVariations(); }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 cursor-pointer transition-colors"
              >
                Open in Variations Review
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638l-3.96-4.158a.75.75 0 011.08-1.04l5.25 5.5a.75.75 0 010 1.04l-5.25 5.5a.75.75 0 11-1.08-1.04l3.96-4.158H3.75A.75.75 0 013 10z" clipRule="evenodd" />
                </svg>
              </button>
            )}
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
    </div>
  );
};
