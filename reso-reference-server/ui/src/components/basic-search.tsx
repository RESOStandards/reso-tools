import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResoField, ResoLookup } from '../types';
import { isEnumType, isNumericEdmType } from '../types';
import { getDisplayName } from '../utils/format';

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
  readonly inputType: 'text' | 'number' | 'enum';
  /** Placeholder text. */
  readonly placeholder?: string;
}

/** Per-resource basic search field definitions for well-known RESO resources. */
const RESOURCE_SEARCH_FIELDS: Readonly<Record<string, ReadonlyArray<BasicSearchFieldDef>>> = {
  Property: [
    { id: 'City', fieldName: 'City', label: 'City', operator: 'contains', inputType: 'text', placeholder: 'e.g. Denver' },
    { id: 'PostalCode', fieldName: 'PostalCode', label: 'Zip Code', operator: 'eq', inputType: 'text', placeholder: 'e.g. 80202' },
    { id: 'ListPrice_ge', fieldName: 'ListPrice', label: 'Min Price', operator: 'ge', inputType: 'number', placeholder: '0' },
    { id: 'ListPrice_le', fieldName: 'ListPrice', label: 'Max Price', operator: 'le', inputType: 'number', placeholder: 'Any' },
    { id: 'StandardStatus', fieldName: 'StandardStatus', label: 'Status', operator: 'eq', inputType: 'enum' },
    { id: 'PropertyType', fieldName: 'PropertyType', label: 'Type', operator: 'eq', inputType: 'enum' },
    { id: 'BedroomsTotal_ge', fieldName: 'BedroomsTotal', label: 'Min Beds', operator: 'ge', inputType: 'number', placeholder: '0' }
  ],
  Member: [
    { id: 'MemberFirstName', fieldName: 'MemberFirstName', label: 'First Name', operator: 'contains', inputType: 'text', placeholder: 'First name' },
    { id: 'MemberLastName', fieldName: 'MemberLastName', label: 'Last Name', operator: 'contains', inputType: 'text', placeholder: 'Last name' },
    { id: 'MemberEmail', fieldName: 'MemberEmail', label: 'Email', operator: 'contains', inputType: 'text', placeholder: 'Email' },
    { id: 'MemberStatus', fieldName: 'MemberStatus', label: 'Status', operator: 'eq', inputType: 'enum' }
  ],
  Office: [
    { id: 'OfficeName', fieldName: 'OfficeName', label: 'Office Name', operator: 'contains', inputType: 'text', placeholder: 'Office name' },
    { id: 'OfficeCity', fieldName: 'OfficeCity', label: 'City', operator: 'contains', inputType: 'text', placeholder: 'City' },
    { id: 'OfficeStatus', fieldName: 'OfficeStatus', label: 'Status', operator: 'eq', inputType: 'enum' }
  ],
  OpenHouse: [
    { id: 'City', fieldName: 'City', label: 'City', operator: 'contains', inputType: 'text', placeholder: 'City' },
    { id: 'OpenHouseDate_ge', fieldName: 'OpenHouseDate', label: 'From Date', operator: 'ge', inputType: 'text', placeholder: 'YYYY-MM-DD' },
    { id: 'OpenHouseDate_le', fieldName: 'OpenHouseDate', label: 'To Date', operator: 'le', inputType: 'text', placeholder: 'YYYY-MM-DD' }
  ],
  Teams: [
    { id: 'TeamName', fieldName: 'TeamName', label: 'Team Name', operator: 'contains', inputType: 'text', placeholder: 'Team name' },
    { id: 'TeamStatus', fieldName: 'TeamStatus', label: 'Status', operator: 'eq', inputType: 'enum' }
  ]
};

/** Maximum number of auto-derived fields for unknown resources. */
const MAX_AUTO_FIELDS = 5;

/**
 * Auto-derive basic search fields from metadata for resources without
 * a hardcoded config. Picks the first few string, numeric, and enum fields.
 */
const deriveSearchFields = (fields: ReadonlyArray<ResoField>): ReadonlyArray<BasicSearchFieldDef> => {
  const result: BasicSearchFieldDef[] = [];
  const searchable = fields.filter(f => !f.isExpansion && !f.isCollection);

  for (const field of searchable) {
    if (result.length >= MAX_AUTO_FIELDS) break;

    if (field.type === 'Edm.String') {
      result.push({
        id: field.fieldName,
        fieldName: field.fieldName,
        label: getDisplayName(field),
        operator: 'contains',
        inputType: 'text',
        placeholder: getDisplayName(field)
      });
    } else if (isNumericEdmType(field.type)) {
      result.push({
        id: field.fieldName,
        fieldName: field.fieldName,
        label: getDisplayName(field),
        operator: 'ge',
        inputType: 'number',
        placeholder: '0'
      });
    } else if (isEnumType(field.type)) {
      result.push({
        id: field.fieldName,
        fieldName: field.fieldName,
        label: getDisplayName(field),
        operator: 'eq',
        inputType: 'enum'
      });
    }
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

    if (sf.operator === 'contains') {
      const escaped = raw.replace(/'/g, "''");
      parts.push(`contains(${sf.fieldName},'${escaped}')`);
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
        // Date or other orderable string types
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
  readonly lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>;
  readonly filterString: string;
  readonly onFilterChange: (filter: string) => void;
  readonly onSearch: () => void;
  readonly onShowOData: () => void;
}

/** Basic search bar with resource-specific fields for common search use cases. */
export const BasicSearch = ({
  resource,
  fields,
  lookups,
  filterString,
  onFilterChange,
  onSearch,
  onShowOData
}: BasicSearchProps) => {
  // Resolve and filter search fields for the active resource
  const activeFields = useMemo(() => {
    const defs = RESOURCE_SEARCH_FIELDS[resource] ?? deriveSearchFields(fields);
    const fieldNameSet = new Set(fields.map(f => f.fieldName));
    return defs.filter(sf => fieldNameSet.has(sf.fieldName));
  }, [resource, fields]);

  const [values, setValues] = useState<Record<string, string>>({});
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

  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const hasActiveFilters = Object.values(values).some(v => v.trim());

  if (activeFields.length === 0) {
    return (
      <div className="flex gap-2 items-center">
        <span className="text-sm text-gray-500 dark:text-gray-400">No searchable fields configured for this resource.</span>
        <button
          type="button"
          onClick={onShowOData}
          className="px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">
          Edit OData Filter
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-wrap gap-2 items-end">
        {activeFields.map(sf => {
          const field = fieldMap.get(sf.fieldName);
          const fieldLookups = field && isEnumType(field.type) ? lookups[field.type] : undefined;

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
                  type={sf.inputType === 'number' ? 'text' : 'text'}
                  inputMode={sf.inputType === 'number' ? 'numeric' : 'text'}
                  value={values[sf.id] ?? ''}
                  onChange={e => handleFieldChange(sf.id, e.target.value)}
                  placeholder={sf.placeholder ?? ''}
                  className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-28"
                />
              )}
            </div>
          );
        })}

        {/* Action buttons */}
        <div className="flex gap-2 items-end pb-px">
          <button
            type="submit"
            className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 whitespace-nowrap">
            Search
          </button>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleClear}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 whitespace-nowrap">
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onShowOData}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            title="Edit OData filter expression">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Show active filter expression when non-empty */}
      {filterString && (
        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono truncate" title={filterString}>
          $filter={filterString}
        </div>
      )}
    </form>
  );
};
