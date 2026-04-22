/**
 * Export Dialog — modal with three independent toggles for exporting
 * connections and/or cert profiles, with optional credential inclusion.
 */

import { useState, useCallback } from 'react';
import { buildExportPayload, downloadExport } from '../../services/connection-io';

interface ExportDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

const ToggleBadge = ({ label, active, onChange }: { label: string; active: boolean; onChange: (v: boolean) => void }) => (
  <button
    type="button"
    onClick={() => onChange(!active)}
    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
      active
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-600'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600'
    }`}
  >
    <span className={`w-3 h-3 rounded-sm border flex items-center justify-center transition-colors ${
      active ? 'bg-blue-600 border-blue-600' : 'bg-white dark:bg-gray-600 border-gray-300 dark:border-gray-500'
    }`}>
      {active && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="currentColor" className="w-2.5 h-2.5 text-white">
          <path d="M9.78 2.72a.75.75 0 010 1.06l-4.5 4.5a.75.75 0 01-1.06 0L1.97 6.03a.75.75 0 011.06-1.06L4.5 6.44l3.97-3.72a.75.75 0 011.06 0z" />
        </svg>
      )}
    </span>
    {label}
  </button>
);

export const ExportDialog = ({ isOpen, onClose }: ExportDialogProps) => {
  const [includeConnections, setIncludeConnections] = useState(true);
  const [includeProfiles, setIncludeProfiles] = useState(true);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canExport = includeConnections || includeProfiles;

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const payload = await buildExportPayload({ includeConnections, includeProfiles, includeCredentials: includeConnections && includeCredentials });
      const parts = [includeConnections ? 'connections' : '', includeProfiles ? 'profiles' : ''].filter(Boolean).join('-');
      downloadExport(payload, `reso-${parts}`);
      onClose();
    } finally {
      setExporting(false);
    }
  }, [includeConnections, includeProfiles, includeCredentials, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Export</h3>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <ToggleBadge label="Connections" active={includeConnections} onChange={setIncludeConnections} />
            <ToggleBadge label="Cert Profiles" active={includeProfiles} onChange={setIncludeProfiles} />
          </div>

          {includeConnections && (
            <div className="pl-1">
              <ToggleBadge label="Include Credentials" active={includeCredentials} onChange={setIncludeCredentials} />
              {includeCredentials && (
                <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                  Credentials will be included in plain text in the exported file.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!canExport || exporting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
};
