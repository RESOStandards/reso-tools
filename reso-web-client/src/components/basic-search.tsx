import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseFilter, type FilterExpression } from '@reso-standards/odata-expression-parser';
import type { ResoField } from '../types';
import { isEnumType, isNumericEdmType } from '../types';
import { getDisplayName } from '../utils/format';
import { getLookupName, useLookups } from '../hooks/use-lookups';

/** Count top-level filter conditions from a parsed AST. */
const countConditions = (expr: FilterExpression): number => {
  if (expr.type === 'logical' && expr.operator === 'and') {
    return countConditions(expr.left) + countConditions(expr.right);
  }
  return 1;
};

/** Try to count filter conditions from a filter string. Returns 0 on parse error. */
const getFilterCount = (filterString: string): number => {
  if (!filterString.trim()) return 0;
  try {
    return countConditions(parseFilter(filterString));
  } catch {
    return 0;
  }
};

/** Definition of a single field in the basic search bar. */
interface BasicSearchFieldDef {
  /** Unique key for this search slot (e.g., 'City' or 'ListPrice_ge'). */
  readonly id: string;
  /** The OData field name this maps to. */
  readonly fieldName: string;
  /** Display label shown above the input. */
  readonly label: string;
  /** OData operator to use when building the filter. */
  readonly operator: 'contains' | 'eq' | 'ge' | 'le' | 'gt' | 'lt';
  /** Input type hint. */
  readonly inputType: 'text' | 'number' | 'enum' | 'date';
  /** Placeholder text. */
  readonly placeholder?: string;
}

/** Fields to skip in basic search — keys and system tracking fields aren't useful for filtering. */
const SKIP_PATTERNS = [/Key$/, /SystemID$/, /SystemName$/];

/** Maximum number of fields to show in basic search. */
const MAX_SEARCH_FIELDS = 7;

/**
 * Build search field definitions from a ranked list of field names (from analytics data)
 * matched against the server's actual metadata. Determines input type from field metadata.
 *
 * ModificationTimestamp is always included (if available) since it's the most common
 * way to filter for recently changed records.
 */
export const buildSearchFields = (
  rankedNames: ReadonlyArray<string>,
  fields: ReadonlyArray<ResoField>
): ReadonlyArray<BasicSearchFieldDef> => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const result: BasicSearchFieldDef[] = [];
  const added = new Set<string>();

  const addField = (name: string): boolean => {
    if (added.has(name)) return false;
    if (SKIP_PATTERNS.some(p => p.test(name))) return false;

    const field = fieldMap.get(name);
    if (!field || field.isExpansion || field.isCollection) return false;

    const label = getDisplayName(field);
    added.add(name);

    if (field.lookupName || isEnumType(field.type)) {
      result.push({ id: name, fieldName: name, label, operator: 'eq', inputType: 'enum' });
    } else if (field.type === 'Edm.String') {
      result.push({ id: name, fieldName: name, label, operator: 'contains', inputType: 'text', placeholder: label });
    } else if (field.type === 'Edm.DateTimeOffset' || field.type === 'Edm.Date') {
      result.push({ id: `${name}_ge`, fieldName: name, label: `${label} (since)`, operator: 'ge', inputType: 'date' });
    } else if (isNumericEdmType(field.type)) {
      result.push({ id: name, fieldName: name, label, operator: 'ge', inputType: 'number', placeholder: '0' });
    } else {
      return false;
    }
    return true;
  };

  // Add ranked fields from analytics data
  for (const name of rankedNames) {
    if (result.length >= MAX_SEARCH_FIELDS) break;
    addField(name);
  }

  // Always include ModificationTimestamp if the server has it
  if (!added.has('ModificationTimestamp') && fieldMap.has('ModificationTimestamp')) {
    addField('ModificationTimestamp');
  }

  return result;
};

/** Build an OData $filter string from basic search field values. */
const buildBasicFilter = (
  searchFields: ReadonlyArray<BasicSearchFieldDef>,
  values: Readonly<Record<string, string>>,
  fields: ReadonlyArray<ResoField>
): string => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const parts: string[] = [];

  for (const sf of searchFields) {
    const raw = values[sf.id]?.trim();
    if (!raw) continue;

    const field = fieldMap.get(sf.fieldName);
    const isString = field ? (field.type === 'Edm.String' || isEnumType(field.type)) : true;
    const isNumeric = field ? isNumericEdmType(field.type) : false;
    const isDate = field ? (field.type === 'Edm.DateTimeOffset' || field.type === 'Edm.Date') : false;

    if (sf.operator === 'contains') {
      const escaped = raw.replace(/'/g, "''");
      parts.push(`contains(${sf.fieldName},'${escaped}')`);
    } else if (isDate) {
      // Date picker gives YYYY-MM-DD; DateTimeOffset needs full timestamp
      const timestamp = field?.type === 'Edm.DateTimeOffset' ? `${raw}T00:00:00Z` : raw;
      parts.push(`${sf.fieldName} ${sf.operator} ${timestamp}`);
    } else if (sf.operator === 'eq') {
      if (isNumeric) {
        parts.push(`${sf.fieldName} eq ${raw}`);
      } else {
        const escaped = raw.replace(/'/g, "''");
        parts.push(`${sf.fieldName} eq '${escaped}'`);
      }
    } else {
      // ge, le, gt, lt
      if (isNumeric) {
        parts.push(`${sf.fieldName} ${sf.operator} ${raw}`);
      } else {
        const escaped = raw.replace(/'/g, "''");
        parts.push(`${sf.fieldName} ${sf.operator} '${escaped}'`);
      }
    }
  }

  return parts.join(' and ');
};

/**
 * Best-effort parse of an existing OData $filter back into basic search values.
 * Only handles simple AND-joined clauses that match the basic field definitions.
 */
const parseBasicFilter = (
  filterString: string,
  searchFields: ReadonlyArray<BasicSearchFieldDef>
): Record<string, string> => {
  const values: Record<string, string> = {};
  if (!filterString.trim()) return values;

  // Simple regex-based extraction for common patterns
  const clauses = filterString.split(/\s+and\s+/i);

  for (const clause of clauses) {
    const trimmed = clause.trim();

    // contains(FieldName,'value')
    const containsMatch = trimmed.match(/^contains\((\w+),\s*'(.*)'\)$/);
    if (containsMatch) {
      const [, fieldName, value] = containsMatch;
      const sf = searchFields.find(s => s.fieldName === fieldName && s.operator === 'contains');
      if (sf) values[sf.id] = value.replace(/''/g, "'");
      continue;
    }

    // FieldName op 'value' or FieldName op number
    const compMatch = trimmed.match(/^(\w+)\s+(eq|ne|gt|ge|lt|le)\s+(?:'(.*)'|(\d+(?:\.\d+)?))$/);
    if (compMatch) {
      const [, fieldName, operator, strVal, numVal] = compMatch;
      const val = strVal ?? numVal;
      const sf = searchFields.find(s => s.fieldName === fieldName && s.operator === operator);
      if (sf && val !== undefined) values[sf.id] = val.replace(/''/g, "'");
    }
  }

  return values;
};

interface BasicSearchProps {
  readonly resource: string;
  readonly fields: ReadonlyArray<ResoField>;
  /** Whether field metadata is still loading. */
  readonly isLoadingFields?: boolean;
  /** Ranked field names from analytics data (summary-fields.json). */
  readonly rankedFieldNames?: ReadonlyArray<string>;
  readonly filterString: string;
  readonly onFilterChange: (filter: string) => void;
  readonly onSearch: () => void;
  readonly onShowOData: () => void;
}

/** Basic search bar with fields derived from analytics data and server metadata. */
export const BasicSearch = ({
  resource,
  fields,
  isLoadingFields = false,
  rankedFieldNames,
  filterString,
  onFilterChange,
  onSearch,
  onShowOData
}: BasicSearchProps) => {
  // Build search fields from analytics-ranked names matched against server metadata.
  // Falls back to server field order if no analytics data available.
  const activeFields = useMemo(() => {
    const ranked = rankedFieldNames ?? fields.map(f => f.fieldName);
    return buildSearchFields(ranked, fields);
  }, [fields, rankedFieldNames]);

  // Lazy-fetch lookups for only the enum fields in the search bar
  const { lookups, fetchLookups } = useLookups();
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));

  useEffect(() => {
    const enumLookupNames = activeFields
      .filter(sf => sf.inputType === 'enum')
      .map(sf => {
        const f = fieldMap.get(sf.fieldName);
        return f ? getLookupName(f) : undefined;
      })
      .filter((name): name is string => !!name);
    if (enumLookupNames.length > 0) fetchLookups(enumLookupNames);
  }, [activeFields]); // eslint-disable-line react-hooks/exhaustive-deps

  const [values, setValues] = useState<Record<string, string>>({});
  const [showRawFilter, setShowRawFilter] = useState(false);
  const [filterCopied, setFilterCopied] = useState(false);
  const lastEmittedRef = useRef('');

  // Sync from incoming filter string (e.g., URL change, browser back)
  useEffect(() => {
    if (filterString === lastEmittedRef.current) return;
    const parsed = parseBasicFilter(filterString, activeFields);
    setValues(parsed);
  }, [filterString, activeFields]);

  const handleFieldChange = useCallback(
    (id: string, value: string) => {
      setValues(prev => {
        const next = { ...prev, [id]: value };
        const newFilter = buildBasicFilter(activeFields, next, fields);
        lastEmittedRef.current = newFilter;
        onFilterChange(newFilter);
        return next;
      });
    },
    [activeFields, fields, onFilterChange]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSearch();
  };

  const handleClear = useCallback(() => {
    setValues({});
    lastEmittedRef.current = '';
    onFilterChange('');
    onSearch();
  }, [onFilterChange, onSearch]);

  const hasActiveFilters = Object.values(values).some(v => v.trim());

  // Fields still loading — show inline loading indicator
  if (isLoadingFields) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-1.5">
        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <title>Loading</title>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading {resource} metadata...
      </div>
    );
  }

  // Fields loaded but no searchable fields match this server — show Filters button only
  if (activeFields.length === 0) {
    return (
      <button
        type="button"
        onClick={onShowOData}
        className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer flex items-center gap-1.5">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.681a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" />
        </svg>
        Filters
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {showRawFilter ? (
        /* Raw OData filter editor */
        <div className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <input
              type="text"
              value={filterString}
              onChange={e => onFilterChange(e.target.value)}
              placeholder="$filter expression (e.g., City eq 'Denver')"
              className="w-full px-3 py-1.5 pr-8 border border-gray-300 dark:border-gray-600 rounded text-sm font-mono bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(filterString);
                setFilterCopied(true);
                setTimeout(() => setFilterCopied(false), 1500);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              title={filterCopied ? 'Copied!' : 'Copy filter'}>
              {filterCopied ? (
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
          </div>
          <button
            type="submit"
            className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 whitespace-nowrap cursor-pointer">
            Search
          </button>
          <button
            type="button"
            onClick={() => setShowRawFilter(false)}
            className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer whitespace-nowrap">
            Done
          </button>
        </div>
      ) : (
        /* Basic search fields */
        <div className="flex flex-wrap gap-2 items-end">
          {activeFields.map(sf => {
            const field = fieldMap.get(sf.fieldName);
            const lkName = field ? getLookupName(field) : undefined;
            const fieldLookups = lkName ? lookups[lkName] : undefined;

            return (
              <div key={sf.id} className="flex flex-col gap-0.5 min-w-0">
                <label htmlFor={`basic-${sf.id}`} className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate">
                  {sf.label}
                </label>
                {sf.inputType === 'enum' && fieldLookups && fieldLookups.length > 0 ? (
                  <select
                    id={`basic-${sf.id}`}
                    value={values[sf.id] ?? ''}
                    onChange={e => handleFieldChange(sf.id, e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-36">
                    <option value="">Any</option>
                    {fieldLookups.map(l => (
                      <option key={l.lookupValue} value={l.lookupValue}>
                        {l.lookupValue}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`basic-${sf.id}`}
                    type={sf.inputType === 'date' ? 'date' : 'text'}
                    inputMode={sf.inputType === 'number' ? 'numeric' : undefined}
                    value={values[sf.id] ?? ''}
                    onChange={e => handleFieldChange(sf.id, e.target.value)}
                    placeholder={sf.placeholder ?? ''}
                    className={`px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${sf.inputType === 'date' ? 'w-full dark:[color-scheme:dark]' : 'w-28'}`}
                  />
                )}
              </div>
            );
          })}

          {/* Action buttons */}
          <div className="flex gap-2 items-end pb-px">
            <button
              type="submit"
              className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 whitespace-nowrap cursor-pointer">
              Search
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClear}
                className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 whitespace-nowrap cursor-pointer">
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onShowOData}
              className={`px-3 py-1.5 text-sm rounded border cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                filterString
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              title="Advanced search filters">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.681a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" />
              </svg>
              Filters
              {(() => {
                const count = getFilterCount(filterString);
                if (count > 0) return <span className="ml-1 px-1.5 py-0.5 bg-blue-600 text-white text-xs rounded-full">{count}</span>;
                if (filterString) return <span className="ml-1 w-2 h-2 bg-yellow-500 rounded-full inline-block" title="Filter could not be parsed" />;
                return null;
              })()}
            </button>
            {filterString && (
              <button
                type="button"
                onClick={handleClear}
                className="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 cursor-pointer"
                title="Clear all filters">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <title>Clear filters</title>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowRawFilter(true)}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              title="Edit OData filter">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </form>
  );
};
