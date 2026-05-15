/**
 * Variations Import — admin upload path for v0.11.
 *
 * Two flows:
 *
 * - **Path B (default for admin):** upload a CSV/JSON of variations
 *   that a provider emailed in (they don't run the desktop client),
 *   pick the provider/system/recipient identifiers, and start a
 *   variations review on their behalf. Backend writes the
 *   endorsement row + variationsReview rows the same way a provider's
 *   own submit would; the provider gets the cross-side notification
 *   when they next sign in.
 *
 * - **Path A (deferred to v0.12, #186):** admin direct-add to the
 *   canonical mappings index. Bypasses the in-review queue. UI not
 *   wired yet — Path B is the immediate workflow unblock.
 *
 * Polished editable-table review of parsed rows is also v0.12 (#186).
 * v0.11 ships the basic flow: parse → surface valid/invalid counts +
 * per-row errors → commit valid rows.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { csvToVariations, type ParseVariationsCsvResult, type VariationCsvRow } from '@reso-standards/reso-client';
import { useAuth } from '../../hooks/use-auth';
import { enqueueTask } from '../../services/pending-tasks';
import { VARIATIONS_SAVE_TASK_TYPE, type VariationsSavePayload } from '../../services/pending-task-executors/variations-save';
import { buildVariationKey } from '@reso-standards/reso-client';

const PAGE_CONTAINER = 'max-w-5xl mx-auto px-4';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';
const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400';

/**
 * Map a Variations CSV row to the action shape the save handler
 * understands. The Outcome column drives the action; empty Outcome
 * means "no decision yet" — the row goes to the holding table as
 * pending (the full-coverage save handler accepts these).
 */
const outcomeToAction = (outcome?: string): 'ignored' | 'fast-track' | 'remove' | undefined => {
  if (!outcome) return undefined;
  const normalized = outcome.trim().toLowerCase();
  if (normalized === 'ignore' || normalized === 'ignored') return 'ignored';
  if (normalized === 'fast track' || normalized === 'fast-track' || normalized === 'ft') return 'fast-track';
  if (normalized === 'remove' || normalized === 'removed') return 'remove';
  return undefined;
};

const rowToVariationsChange = (row: VariationCsvRow): {
  readonly key: string;
  readonly action: 'ignored' | 'fast-track' | 'remove' | undefined;
} => {
  const key = buildVariationKey(row.resourceName, row.fieldName, row.lookupValue);
  const action = outcomeToAction(row.outcome);
  return { key, action };
};

export const VariationsImportPage = () => {
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseVariationsCsvResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [providerUoi, setProviderUoi] = useState('');
  const [providerUsi, setProviderUsi] = useState('');
  const [recipientUoi, setRecipientUoi] = useState('');
  const [version, setVersion] = useState('2.1');
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setParseError(null);
    setSubmitMessage(null);
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        // JSON path: assume canonical variations-report.json shape.
        // Extract `changes` and map to the parser's row shape so the
        // rest of the flow can be uniform.
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const changes = (parsed.changes as ReadonlyArray<Record<string, unknown>>) ?? [];
        const rows: VariationCsvRow[] = changes
          .filter(c => typeof c.resourceName === 'string' && (c.resourceName as string).length > 0)
          .map(c => ({
            resourceName: c.resourceName as string,
            fieldName: c.fieldName as string | undefined,
            lookupValue: c.lookupValue as string | undefined,
            suggestedResourceName: c.suggestedResourceName as string | undefined,
            suggestedFieldName: c.suggestedFieldName as string | undefined,
            suggestedLookupValue: c.suggestedLookupValue as string | undefined,
            suggestedLegacyODataValue: c.suggestedLegacyODataValue as string | undefined,
            suggestedRelatedResourceName: c.suggestedRelatedResourceName as string | undefined,
            suggestedRelatedFieldName: c.suggestedRelatedFieldName as string | undefined,
            suggestedRelatedLookupValue: c.suggestedRelatedLookupValue as string | undefined,
            outcome: c.flaggedForFastTrack ? 'Fast Track' : c.remove ? 'Remove' : c.ignore ? 'Ignore' : undefined,
          }));
        setParseResult({ rows, errors: [] });
        // Auto-fill provenance from the JSON when present.
        if (typeof parsed.providerUoi === 'string') setProviderUoi(parsed.providerUoi);
        if (typeof parsed.providerUsi === 'string') setProviderUsi(parsed.providerUsi);
        if (typeof parsed.recipientUoi === 'string') setRecipientUoi(parsed.recipientUoi);
        if (typeof parsed.version === 'string') setVersion(parsed.version);
      } else {
        setParseResult(csvToVariations(text));
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse file');
      setParseResult(null);
    }
  }, []);

  const canStart = !!parseResult
    && parseResult.rows.length > 0
    && !!providerUoi.trim()
    && !!providerUsi.trim()
    && !!recipientUoi.trim()
    && !!version.trim();

  const handleStartReview = useCallback(async () => {
    if (!canStart || !parseResult) return;
    setSubmitting(true);
    setSubmitMessage(null);

    const validRows = parseResult.rows;
    const actions = validRows
      .map(rowToVariationsChange)
      .filter(c => c.action !== undefined)
      .map(c => ({ key: c.key, status: c.action as 'ignored' | 'fast-track' | 'remove' }));

    const payload: VariationsSavePayload = {
      version: version.trim(),
      providerUoi: providerUoi.trim(),
      providerUsi: providerUsi.trim(),
      recipientUoi: recipientUoi.trim(),
      actions,
      comments: [],
      userName: user?.fullName ?? user?.username ?? '',
      userEmail: user?.email ?? '',
    };

    await enqueueTask({
      type: VARIATIONS_SAVE_TASK_TYPE,
      payload,
      scope: `import:${providerUoi.trim()}:${recipientUoi.trim()}:${version.trim()}`,
    });

    setSubmitting(false);
    setSubmitMessage(`Started review on behalf of ${providerUoi.trim()} (${actions.length} actions). It will surface in the In Review queue shortly.`);
  }, [canStart, parseResult, providerUoi, providerUsi, recipientUoi, version, user]);

  if (!isAdmin) {
    return (
      <div className={`${PAGE_CONTAINER} py-12 text-center`}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          The variations import flow is admin-only for v0.11. Provider-side upload arrives in v0.12.
        </p>
      </div>
    );
  }

  return (
    <div className={`${PAGE_CONTAINER} py-6`}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Import Variations</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Upload a CSV or JSON variations report and start a review on behalf of a provider.
        </p>
      </div>

      {/* File picker */}
      <section className="mb-6">
        <label className={LABEL}>File</label>
        <input
          type="file"
          accept=".csv,.json,text/csv,application/json"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          className="block text-sm text-gray-700 dark:text-gray-300"
        />
        {fileName && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Loaded: {fileName}</p>
        )}
        {parseError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{parseError}</p>
        )}
      </section>

      {/* Parse result */}
      {parseResult && (
        <section className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
          <div className="text-sm">
            <span className="text-gray-700 dark:text-gray-300">
              Parsed {parseResult.rows.length} row{parseResult.rows.length !== 1 ? 's' : ''}
            </span>
            {parseResult.errors.length > 0 && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                · {parseResult.errors.length} skipped
              </span>
            )}
          </div>
          {parseResult.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">Skipped rows</summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">
                {parseResult.errors.map((e, i) => (
                  <li key={i}>Line {e.line}: {e.message}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {/* Provenance — admin picks the on-behalf-of triple */}
      <section className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Provider UOI</label>
          <input type="text" value={providerUoi} onChange={e => setProviderUoi(e.target.value)} placeholder="T00000045" className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>Provider USI</label>
          <input type="text" value={providerUsi} onChange={e => setProviderUsi(e.target.value)} placeholder="50013" className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>Recipient UOI</label>
          <input type="text" value={recipientUoi} onChange={e => setRecipientUoi(e.target.value)} placeholder="M00000519" className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>DD Version</label>
          <input type="text" value={version} onChange={e => setVersion(e.target.value)} placeholder="2.1" className={INPUT} />
        </div>
      </section>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleStartReview}
          disabled={!canStart || submitting}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Submitting…' : 'Start Variations Review on Behalf'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/cert/variations')}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
        >
          Cancel
        </button>
      </div>

      {submitMessage && (
        <p className="mt-4 text-sm text-emerald-700 dark:text-emerald-300">{submitMessage}</p>
      )}
    </div>
  );
};
