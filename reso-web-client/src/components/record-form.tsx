import { type ValidationFailure, validateRecord } from '@reso-standards/validation';
import { type FormEvent, useCallback, useMemo, useRef, useState } from 'react';
import { useServer } from '../context/server-context';
import type { FieldGroups, ResoField, ResoLookup } from '../types';
import { FieldGroupSection } from './field-group-section';
import { FieldInput } from './field-input';

interface RecordFormProps {
  readonly resource: string;
  readonly fields: ReadonlyArray<ResoField>;
  readonly lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>;
  readonly fieldGroups: FieldGroups | null;
  readonly initialValues?: Record<string, unknown>;
  readonly isEdit?: boolean;
  readonly onSubmit: (values: Record<string, unknown>) => Promise<void>;
  readonly isLoading: boolean;
}

/** Groups fields into sections based on RESO Data Dictionary field groups. */
const groupFields = (
  fields: ReadonlyArray<ResoField>,
  resource: string,
  fieldGroups: FieldGroups | null,
  excludeFields: ReadonlySet<string>
): { grouped: Map<string, ResoField[]>; ungrouped: ResoField[] } => {
  const grouped = new Map<string, ResoField[]>();
  const ungrouped: ResoField[] = [];
  const resourceGroups = fieldGroups?.[resource] ?? {};

  for (const field of fields) {
    if (excludeFields.has(field.fieldName)) continue;

    const groups = resourceGroups[field.fieldName];
    if (groups && groups.length > 0) {
      // Use the primary group (first element) as the section key
      const groupKey = groups[0];
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.push(field);
      } else {
        grouped.set(groupKey, [field]);
      }
    } else {
      ungrouped.push(field);
    }
  }

  // Sort fields within each group alphabetically
  for (const fields of grouped.values()) {
    fields.sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  }
  ungrouped.sort((a, b) => a.fieldName.localeCompare(b.fieldName));

  return { grouped, ungrouped };
};

/** Dynamic form for creating/editing a RESO record. Fields are grouped by Data Dictionary categories. */
export const RecordForm = ({
  resource,
  fields,
  lookups,
  fieldGroups,
  initialValues,
  isEdit = false,
  onSubmit,
  isLoading
}: RecordFormProps) => {
  const [values, setValues] = useState<Record<string, unknown>>(initialValues ?? {});
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [errorNavIndex, setErrorNavIndex] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const { getKeyField } = useServer();
  const keyField = getKeyField(resource);
  const excludeFields = new Set(['ModificationTimestamp', ...(isEdit ? [] : [keyField])]);
  const { grouped, ungrouped } = groupFields(fields, resource, fieldGroups, excludeFields);

  // Ordered list of field names with errors (stable across renders)
  const errorFields = useMemo(() => [...errors.keys()], [errors]);

  const scrollToError = useCallback((index: number) => {
    const fieldName = errorFields[index];
    if (!fieldName || !formRef.current) return;
    const el = formRef.current.querySelector(`[id="field-${fieldName}"]`)
      ?? formRef.current.querySelector(`[data-field="${fieldName}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el instanceof HTMLElement) el.focus();
    }
  }, [errorFields]);

  const handlePrevError = useCallback(() => {
    const next = errorNavIndex > 0 ? errorNavIndex - 1 : errorFields.length - 1;
    setErrorNavIndex(next);
    scrollToError(next);
  }, [errorNavIndex, errorFields.length, scrollToError]);

  const handleNextError = useCallback(() => {
    const next = errorNavIndex < errorFields.length - 1 ? errorNavIndex + 1 : 0;
    setErrorNavIndex(next);
    scrollToError(next);
  }, [errorNavIndex, errorFields.length, scrollToError]);

  const handleChange = useCallback((fieldName: string, value: unknown) => {
    setValues(prev => ({ ...prev, [fieldName]: value }));
    setErrors(prev => {
      const next = new Map(prev);
      next.delete(fieldName);
      if (next.size === 0) setSubmitError(null);
      return next;
    });
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    // Filter out null/undefined/empty values
    const cleanValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== null && v !== undefined && v !== '') {
        cleanValues[k] = v;
      }
    }

    // Client-side validation
    const failures = validateRecord(cleanValues, fields);
    if (failures.length > 0) {
      const errorMap = new Map<string, string>();
      for (const f of failures) {
        errorMap.set(f.field, f.reason);
      }
      setErrors(errorMap);
      setErrorNavIndex(0);
      setSubmitError(
        failures.length === 1
          ? `Please fix the error in ${failures[0].field} before submitting.`
          : `Please fix the ${failures.length} field errors highlighted below before submitting.`
      );
      // Scroll to the first error
      setTimeout(() => {
        const firstField = failures[0].field;
        const el = formRef.current?.querySelector(`[id="field-${firstField}"]`)
          ?? formRef.current?.querySelector(`[data-field="${firstField}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return;
    }

    try {
      await onSubmit(cleanValues);
    } catch (err) {
      const odataErr = err as { error?: { message?: string; details?: ReadonlyArray<{ target?: string; message: string }> } };
      if (odataErr?.error?.details && odataErr.error.details.length > 0) {
        const errorMap = new Map<string, string>();
        for (const d of odataErr.error.details) {
          if (d.target) {
            errorMap.set(d.target, d.message);
          }
        }
        setErrors(errorMap);
      }
      setSubmitError(odataErr?.error?.message ?? 'Failed to save record. Please check the field values and try again.');
    }
  };

  const renderFieldGrid = (fieldList: ResoField[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {fieldList.map(field => (
        <FieldInput
          key={field.fieldName}
          field={field}
          value={values[field.fieldName]}
          onChange={handleChange}
          lookups={lookups[field.fieldName]}
          disabled={isLoading || (isEdit && field.fieldName === keyField)}
          error={errors.get(field.fieldName)}
        />
      ))}
    </div>
  );

  // Sort group keys alphabetically
  const sortedGroups = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Compute error counts per group so sections with errors auto-expand
  const groupErrorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [group, groupFields] of sortedGroups) {
      let count = 0;
      for (const field of groupFields) {
        if (errors.has(field.fieldName)) count++;
      }
      counts.set(group, count);
    }
    // Count errors in ungrouped fields for the "Other" section
    let otherCount = 0;
    for (const field of ungrouped) {
      if (errors.has(field.fieldName)) otherCount++;
    }
    counts.set('Other', otherCount);
    return counts;
  }, [sortedGroups, ungrouped, errors]);

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
      {/* Key field shown as read-only in edit mode */}
      {isEdit && (
        <div className="bg-gray-50 dark:bg-gray-900 rounded px-4 py-2 flex items-center">
          <span className="text-xs text-gray-500 dark:text-gray-400">{keyField}:</span>
          <span className="text-sm font-mono ml-2 text-gray-800 dark:text-gray-200">{String(values[keyField] ?? '')}</span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(String(values[keyField] ?? '')).then(() => {
                setKeyCopied(true);
                setTimeout(() => setKeyCopied(false), 1500);
              });
            }}
            title={keyCopied ? 'Copied!' : 'Copy key to clipboard'}
            className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            {keyCopied ? (
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <title>Copied</title>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <title>Copy to clipboard</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Grouped fields */}
      {sortedGroups.map(([group, groupFields]) => (
        <FieldGroupSection key={group} title={group} defaultOpen={sortedGroups.length <= 3} errorCount={groupErrorCounts.get(group) ?? 0}>
          {renderFieldGrid(groupFields)}
        </FieldGroupSection>
      ))}

      {/* Ungrouped fields — flat list when no groupings exist, "Other" section otherwise */}
      {ungrouped.length > 0 && sortedGroups.length === 0 && renderFieldGrid(ungrouped)}
      {ungrouped.length > 0 && sortedGroups.length > 0 && (
        <FieldGroupSection title="Other" defaultOpen errorCount={groupErrorCounts.get('Other') ?? 0}>
          {renderFieldGrid(ungrouped)}
        </FieldGroupSection>
      )}

      <div className="sticky bottom-0 z-10 pt-2 pb-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 -mx-4 px-4 sm:-mx-6 sm:px-6">
        {submitError && (
          <div className="flex items-center justify-between gap-2 mb-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded px-3 py-1.5 text-sm">
            <span>{submitError}</span>
            {errorFields.length > 1 && (
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs text-red-500 dark:text-red-400">
                  {errorNavIndex + 1} / {errorFields.length}
                </span>
                <button
                  type="button"
                  onClick={handlePrevError}
                  className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
                  title="Previous error">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>Previous</title>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={handleNextError}
                  className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
                  title="Next error">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>Next</title>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">
          {isLoading ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
};
