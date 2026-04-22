import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GenerateResponse, ResourceStatus } from '../../api/admin-client';
import { generateData, getGeneratorStatus, resetData } from '../../api/admin-client';

/** Short display labels for child resources with long names. */
const CHILD_DISPLAY_NAMES: Record<string, string> = {
  PropertyRooms: 'Rooms',
  PropertyGreenVerification: 'Green Verification',
  PropertyPowerProduction: 'Power Production',
  PropertyUnitTypes: 'Unit Types'
};

/** Returns a short display name for a resource. */
const displayName = (resource: string): string => CHILD_DISPLAY_NAMES[resource] ?? resource;

/** Admin page for generating seed data. */
export const DataGeneratorPage = () => {
  const [resources, setResources] = useState<ReadonlyArray<ResourceStatus>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [selectedResource, setSelectedResource] = useState('Property');
  const [count, setCount] = useState(10);
  const [countInput, setCountInput] = useState('10');
  const [countError, setCountError] = useState<string | null>(null);
  const [relatedConfig, setRelatedConfig] = useState<Record<string, { enabled: boolean; count: number }>>({});

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);

  // Reset state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  const loadStatus = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const status = await getGeneratorStatus();
      setResources(status.resources);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Derive the valid related resources for the selected parent from server metadata
  const selectedStatus = useMemo(() => resources.find(r => r.resource === selectedResource), [resources, selectedResource]);
  const validRelated = useMemo(() => selectedStatus?.relatedResources ?? [], [selectedStatus]);

  // When selected resource or server data changes, rebuild relatedConfig for valid children
  useEffect(() => {
    if (validRelated.length === 0) return;
    setRelatedConfig(prev => {
      const next: Record<string, { enabled: boolean; count: number }> = {};
      for (const r of validRelated) {
        next[r.resource] = prev[r.resource] ?? { enabled: true, count: r.defaultCount };
      }
      return next;
    });
  }, [validRelated]);

  const handleGenerate = async () => {
    setGenerating(true);
    setResult(null);
    setError(null);

    const relatedRecords: Record<string, number> = {};
    for (const r of validRelated) {
      const cfg = relatedConfig[r.resource];
      if (cfg?.enabled) {
        relatedRecords[r.resource] = cfg.count;
      }
    }

    try {
      const response = await generateData({
        resource: selectedResource,
        count,
        relatedRecords: Object.keys(relatedRecords).length > 0 ? relatedRecords : undefined,
        resolveDependencies: true
      });
      setResult(response);
      await loadStatus(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const toggleRelated = (resource: string) => {
    setRelatedConfig(prev => ({
      ...prev,
      [resource]: { ...prev[resource], enabled: !prev[resource].enabled }
    }));
  };

  const setRelatedCount = (resource: string, newCount: number) => {
    setRelatedConfig(prev => ({
      ...prev,
      [resource]: { ...prev[resource], count: Math.max(1, newCount) }
    }));
  };

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    setResult(null);
    try {
      await resetData();
      setShowResetConfirm(false);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setResetting(false);
    }
  };

  // Parent resources are those that have related resources defined
  const parentResources = resources.filter(r => r.relatedResources.length > 0);

  // Enabled related entries for the plan summary
  const enabledRelated = validRelated.filter(r => relatedConfig[r.resource]?.enabled);

  return (
    <div className="max-w-5xl">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">Data Generator</h2>

      {/* Current status */}
      {!loading && resources.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Current Record Counts</h3>
          <div className="flex flex-wrap gap-2">
            {resources.map(r => (
              <div key={r.resource} className="bg-gray-100 dark:bg-gray-800 rounded px-3 py-2 text-center min-w-[5rem]">
                <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{displayName(r.resource)}</div>
                <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{r.count.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Generation form */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left column: Resource + Count */}
          <div className="space-y-5">
            {/* Resource selector */}
            <div>
              <label htmlFor="resource" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Resource
              </label>
              <select
                id="resource"
                value={selectedResource}
                onChange={e => setSelectedResource(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {(parentResources.length > 0 ? parentResources : resources).map(r => (
                  <option key={r.resource} value={r.resource}>
                    {r.resource} ({r.fields.toLocaleString()} fields, {r.count.toLocaleString()} existing)
                  </option>
                ))}
              </select>
            </div>

            {/* Count */}
            <div>
              <label htmlFor="count" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Number of records
              </label>
              <input
                id="count"
                type="number"
                value={countInput}
                onChange={e => {
                  setCountInput(e.target.value);
                  const raw = e.target.value.trim();
                  if (raw === '') {
                    setCountError(null);
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n) || !Number.isInteger(n)) {
                    setCountError('Must be a whole number');
                  } else if (n < 1) {
                    setCountError('Must be at least 1');
                  } else if (n > 10000) {
                    setCountError('Maximum is 10,000');
                  } else {
                    setCountError(null);
                    setCount(n);
                  }
                }}
                onBlur={() => {
                  const n = Math.max(1, Math.min(10000, Math.round(Number(countInput) || 1)));
                  setCount(n);
                  setCountInput(String(n));
                  setCountError(null);
                }}
                min={1}
                max={10000}
                className={`w-32 px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  countError ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
                }`}
              />
              {countError && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{countError}</p>}
            </div>
          </div>

          {/* Right column: Related records (only shown when there are valid related resources) */}
          {validRelated.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Related Records</h3>
              <div className="space-y-2">
                {validRelated.map(({ resource }) => (
                  <div key={resource} className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={relatedConfig[resource]?.enabled ?? false}
                        onChange={() => toggleRelated(resource)}
                        className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">{displayName(resource)}</span>
                    </label>
                    {relatedConfig[resource]?.enabled && (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={relatedConfig[resource]?.count ?? 2}
                          onChange={e => setRelatedCount(resource, Number(e.target.value))}
                          min={1}
                          max={100}
                          className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-500 dark:text-gray-400">per {selectedResource}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Summary + Button — full width below the two columns */}
        <div className="mt-6 space-y-4">
          <div className="bg-gray-50 dark:bg-gray-900 rounded p-3 text-sm text-gray-600 dark:text-gray-400">
            {(() => {
              const relatedTotal = enabledRelated.reduce(
                (sum, r) => sum + (relatedConfig[r.resource]?.count ?? r.defaultCount) * count,
                0
              );
              const grandTotal = count + relatedTotal;
              return (
                <>
                  <strong>Plan:</strong> {count.toLocaleString()} {selectedResource} records
                  {enabledRelated.length > 0 && (
                    <>
                      {' + '}
                      {enabledRelated
                        .map(r => `${((relatedConfig[r.resource]?.count ?? r.defaultCount) * count).toLocaleString()} ${displayName(r.resource)}`)
                        .join(', ')}
                      {' = '}
                      <strong>{grandTotal.toLocaleString()} total</strong>
                    </>
                  )}
                </>
              );
            })()}
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || loading}
            className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 text-white text-sm font-medium rounded-lg transition-colors">
            {generating ? 'Generating...' : 'Generate Data'}
          </button>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="mt-6 bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-green-800 dark:text-green-200 mb-3">Generation Complete</h3>
          {(() => {
            // Separate requested results from auto-generated dependencies
            const requestedResources = new Set([
              result.resource,
              ...enabledRelated.map(r => r.resource)
            ]);
            const requested = result.relatedResults.filter(r => requestedResources.has(r.resource));
            const dependencies = result.relatedResults.filter(r => !requestedResources.has(r.resource));
            const totalCreated = result.created + result.relatedResults.reduce((s, r) => s + r.created, 0);
            const totalFailed = result.failed + result.relatedResults.reduce((s, r) => s + r.failed, 0);
            const depCreated = dependencies.reduce((s, r) => s + r.created, 0);

            return (
              <div className="space-y-1 text-sm text-green-700 dark:text-green-300">
                <p>
                  {result.resource}: {result.created.toLocaleString()} created, {result.failed.toLocaleString()} failed
                </p>
                {requested.map(r => (
                  <p key={r.resource}>
                    {displayName(r.resource)}: {r.created.toLocaleString()} created, {r.failed.toLocaleString()} failed
                  </p>
                ))}
                {(requested.length > 0 || dependencies.length > 0) && (
                  <p className="font-medium mt-1">
                    Total: {totalCreated.toLocaleString()} created
                    {totalFailed > 0 && `, ${totalFailed.toLocaleString()} failed`}
                  </p>
                )}
                {dependencies.length > 0 && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                    Includes {depCreated.toLocaleString()} records auto-generated for dependencies
                    ({dependencies.map(r => `${r.created.toLocaleString()} ${displayName(r.resource)}`).join(', ')})
                  </p>
                )}
                <p className="text-xs text-green-600 dark:text-green-400 mt-2">Duration: {(result.durationMs / 1000).toFixed(1)}s</p>
              </div>
            );
          })()}
          {(result.info?.length ?? 0) > 0 && (
            <div className="mt-3 text-xs text-blue-600 dark:text-blue-400">
              {result.info!.map(msg => (
                <p key={msg} className="ml-2">{msg}</p>
              ))}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="mt-3 text-xs text-red-600 dark:text-red-400">
              <p className="font-medium">Errors:</p>
              {result.errors.slice(0, 5).map(err => (
                <p key={err} className="ml-2">
                  {err}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reset section */}
      {!loading && resources.some(r => r.count > 0) && (
        <div className="mt-8 border-t border-gray-200 dark:border-gray-700 pt-6">
          {!showResetConfirm ? (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              disabled={generating || resetting}
              className="px-4 py-2 text-sm text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              Reset All Data
            </button>
          ) : (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded-lg p-4">
              <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-1">
                This will permanently delete all records from every resource.
              </p>
              <p className="text-xs text-red-600 dark:text-red-400 mb-3">
                {resources.reduce((s, r) => s + r.count, 0).toLocaleString()} records across {resources.filter(r => r.count > 0).length} resources will be removed. Schema will be preserved.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetting}
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">
                  {resetting ? 'Resetting...' : 'Confirm Reset'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(false)}
                  disabled={resetting}
                  className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
