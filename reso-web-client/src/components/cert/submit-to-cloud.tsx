/**
 * Submit to RESO — handoff UI for pushing local test results
 * to the RESO Services API (services.reso.org).
 *
 * Appears after a local job passes. Uses the provider Bearer token
 * (from OAuth2 client_credentials) to authenticate with the backend.
 *
 * Flow:
 *   1. User clicks "Submit to RESO" on a passed job
 *   2. Modal shows submission summary (endorsement, recipient, provider)
 *   3. User confirms → POST results to services.reso.org
 *   4. Progress indicator → success/failure with cert API link
 */

import { useEffect, useState } from 'react';
import { Badge, FilterPill } from '../metadata/shared';
import { CERT_ENV_LABELS, CERT_ENV_SHORT_LABELS, SERVICES_URLS } from '../../constants/cert';
import type { CertEnvironment } from '../../constants/cert';
import type { Job } from '../../services/job-manager';

// ── Types ────────────────────────────────────────────────────────────

type SubmissionState = 'preview' | 'submitting' | 'success' | 'error';

interface SubmissionResult {
  readonly endorsementId?: string;
  readonly certApiUrl?: string;
  readonly error?: string;
}

// ── Component ────────────────────────────────────────────────────────

export const SubmitToCloud = ({
  job,
  onClose,
}: {
  readonly job: Job;
  readonly onClose: () => void;
}) => {
  const [state, setState] = useState<SubmissionState>('preview');
  const [env, setEnv] = useState<CertEnvironment>('certqa');
  const [result, setResult] = useState<SubmissionResult>({});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = async () => {
    setState('submitting');

    // TODO: Wire to actual submission endpoint
    //   POST ${ENV_URLS[env]}/api/v1/certification/submit
    //   Authorization: Bearer <providerToken>
    //   Body: { endorsement, version, recipientUoi, providerUoi, providerUsi, results: PipelineResult }
    //
    // The provider token comes from auth-context (requestProviderToken).
    // On success, the backend:
    //   1. Stores results in S3
    //   2. Updates DynamoDB state
    //   3. Creates/updates the endorsement record in the Cert API
    //   4. Returns the endorsement ID for linking

    // Simulate for now
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Simulate success (90%) or error (10%)
    if (Math.random() > 0.1) {
      const endorsementId = `RPT-${Date.now().toString(36).toUpperCase()}`;
      setResult({
        endorsementId,
        certApiUrl: `https://${env === 'production' ? 'certification' : env}.reso.org/endorsement/${endorsementId}`,
      });
      setState('success');
    } else {
      setResult({ error: 'Connection to services.reso.org timed out. Please try again.' });
      setState('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 max-w-lg w-full mx-4 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Submit to RESO
          </h3>
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

        {/* Preview state */}
        {state === 'preview' && (
          <>
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">Endorsement</span>
                <div className="flex items-center gap-2">
                  <Badge label={job.endorsement} color="blue" />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{job.version}</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">Recipient</span>
                <span className="text-sm text-gray-900 dark:text-gray-100">{job.recipientName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">Recipient UOI</span>
                <span className="text-sm font-mono text-gray-600 dark:text-gray-400">{job.recipientUoi}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">Provider UOI</span>
                <span className="text-sm font-mono text-gray-600 dark:text-gray-400">{job.providerUoi}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">Status</span>
                <span className="text-sm font-semibold text-green-600 dark:text-green-400">Passed (Local)</span>
              </div>
            </div>

            {/* Environment selector */}
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                Target Environment
              </label>
              <div className="flex items-center gap-1">
                {(Object.entries(CERT_ENV_LABELS) as ReadonlyArray<[CertEnvironment, string]>).map(([key, label]) => (
                  <FilterPill
                    key={key}
                    label={CERT_ENV_SHORT_LABELS[key]}
                    active={env === key}
                    onClick={() => setEnv(key)}
                  />
                ))}
              </div>
              <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                {CERT_ENV_LABELS[env]}
              </p>
              {env === 'production' && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                  Production submissions are visible to RESO and the recipient organization.
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 justify-end pt-2 border-t border-gray-100 dark:border-gray-700/50">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 cursor-pointer transition-colors"
              >
                Start Certification
              </button>
            </div>
          </>
        )}

        {/* Submitting state */}
        {state === 'submitting' && (
          <div className="flex flex-col items-center py-8 space-y-4">
            <svg className="w-10 h-10 text-blue-500 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Submitting results...
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Uploading to {CERT_ENV_LABELS[env]}
              </p>
            </div>
          </div>
        )}

        {/* Success state */}
        {state === 'success' && (
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-5">
              <div className="flex items-center gap-3">
                <svg className="w-8 h-8 text-green-600 dark:text-green-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-green-800 dark:text-green-200">
                    Results submitted successfully
                  </p>
                  <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">
                    Endorsement ID: <span className="font-mono">{result.endorsementId}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 justify-end">
              {result.certApiUrl && (
                <a
                  href={result.certApiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
                >
                  View on Cert Site
                </a>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Error state */}
        {state === 'error' && (
          <div className="space-y-4">
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-5">
              <div className="flex items-center gap-3">
                <svg className="w-8 h-8 text-red-600 dark:text-red-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                    Submission failed
                  </p>
                  <p className="text-xs text-red-700 dark:text-red-300 mt-0.5">
                    {result.error}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setState('preview')}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
