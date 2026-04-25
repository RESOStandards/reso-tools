/**
 * Import Diff View — shows conflicts between imported and existing connections.
 * User resolves each conflict: Keep Existing, Use Imported, or Cancel.
 */

import { useState, useCallback } from 'react';
import type { ImportConflict, ImportAnalysis } from '../../services/connection-io';
import { saveConnection, storeCredentials, saveProfile } from '../../services/connection-manager';

/** Resolution choice per conflict. */
type Resolution = 'keep' | 'import';

interface ImportDiffViewProps {
  readonly analysis: ImportAnalysis;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
}

export const ImportDiffView = ({ analysis, onComplete, onCancel }: ImportDiffViewProps) => {
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map());
  const [applying, setApplying] = useState(false);

  const setResolution = useCallback((connId: string, choice: Resolution) => {
    setResolutions(prev => new Map(prev).set(connId, choice));
  }, []);

  const allResolved = analysis.conflicts.every(c => resolutions.has(c.existing.id));

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      // Add new connections
      for (const conn of analysis.newConnections) {
        const saved = await saveConnection({ name: conn.name, url: conn.url, authMode: conn.authMode, clientId: conn.clientId, tokenUrl: conn.tokenUrl, scope: conn.scope, originatingSystemName: conn.originatingSystemName, originatingSystemId: conn.originatingSystemId });
        if (conn.credentials) {
          await storeCredentials(saved.id, conn.credentials);
        }
      }

      // Apply conflict resolutions
      for (const conflict of analysis.conflicts) {
        const choice = resolutions.get(conflict.existing.id);
        if (choice === 'import') {
          const conn = conflict.incoming;
          await saveConnection({ id: conflict.existing.id, name: conn.name, url: conn.url, authMode: conn.authMode, clientId: conn.clientId, tokenUrl: conn.tokenUrl, scope: conn.scope, originatingSystemName: conn.originatingSystemName, originatingSystemId: conn.originatingSystemId });
          if (conn.credentials) {
            await storeCredentials(conflict.existing.id, conn.credentials);
          }
        }
        // 'keep' = no action needed
      }

      // Add valid profiles
      for (const profile of analysis.validProfiles) {
        await saveProfile({ name: profile.name, credentialsId: profile.credentialsId, providerUoi: profile.providerUoi, providerUsi: profile.providerUsi, recipientUoi: profile.recipientUoi, providerName: profile.providerName, recipientName: profile.recipientName, systemName: profile.systemName, endorsements: [...profile.endorsements], ddVersion: profile.ddVersion, limit: profile.limit, strictMode: profile.strictMode, requestDelay: profile.requestDelay, rateLimitWait: profile.rateLimitWait, batchExpand: profile.batchExpand, localPath: profile.localPath });
      }

      onComplete();
    } finally {
      setApplying(false);
    }
  }, [analysis, resolutions, onComplete]);

  const hasWork = analysis.newConnections.length > 0 || analysis.conflicts.length > 0 || analysis.validProfiles.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl max-h-[80vh] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import Review</h2>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Summary */}
          <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
            {analysis.newConnections.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                {analysis.newConnections.length} new connection{analysis.newConnections.length !== 1 ? 's' : ''}
              </span>
            )}
            {analysis.conflicts.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                {analysis.conflicts.length} conflict{analysis.conflicts.length !== 1 ? 's' : ''}
              </span>
            )}
            {analysis.unchanged.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-300" />
                {analysis.unchanged.length} unchanged
              </span>
            )}
            {analysis.validProfiles.length > 0 && (
              <span>{analysis.validProfiles.length} profile{analysis.validProfiles.length !== 1 ? 's' : ''}</span>
            )}
          </div>

          {/* Conflicts */}
          {analysis.conflicts.map(conflict => (
            <ConflictCard
              key={conflict.existing.id}
              conflict={conflict}
              resolution={resolutions.get(conflict.existing.id)}
              onResolve={choice => setResolution(conflict.existing.id, choice)}
            />
          ))}

          {/* Orphaned profiles warning */}
          {analysis.orphanedProfiles.length > 0 && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
              <p className="font-medium mb-1">{analysis.orphanedProfiles.length} profile{analysis.orphanedProfiles.length !== 1 ? 's' : ''} have no matching connection:</p>
              <ul className="list-disc list-inside">
                {analysis.orphanedProfiles.map(p => <li key={p.id}>{p.name}</li>)}
              </ul>
              <p className="mt-1.5">These profiles will be skipped. You can manually assign connections after import.</p>
            </div>
          )}

          {!hasWork && analysis.unchanged.length > 0 && (
            <p className="text-center py-4 text-sm text-gray-400 dark:text-gray-500">
              All connections are already up to date. Nothing to import.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleApply}
            disabled={!allResolved || !hasWork || applying}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
            {applying ? 'Importing...' : 'Apply Import'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Conflict Card ────────────────────────────────────────────────────

const ConflictCard = ({
  conflict,
  resolution,
  onResolve,
}: {
  readonly conflict: ImportConflict;
  readonly resolution: Resolution | undefined;
  readonly onResolve: (choice: Resolution) => void;
}) => (
  <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
    <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 flex items-center justify-between">
      <div className="text-xs font-medium text-amber-800 dark:text-amber-300">
        {conflict.existing.name} — {conflict.diffs.length} field{conflict.diffs.length !== 1 ? 's' : ''} differ
      </div>
      <div className="flex gap-1.5">
        <button type="button" onClick={() => onResolve('keep')}
          className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${resolution === 'keep' ? 'bg-gray-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}>
          Keep Existing
        </button>
        <button type="button" onClick={() => onResolve('import')}
          className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${resolution === 'import' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}>
          Use Imported
        </button>
      </div>
    </div>
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-200 dark:border-gray-700">
          <th className="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-gray-400 w-1/4">Field</th>
          <th className="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-gray-400 w-[37.5%]">Existing</th>
          <th className="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-gray-400 w-[37.5%]">Incoming</th>
        </tr>
      </thead>
      <tbody>
        {conflict.diffs.map(d => (
          <tr key={d.field} className="border-b border-gray-100 dark:border-gray-700/50">
            <td className="px-3 py-1.5 font-medium text-gray-700 dark:text-gray-300">{d.field}</td>
            <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400 bg-red-50/30 dark:bg-red-900/10">{d.existing || '—'}</td>
            <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400 bg-green-50/30 dark:bg-green-900/10">{d.incoming || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
