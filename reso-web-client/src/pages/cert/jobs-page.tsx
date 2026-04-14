/**
 * Certification Jobs page — start, schedule, monitor, and review test runs.
 *
 * Four states: Scheduled → Running → Finished → Compare
 * Plus Cancelled as an exit from any active state.
 *
 * This is a stub with placeholder UI for layout review.
 * The actual job runner, notifications poller, and results submission
 * will be wired in when the reso-certification-backend SDK is ready.
 */

import { useState, useMemo } from 'react';
import { NavLink } from 'react-router';
import { StatusPill } from '../../components/cert/status-pill';
import { SearchInput } from '../../components/metadata/shared';
import { ConfigBuilder } from '../../components/cert/config-builder';
import { SubmitToCloud } from '../../components/cert/submit-to-cloud';
import { FailureReportModal } from '../../components/cert/error-reports';
import { useJobs } from '../../hooks/use-jobs';
import type { BatchConfig } from '../../components/cert/config-builder';
import type { Job } from '../../services/job-manager';
import type { EndorsementStatus } from '../../api/cert-fixtures';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

// ── Types ────────────────────────────────────────────────────────────

type JobStatus = 'scheduled' | 'running' | 'passed' | 'failed' | 'cancelled';

interface JobStep {
  readonly name: string;
  readonly status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  readonly duration?: number;
  readonly detail?: string;
}

interface CertJob {
  readonly id: string;
  readonly endorsement: string;
  readonly version: string;
  readonly recipientUoi: string;
  readonly recipientName: string;
  readonly providerUoi: string;
  readonly providerName: string;
  readonly status: JobStatus;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly steps: ReadonlyArray<JobStep>;
  readonly local: boolean;
  readonly reports?: Record<string, unknown>;
  readonly error?: string;
}

// ── Fixture data for layout review ──────────────────────────────────

const SAMPLE_STEPS: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 52 },
  { name: 'Authentication', status: 'passed', duration: 120 },
  { name: 'Metadata Report', status: 'passed', duration: 340 },
  { name: 'Variations Check', status: 'passed', duration: 143 },
  { name: 'Replication', status: 'running', detail: '750 of 1,000 records' },
  { name: 'Schema Validation', status: 'pending' },
  { name: 'Data Availability', status: 'pending' },
  { name: 'Results Submission', status: 'pending' },
];

// ── DD failure step sets ─────────────────────────────────────────────

const DD_STEPS_METADATA_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 52 },
  { name: 'Authentication', status: 'passed', duration: 120 },
  { name: 'Generate Metadata Report', status: 'failed', duration: 1240, detail: 'Could not parse CSDL XML: unexpected token at line 47. The server returned invalid metadata. Check that $metadata returns well-formed OData 4.0 CSDL XML.' },
  { name: 'Variations Check', status: 'skipped' },
  { name: 'Replication', status: 'skipped' },
  { name: 'Schema Validation', status: 'skipped' },
  { name: 'Data Availability', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

const DD_STEPS_VARIATIONS_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 48 },
  { name: 'Authentication', status: 'passed', duration: 95 },
  { name: 'Generate Metadata Report', status: 'passed', duration: 340, detail: '14 resources, 1,196 fields, 4,335 lookups' },
  { name: 'Variations Check', status: 'failed', duration: 280, detail: '12 suggested field mappings, 8 suggested lookup mappings. Local field "Lst_Price" matches RESO standard "ListPrice" (substring match). Local lookup "Single Fam" matches "Single Family Residence" (fuzzy match, 87% similarity).' },
  { name: 'Replication', status: 'skipped' },
  { name: 'Schema Validation', status: 'skipped' },
  { name: 'Data Availability', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

const DD_STEPS_CONNECTION_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'failed', duration: 30120, detail: 'Connection timed out after 30 seconds. Verify the server URL is correct and the server is running. URL: https://api.example.com/odata' },
  { name: 'Authentication', status: 'skipped' },
  { name: 'Generate Metadata Report', status: 'skipped' },
  { name: 'Variations Check', status: 'skipped' },
  { name: 'Replication', status: 'skipped' },
  { name: 'Schema Validation', status: 'skipped' },
  { name: 'Data Availability', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

const DD_STEPS_SCHEMA_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 52 },
  { name: 'Authentication', status: 'passed', duration: 120 },
  { name: 'Generate Metadata Report', status: 'passed', duration: 340, detail: '14 resources, 1,196 fields, 4,335 lookups' },
  { name: 'Initialize Replication', status: 'passed', duration: 1 },
  { name: 'Variations Check', status: 'passed', duration: 143, detail: 'No variations found' },
  { name: 'Replication', status: 'passed', duration: 45000, detail: '1,000 Property records, 500 Member, 200 Office' },
  { name: 'Schema Validation', status: 'failed', duration: 2100, detail: '47 schema errors across Property and Member. Top issues: 23 "MUST be equal to one of the allowed values" (AOR fields using non-standard values), 15 "Fields MUST be advertised in the metadata" (undeclared flattened fields), 9 "numeric field overflow" (Decimal precision exceeded).' },
  { name: 'Results Submission', status: 'skipped' },
];

// ── Core failure step sets ───────────────────────────────────────────

const CORE_STEPS_PASSED: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 45 },
  { name: 'Authentication', status: 'passed', duration: 200 },
  { name: 'Fetch Metadata', status: 'passed', duration: 180, detail: '14 resources, OData 4.01' },
  { name: '$select Support', status: 'passed', duration: 320 },
  { name: '$filter Support', status: 'passed', duration: 450 },
  { name: '$orderby Support', status: 'passed', duration: 280 },
  { name: '$top/$skip Pagination', status: 'passed', duration: 520 },
  { name: '$count Support', status: 'passed', duration: 150 },
  { name: '$expand Support', status: 'passed', duration: 380 },
  { name: 'Results Submission', status: 'passed', duration: 90 },
];

const CORE_STEPS_FILTER_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 45 },
  { name: 'Authentication', status: 'passed', duration: 200 },
  { name: 'Fetch Metadata', status: 'passed', duration: 180, detail: '14 resources, OData 4.01' },
  { name: '$select Support', status: 'passed', duration: 320 },
  { name: '$filter Support', status: 'failed', duration: 890, detail: 'Server returned HTTP 400 for $filter=ListPrice ge 100000 and ListPrice le 500000. OData $filter with "and" operator is required for Web API Core compliance. The server may not support compound filter expressions.' },
  { name: '$orderby Support', status: 'skipped' },
  { name: '$top/$skip Pagination', status: 'skipped' },
  { name: '$count Support', status: 'skipped' },
  { name: '$expand Support', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

// ── Add/Edit failure step sets ───────────────────────────────────────

const ADDEDIT_STEPS_VALIDATION_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 45 },
  { name: 'Authentication', status: 'passed', duration: 200 },
  { name: 'Fetch Metadata', status: 'passed', duration: 180, detail: '742 fields on Property' },
  { name: 'Create (Required Fields)', status: 'passed', duration: 420, detail: 'Server correctly rejected missing PostalCode and Country with structured 400' },
  { name: 'Create (Valid Record)', status: 'passed', duration: 350 },
  { name: 'Update (PATCH)', status: 'passed', duration: 280 },
  { name: 'Delete', status: 'passed', duration: 150 },
  { name: 'Error Response Validation', status: 'failed', duration: 560, detail: 'Server returned unstructured error for invalid lookup value. Expected OData JSON error format with error.code and error.details[], but server returned plain text "Bad Request". RESO Add/Edit requires structured error responses per OData 4.01 Section 19.1.' },
  { name: 'Results Submission', status: 'skipped' },
];

// ── EntityEvent failure step sets ────────────────────────────────────

const ENTITYEVENT_STEPS_AUTH_FAIL: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 45 },
  { name: 'Authentication', status: 'failed', duration: 3200, detail: 'OAuth2 Client Credentials grant returned HTTP 401: "invalid_client". Verify the client_id and client_secret are correct and the token endpoint URL is accessible. The EntityEvent feed requires authenticated access.' },
  { name: 'Verify EntityEvent Resource', status: 'skipped' },
  { name: 'Create Test Record', status: 'skipped' },
  { name: 'Poll EntityEvent Feed', status: 'skipped' },
  { name: 'Verify Event Produced', status: 'skipped' },
  { name: 'Delete Test Record', status: 'skipped' },
  { name: 'Verify Delete Event', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

const ENTITYEVENT_STEPS_NO_EVENTS: ReadonlyArray<JobStep> = [
  { name: 'Health Check', status: 'passed', duration: 45 },
  { name: 'Authentication', status: 'passed', duration: 200 },
  { name: 'Verify EntityEvent Resource', status: 'passed', duration: 120, detail: '5 fields: EntityEventSequence, ResourceName, ResourceRecordKey, ResourceRecordUrl, FeedTypes' },
  { name: 'Create Test Record', status: 'passed', duration: 350, detail: 'Created Property record with key abc123' },
  { name: 'Poll EntityEvent Feed', status: 'failed', duration: 60200, detail: 'Polled EntityEvent 10 times over 60 seconds after creating a Property record. No new events appeared. The server must produce an EntityEvent row for every successful create, update and delete operation. Verify that EntityEvent is enabled and that the OData write path emits events.' },
  { name: 'Verify Event Produced', status: 'skipped' },
  { name: 'Delete Test Record', status: 'skipped' },
  { name: 'Verify Delete Event', status: 'skipped' },
  { name: 'Results Submission', status: 'skipped' },
];

// ── Sample jobs ──────────────────────────────────────────────────────

const SAMPLE_JOBS: ReadonlyArray<CertJob> = [
  // Running: DD replication in progress
  {
    id: '1',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000570',
    recipientName: 'Aberdeen Area Association of REALTORS\u00AE',
    providerUoi: 'T00000052',
    providerName: 'FBS',
    status: 'running',
    scheduledAt: '2026-04-13T09:00:00Z',
    startedAt: '2026-04-13T09:00:05Z',
    steps: SAMPLE_STEPS,
    local: true,
  },
  // Scheduled: Core queued after DD
  {
    id: '2',
    endorsement: 'Web API Core',
    version: '2.0.0',
    recipientUoi: 'M00000570',
    recipientName: 'Aberdeen Area Association of REALTORS\u00AE',
    providerUoi: 'T00000052',
    providerName: 'FBS',
    status: 'scheduled',
    scheduledAt: '2026-04-13T09:15:00Z',
    steps: [],
    local: true,
  },
  // Passed: DD cloud run
  {
    id: '3',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000123',
    recipientName: 'bridgeMLS',
    providerUoi: 'T00000208',
    providerName: 'Bridge Interactive',
    status: 'passed',
    scheduledAt: '2026-04-13T08:00:00Z',
    startedAt: '2026-04-13T08:00:03Z',
    completedAt: '2026-04-13T08:14:47Z',
    steps: SAMPLE_STEPS.map(s => ({ ...s, status: 'passed' as const, duration: s.duration ?? 200 })),
    local: false,
  },
  // Passed: Core
  {
    id: '4',
    endorsement: 'Web API Core',
    version: '2.0.0',
    recipientUoi: 'M00000123',
    recipientName: 'bridgeMLS',
    providerUoi: 'T00000208',
    providerName: 'Bridge Interactive',
    status: 'passed',
    scheduledAt: '2026-04-13T08:15:00Z',
    startedAt: '2026-04-13T08:15:02Z',
    completedAt: '2026-04-13T08:18:30Z',
    steps: CORE_STEPS_PASSED,
    local: false,
  },
  // Failed: DD schema validation errors
  {
    id: '5',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000456',
    recipientName: 'State-Wide MLS',
    providerUoi: 'T00000210',
    providerName: 'Cotality',
    status: 'failed',
    scheduledAt: '2026-04-13T07:30:00Z',
    startedAt: '2026-04-13T07:30:02Z',
    completedAt: '2026-04-13T07:44:15Z',
    steps: DD_STEPS_SCHEMA_FAIL,
    local: true,
  },
  // Failed: DD variations (strict mode)
  {
    id: '6',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000789',
    recipientName: 'Mountain View MLS',
    providerUoi: 'T00000300',
    providerName: 'Vendor X',
    status: 'failed',
    scheduledAt: '2026-04-13T07:00:00Z',
    startedAt: '2026-04-13T07:00:04Z',
    completedAt: '2026-04-13T07:02:15Z',
    steps: DD_STEPS_VARIATIONS_FAIL,
    local: true,
  },
  // Failed: DD metadata parse error
  {
    id: '7',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000321',
    recipientName: 'Heartland AOR',
    providerUoi: 'T00000400',
    providerName: 'Legacy Systems Inc.',
    status: 'failed',
    scheduledAt: '2026-04-13T06:45:00Z',
    startedAt: '2026-04-13T06:45:01Z',
    completedAt: '2026-04-13T06:45:12Z',
    steps: DD_STEPS_METADATA_FAIL,
    local: true,
  },
  // Failed: DD connection timeout
  {
    id: '8',
    endorsement: 'Data Dictionary',
    version: '2.0',
    recipientUoi: 'M00000654',
    recipientName: 'Coastal Realty Board',
    providerUoi: 'T00000500',
    providerName: 'Offline Provider',
    status: 'failed',
    scheduledAt: '2026-04-13T06:30:00Z',
    startedAt: '2026-04-13T06:30:01Z',
    completedAt: '2026-04-13T06:30:32Z',
    steps: DD_STEPS_CONNECTION_FAIL,
    local: true,
  },
  // Failed: Core $filter not supported
  {
    id: '9',
    endorsement: 'Web API Core',
    version: '2.0.0',
    recipientUoi: 'M00000456',
    recipientName: 'State-Wide MLS',
    providerUoi: 'T00000210',
    providerName: 'Cotality',
    status: 'failed',
    scheduledAt: '2026-04-13T06:00:00Z',
    startedAt: '2026-04-13T06:00:03Z',
    completedAt: '2026-04-13T06:02:45Z',
    steps: CORE_STEPS_FILTER_FAIL,
    local: true,
  },
  // Failed: Add/Edit error response format
  {
    id: '10',
    endorsement: 'Web API Add/Edit',
    version: '2.0.0',
    recipientUoi: 'M00000789',
    recipientName: 'Mountain View MLS',
    providerUoi: 'T00000300',
    providerName: 'Vendor X',
    status: 'failed',
    scheduledAt: '2026-04-13T05:30:00Z',
    startedAt: '2026-04-13T05:30:02Z',
    completedAt: '2026-04-13T05:33:10Z',
    steps: ADDEDIT_STEPS_VALIDATION_FAIL,
    local: true,
  },
  // Failed: EntityEvent auth
  {
    id: '11',
    endorsement: 'EntityEvent',
    version: '2.0.0',
    recipientUoi: 'M00000321',
    recipientName: 'Heartland AOR',
    providerUoi: 'T00000400',
    providerName: 'Legacy Systems Inc.',
    status: 'failed',
    scheduledAt: '2026-04-13T05:00:00Z',
    startedAt: '2026-04-13T05:00:01Z',
    completedAt: '2026-04-13T05:00:04Z',
    steps: ENTITYEVENT_STEPS_AUTH_FAIL,
    local: true,
  },
  // Failed: EntityEvent no events produced
  {
    id: '12',
    endorsement: 'EntityEvent',
    version: '2.0.0',
    recipientUoi: 'M00000456',
    recipientName: 'State-Wide MLS',
    providerUoi: 'T00000210',
    providerName: 'Cotality',
    status: 'failed',
    scheduledAt: '2026-04-13T04:30:00Z',
    startedAt: '2026-04-13T04:30:02Z',
    completedAt: '2026-04-13T04:31:05Z',
    steps: ENTITYEVENT_STEPS_NO_EVENTS,
    local: true,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

import {
  JOB_STATUS_COLORS,
  STEP_STATUS_ICONS,
  STEP_STATUS_COLORS,
} from '../../constants/cert';
import type { StepStatus } from '../../constants/cert';

const statusColor = (status: JobStatus): string =>
  JOB_STATUS_COLORS[status as keyof typeof JOB_STATUS_COLORS] ?? 'text-gray-500 dark:text-gray-400';

const stepIcon = (status: JobStep['status']): string =>
  STEP_STATUS_ICONS[status as StepStatus] ?? '○';

const stepColor = (status: JobStep['status']): string =>
  STEP_STATUS_COLORS[status as StepStatus] ?? 'text-gray-400 dark:text-gray-500';

// ── Step pipeline visualization ─────────────────────────────────────

const StepPipeline = ({ steps }: { readonly steps: ReadonlyArray<JobStep> }) => (
  <div className="space-y-1.5">
    {steps.map((step, i) => (
      <div key={step.name} className="flex items-center gap-3">
        <span className={`text-sm font-mono w-4 text-center ${stepColor(step.status)}`}>
          {step.status === 'running' ? (
            <span className="inline-block animate-pulse">◉</span>
          ) : (
            stepIcon(step.status)
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between">
            <span className={`text-sm ${step.status === 'skipped' ? 'text-gray-400 dark:text-gray-600 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
              {step.name}
            </span>
            {step.duration && (
              <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2">
                {formatDuration(step.duration)}
              </span>
            )}
          </div>
          {step.detail && (
            <p className={`text-xs mt-0.5 ${step.status === 'failed' ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
              {step.detail}
            </p>
          )}
        </div>
        {/* Progress connector line */}
        {i < steps.length - 1 && (
          <div className="absolute left-[1.1rem] mt-6 w-px h-3 bg-gray-200 dark:bg-gray-700" />
        )}
      </div>
    ))}
  </div>
);

// ── Job card ────────────────────────────────────────────────────────

const JobCard = ({ job }: { readonly job: CertJob }) => {
  const [expanded, setExpanded] = useState(job.status === 'running');
  const [showSubmit, setShowSubmit] = useState(false);
  const [showFailure, setShowFailure] = useState(false);

  return (
    <div className={`bg-white dark:bg-gray-800/60 border rounded-xl overflow-hidden transition-colors ${
      job.status === 'running'
        ? 'border-blue-300 dark:border-blue-700'
        : job.status === 'failed'
        ? 'border-red-200 dark:border-red-800'
        : 'border-gray-200 dark:border-gray-700'
    }`}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {job.endorsement} {job.version}
              </h3>
              {job.local && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border-b border-dashed border-indigo-400 dark:border-indigo-500 cursor-help" title="Running from a local test runner">
                  Local
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {job.recipientName} · {job.providerName}
            </p>
            {job.status === 'failed' && job.error && (
              <p className="text-xs text-red-500 dark:text-red-400 mt-0.5 truncate">
                {job.error}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`text-xs font-semibold uppercase tracking-wider ${statusColor(job.status)}`}>
              {job.status}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {formatTime(job.scheduledAt)}
            </span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </div>
        </div>

        {/* Progress bar for running jobs */}
        {job.status === 'running' && (
          <div className="mt-3 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${(job.steps.filter(s => s.status === 'passed').length / job.steps.length) * 100}%` }}
            />
          </div>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-700/50 pt-3">
          <StepPipeline steps={job.steps} />

          {/* Actions */}
          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700/50">
            {job.status === 'running' && (
              <button type="button" className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 cursor-pointer transition-colors">
                Cancel Job
              </button>
            )}
            {job.status === 'scheduled' && (
              <button type="button" className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                Remove from Queue
              </button>
            )}
            {job.status === 'passed' && (
              <>
                <button type="button" className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
                  View Report
                </button>
                <NavLink to={`/cert/compare/${job.id}`} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                  Compare
                </NavLink>
                <button type="button" onClick={() => setShowSubmit(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 cursor-pointer transition-colors">
                  Submit to Cloud
                </button>
              </>
            )}
            {job.status === 'failed' && (
              <>
                <button type="button" onClick={() => setShowFailure(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
                  View Failure Report
                </button>
                <button type="button" className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                  Re-run
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Failure Report modal */}
      {showFailure && (
        <FailureReportModal
          endorsement={job.endorsement}
          version={job.version}
          recipientName={job.recipientName}
          failedStep={job.steps.find(s => s.status === 'failed')?.name ?? job.error}
          reports={job.reports}
          onClose={() => setShowFailure(false)}
        />
      )}

      {/* Submit to Cloud modal */}
      {showSubmit && (
        <SubmitToCloud
          job={{
            id: job.id,
            endorsement: job.endorsement,
            endorsementKey: 'dd',
            version: job.version,
            recipientUoi: job.recipientUoi,
            recipientName: job.recipientName,
            providerUoi: job.providerUoi,
            providerUsi: job.providerUoi,
            status: 'passed',
            steps: [],
            queuedAt: job.scheduledAt,
            local: job.local,
          }}
          onClose={() => setShowSubmit(false)}
        />
      )}
    </div>
  );
};

// ── Main page ───────────────────────────────────────────────────────

export const JobsPage = () => {
  const { jobs: liveJobs, start, cancel, clear } = useJobs();
  const [showNewJob, setShowNewJob] = useState(false);
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [search, setSearch] = useState('');
  const [endorsementFilter, setEndorsementFilter] = useState<string>('all');

  // Convert live jobs to the CertJob shape used by JobCard
  const liveAsCertJobs: ReadonlyArray<CertJob> = useMemo(() =>
    liveJobs.map(j => ({
      id: j.id,
      endorsement: j.endorsement,
      version: j.version,
      recipientUoi: j.recipientUoi,
      recipientName: j.recipientName,
      providerUoi: j.providerUoi,
      providerName: j.providerUsi || j.providerUoi,
      status: (j.status === 'queued' ? 'scheduled' : j.status) as JobStatus,
      scheduledAt: j.queuedAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      steps: j.steps.map(s => ({ name: s.name, status: s.status, duration: s.duration, detail: s.detail })),
      local: j.local,
      reports: j.reports,
      error: j.error,
    })),
  [liveJobs]);

  const allJobs = liveAsCertJobs;

  const endorsements = useMemo(() => {
    const set = new Set(allJobs.map(j => j.endorsement));
    return ['all', ...Array.from(set).sort()];
  }, [allJobs]);

  const filteredJobs = useMemo(() => {
    const query = search.toLowerCase();
    return allJobs.filter(j => {
      if (filter !== 'all' && j.status !== filter) return false;
      if (endorsementFilter !== 'all' && j.endorsement !== endorsementFilter) return false;
      if (query) {
        const searchable = [j.recipientName, j.providerName, j.endorsement, j.recipientUoi, j.providerUoi].join(' ').toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });
  }, [allJobs, filter, search, endorsementFilter]);

  const counts = {
    all: allJobs.length,
    scheduled: allJobs.filter(j => j.status === 'scheduled').length,
    running: allJobs.filter(j => j.status === 'running').length,
    passed: allJobs.filter(j => j.status === 'passed').length,
    failed: allJobs.filter(j => j.status === 'failed').length,
    cancelled: allJobs.filter(j => j.status === 'cancelled').length,
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className={`${PAGE_CONTAINER} pt-6 pb-20`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
              Certification Jobs
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Run certification tests, monitor progress, and review results.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewJob(true)}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
          >
            New Test Run
          </button>
        </div>

        {/* Config builder */}
        {showNewJob && (
          <div className="mb-6">
            <ConfigBuilder
              onClose={() => setShowNewJob(false)}
              onStart={(config) => { start(config); setShowNewJob(false); }}
            />
          </div>
        )}

        {/* Search and filters */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search recipient, provider, UOI..." />
          <div className="flex items-center gap-1">
            {(['all', 'running', 'scheduled', 'passed', 'failed'] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {counts[f] > 0 && (
                  <span className={`tabular-nums ${filter === f ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
                    ({counts[f]})
                  </span>
                )}
              </button>
            ))}
          </div>
          <select
            value={endorsementFilter}
            onChange={e => setEndorsementFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer"
          >
            {endorsements.map(e => (
              <option key={e} value={e}>{e === 'all' ? 'All Endorsements' : e}</option>
            ))}
          </select>
        </div>

        {/* Job list */}
        <div className="space-y-3">
          {filteredJobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
          {filteredJobs.length === 0 && (
            <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No {filter === 'all' ? '' : filter + ' '}jobs to show.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
