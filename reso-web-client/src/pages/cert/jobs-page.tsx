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

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { StatusPill } from '../../components/cert/status-pill';
import { ReplicationProgress, parseReplicationProgress } from '../../components/cert/replication-progress';
import { RequestDetailsPanel } from '../../components/cert/request-details';
import { SearchInput } from '../../components/metadata/shared';
import { ConfigBuilder } from '../../components/cert/config-builder';
import { SubmitToCloud } from '../../components/cert/submit-to-cloud';
import { FailureReportModal } from '../../components/cert/error-reports';
import { useJobs } from '../../hooks/use-jobs';
import { useReportRef } from '../../hooks/use-report-ref';
import { useOrganizationNames } from '../../hooks/use-organization-names';
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
  readonly startedAt?: number;
  readonly detail?: string;
  readonly requestDetails?: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
    readonly responseBody?: string;
  }>;
  readonly artifacts?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
}

interface CertJob {
  readonly id: string;
  readonly endorsement: string;
  readonly version: string;
  readonly recipientUoi: string;
  readonly recipientName: string;
  readonly providerUoi: string;
  readonly providerUsi?: string;
  readonly providerName: string;
  readonly status: JobStatus;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly steps: ReadonlyArray<JobStep>;
  readonly local: boolean;
  readonly reports?: Record<string, string>;
  readonly error?: string;
  readonly sdkConfig?: Record<string, unknown>;
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

/** Live-ticking timer for running steps. */
const LiveTimer = ({ startTime }: { readonly startTime: number }) => {
  const [elapsed, setElapsed] = useState(Date.now() - startTime);
  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - startTime), 100);
    return () => clearInterval(interval);
  }, [startTime]);
  return <span className="text-xs text-blue-400 dark:text-blue-500 tabular-nums ml-2">{formatDuration(elapsed)}</span>;
};

import { DetailText } from '../../components/cert/detail-text';

import {
  JOB_STATUS_COLORS,
  STEP_STATUS_ICONS,
  STEP_STATUS_COLORS,
} from '../../constants/cert';
import { STEP_TOOLTIPS, humanizeScenarioName } from '../../constants/cert';
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
            <span
              className={`text-sm ${step.status === 'skipped' ? 'text-gray-400 dark:text-gray-600 line-through' : 'text-gray-900 dark:text-gray-100'}`}
              title={STEP_TOOLTIPS[step.name]}
            >
              {step.name}
            </span>
            {step.status === 'running' && step.startedAt != null ? (
              <LiveTimer startTime={step.startedAt} />
            ) : (
              step.duration != null && step.duration > 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums ml-2">
                  {formatDuration(step.duration)}
                </span>
              )
            )}
          </div>
          {step.detail && (() => {
            const replicationData = parseReplicationProgress(step.detail);
            if (replicationData) return <ReplicationProgress data={replicationData} />;
            return (
              <DetailText text={step.detail} className={`text-xs mt-0.5 ${step.status === 'failed' ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`} />
            );
          })()}
        </div>
      </div>
    ))}
  </div>
);

// ── Job card ────────────────────────────────────────────────────────

const JobCard = ({ job, onRerun, onDelete, onClone, onCancel, highlighted }: { readonly job: CertJob; readonly onRerun?: () => void; readonly onDelete?: () => void; readonly onClone?: () => void; readonly onCancel?: () => void; readonly highlighted?: boolean }) => {
  const [expanded, setExpanded] = useState(job.status === 'running' || !!highlighted);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted]);
  const [showSubmit, setShowSubmit] = useState(false);
  const [showFailure, setShowFailure] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();

  // Resolve report refs lazily when the compliance modal opens.
  const jobReports = job.reports as Record<string, string> | undefined;
  const reportDetailedRef = useReportRef<Record<string, unknown>>(showReport ? jobReports?.reportDetailed : undefined);
  const reportRef = useReportRef<Record<string, unknown>>(showReport ? jobReports?.report : undefined);

  // Close any open modal on Escape
  useEffect(() => {
    const anyOpen = showSubmit || showFailure || showReport || confirmDelete;
    if (!anyOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSubmit(false);
        setShowFailure(false);
        setShowReport(false);
        setConfirmDelete(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSubmit, showFailure, showReport, confirmDelete]);

  return (
    <div ref={cardRef} id={`job-${job.id}`} className={`bg-white dark:bg-gray-800/60 border rounded-xl overflow-hidden transition-all ${
      highlighted
        ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-300 dark:ring-blue-700'
        : job.status === 'running'
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
              {job.recipientName}
              {job.providerName && <span className="text-gray-400 dark:text-gray-500"> · {job.providerName}</span>}
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
            {job.status === 'running' && onCancel && (
              <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 cursor-pointer transition-colors">
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
                <button type="button" onClick={() => setShowReport(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
                  View Report
                </button>
                <NavLink to={`/cert/compare/${job.id}`} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                  Compare
                </NavLink>
                <button type="button" onClick={() => setShowSubmit(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 cursor-pointer transition-colors">
                  Submit to RESO
                </button>
                {job.steps.some(s => s.name.toLowerCase().includes('variation') && s.status === 'failed') && (
                  <NavLink to="/cert/variations" state={{ job }} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 cursor-pointer transition-colors">
                    Review Variations
                  </NavLink>
                )}
                {onRerun && (
                  <button type="button" onClick={onRerun} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                    Re-run
                  </button>
                )}
                {onClone && (
                  <button type="button" onClick={onClone} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors" title="Edit config and re-run">
                    Edit
                  </button>
                )}
              </>
            )}
            {job.status === 'failed' && (
              <>
                <button type="button" onClick={() => setShowFailure(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
                  View Failure Report
                </button>
                {job.steps.some(s => s.name.toLowerCase().includes('variation') && s.status === 'failed') && (
                  <NavLink to="/cert/variations" state={{ job }} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 cursor-pointer transition-colors">
                    Review Variations
                  </NavLink>
                )}
                {onRerun && (
                  <button type="button" onClick={onRerun} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                    Re-run
                  </button>
                )}
                {onClone && (
                  <button type="button" onClick={onClone} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors" title="Edit config and re-run">
                    Edit
                  </button>
                )}
              </>
            )}

            {/* Delete — available on all completed local jobs */}
            {onDelete && (job.status === 'passed' || job.status === 'failed') && (
              confirmDelete ? (
                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-xs text-red-500 dark:text-red-400">Delete results?</span>
                  <button type="button" onClick={() => { onDelete(); setConfirmDelete(false); }} className="px-2 py-1 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors">
                    Yes
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-xs font-medium rounded bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="p-1.5 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 cursor-pointer transition-colors ml-auto"
                  title="Delete results"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                  </svg>
                </button>
              )
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
          steps={job.steps}
          onClose={() => setShowFailure(false)}
          onReviewVariations={() => navigate('/cert/variations', { state: { job } })}
        />
      )}

      {/* Compliance Report modal (passed jobs) */}
      {showReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Compliance Report
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {job.endorsement} {job.version} — {job.recipientName}
                  <span className="ml-2 text-green-600 dark:text-green-400">Passed</span>
                </p>
              </div>
              <button type="button" onClick={() => setShowReport(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-2">
              {(reportDetailedRef.loading || reportRef.loading) && (
                <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-4">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                  Loading report data...
                </div>
              )}
              {(reportDetailedRef.missing || reportRef.missing) && !(reportDetailedRef.loading || reportRef.loading) && (
                <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300">
                  One or more report files are missing from disk. They may have been deleted outside the app. Re-run the job to regenerate them.
                </div>
              )}
              {!(reportDetailedRef.loading || reportRef.loading) && !(reportDetailedRef.missing || reportRef.missing) && (
                job.steps.length > 0 ? (
                  job.steps.map((step, i) => {
                    const detailed = reportDetailedRef.data;
                    const resourceReports = (detailed?.resourceReports ?? []) as ReadonlyArray<Record<string, unknown>>;
                    const isScenarioStep = step.name.includes('Run ') && step.name.includes('scenarios');
                    const hasScenarios = isScenarioStep && resourceReports.length > 0;

                    return (
                      <ReportStepCard
                        key={i}
                        step={step}
                        scenarios={hasScenarios ? resourceReports : undefined}
                      />
                    );
                  })
                ) : (
                  <div className="text-sm text-gray-600 dark:text-gray-300 py-4 space-y-2">
                    {(() => {
                      const remarks = (reportRef.data?.remarks ?? reportDetailedRef.data?.remarks) as string | undefined;
                      return remarks
                        ? <p>{remarks}</p>
                        : <p className="text-gray-400 dark:text-gray-500 text-center">No step details available. Run the test again to capture step-by-step results.</p>;
                    })()}
                  </div>
                )
              )}
            </div>
            <div className="flex items-center justify-between p-5 border-t border-gray-200 dark:border-gray-700 shrink-0">
              {(reportDetailedRef.data || reportRef.data) && (
                <button
                  type="button"
                  onClick={() => {
                    // Prefer the detailed report; fall back to the summary report.
                    const payload = reportDetailedRef.data ?? reportRef.data;
                    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${job.endorsement.toLowerCase().replace(/\s+/g, '-')}-${job.version}-report.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                  </svg>
                  Download Report
                </button>
              )}
              <button type="button" onClick={() => setShowReport(false)} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit to RESO modal */}
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

// ── Report step card (expandable for scenario steps) ────────────────

const ReportStepCard = ({
  step,
  scenarios,
}: {
  readonly step: { name: string; status: string; detail?: string; duration?: number; requestDetails?: ReadonlyArray<{ method: string; url: string; status?: number; error?: string; responseBody?: string }>; artifacts?: ReadonlyArray<{ label: string; path: string }> };
  readonly scenarios?: ReadonlyArray<Record<string, unknown>>;
}) => {
  const [expanded, setExpanded] = useState(false);
  const hasScenarios = scenarios && scenarios.length > 0;

  return (
    <div className="bg-gray-50 dark:bg-gray-800/40 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => hasScenarios && setExpanded(!expanded)}
        className={`w-full text-left p-3 flex items-center justify-between ${hasScenarios ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/40' : ''} transition-colors`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${step.status === 'passed' ? 'text-green-600 dark:text-green-400' : step.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
              {step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '○'}
            </span>
            <span
              className="text-sm font-medium text-gray-900 dark:text-gray-100"
              title={STEP_TOOLTIPS[step.name]}
            >
              {step.name}
            </span>
            {hasScenarios && (
              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            )}
          </div>
          {step.detail && (() => {
            const replicationData = parseReplicationProgress(step.detail);
            if (replicationData) return <div className="ml-6"><ReplicationProgress data={replicationData} /></div>;
            return <DetailText text={step.detail} className="text-xs mt-0.5 ml-6 text-gray-500 dark:text-gray-400" />;
          })()}
          {step.requestDetails && step.requestDetails.length > 0 && (
            <div className="ml-6"><RequestDetailsPanel details={step.requestDetails} /></div>
          )}
          {step.artifacts && step.artifacts.length > 0 && (
            <div className="ml-6 mt-1 flex items-center gap-2 flex-wrap">
              {step.artifacts.map((a, ai) => (
                <button
                  key={ai}
                  type="button"
                  onClick={() => {
                    // Read file via fetch through the proxy (local files served by the reference server)
                    // or trigger a save dialog via IPC
                    const el = (window as unknown as Record<string, unknown>).certRunner as Record<string, unknown> | undefined;
                    if (el?.openFile) {
                      (el.openFile as (path: string) => void)(a.path);
                    } else {
                      // Fallback: copy path to clipboard
                      navigator.clipboard.writeText(a.path);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                  title={`Download ${a.label} (${a.path})`}
                >
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                  </svg>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {step.duration != null && step.duration > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums shrink-0">
            {step.duration < 1000 ? `${step.duration}ms` : `${(step.duration / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>

      {expanded && hasScenarios && (
        <div className="border-t border-gray-200 dark:border-gray-700/50 px-3 pb-3 pt-2 ml-9 space-y-1.5">
          {scenarios.flatMap(r => {
            const resource = (r.resource as string) ?? '';
            const scenarioList = (r.scenarios as ReadonlyArray<Record<string, unknown>>) ?? [];
            return scenarioList.map((s, si) => {
              const name = ((s.name ?? s.scenario) as string) ?? 'Unknown';
              const passed = s.passed === true;
              const skipped = s.skipped === true;
              return (
                <div key={`${resource}-${si}`} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className={passed ? 'text-green-500' : skipped ? 'text-gray-400' : 'text-red-500'}>
                      {passed ? '✓' : skipped ? '–' : '✗'}
                    </span>
                    <span className={`${skipped ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
                      {resource}: {humanizeScenarioName(name)}
                    </span>
                  </div>
                  {s.duration != null && (s.duration as number) > 0 && (
                    <span className="text-gray-400 dark:text-gray-500 tabular-nums">
                      {(s.duration as number) < 1000 ? `${s.duration}ms` : `${((s.duration as number) / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </div>
              );
            });
          })}
        </div>
      )}
    </div>
  );
};

// ── Main page ───────────────────────────────────────────────────────

export const JobsPage = () => {
  const { jobs: liveJobs, start, cancel, clear, rerun, remove, removeAll } = useJobs();
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const { lookup, lookupSystem } = useOrganizationNames();
  const location = useLocation();
  const [highlightedJobId, setHighlightedJobId] = useState<string | null>(location.hash?.replace('#job-', '') || null);

  // Auto-clear highlight after scroll completes
  useEffect(() => {
    if (!highlightedJobId) return;
    const timer = setTimeout(() => setHighlightedJobId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedJobId]);
  const [showNewJob, setShowNewJob] = useState(false);

  // Track loaded config identity for Save vs. Save As
  const [loadedConfigId, setLoadedConfigId] = useState<string | null>(null);
  const [loadedConfigName, setLoadedConfigName] = useState<string | null>(null);
  const [configRefreshKey, setConfigRefreshKey] = useState(0);

  // Open config builder with a loaded config from dashboard/configs page navigation
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null;
    const loadConfig = state?.loadConfig as Record<string, unknown> | undefined;
    if (loadConfig) {
      setClonedConfig(loadConfig as unknown as BatchConfig);
      setLoadedConfigId((state?.configId as string) ?? null);
      setLoadedConfigName((state?.configName as string) ?? null);
      setShowNewJob(true);
      // Clear the state so refresh doesn't re-trigger
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  const [clonedConfig, setClonedConfig] = useState<BatchConfig | undefined>(undefined);

  // Check for autosaved draft on mount
  const [draftBanner, setDraftBanner] = useState<{ config: BatchConfig; configId: string | null; configName: string | null; savedAt: string } | null>(null);
  useEffect(() => {
    // Don't check for draft if we already have a config loaded (from navigation state)
    if (showNewJob) return;
    import('../../services/connection-manager').then(({ loadDraft, clearDraft }) =>
      loadDraft().then(draft => {
        if (draft?.config) setDraftBanner({ config: draft.config as BatchConfig, configId: draft.configId, configName: draft.configName, savedAt: draft.savedAt });
      })
    ).catch(() => {});
  }, []);

  const handleClone = (job: CertJob) => {
    const sdk = (job.sdkConfig ?? {}) as Record<string, unknown>;
    const server = (sdk.server ?? {}) as Record<string, unknown>;
    const endorsementKey = (sdk.endorsement as string) ?? 'dd';

    const config: BatchConfig = {
      providerUoi: (sdk.providerUoi as string) ?? job.providerUoi ?? '',
      concurrency: 1,
      recipients: [{
        id: crypto.randomUUID(),
        description: '',
        serviceRootUri: (server.url as string) ?? '',
        recipientUoi: job.recipientUoi,
        providerUsi: job.providerUsi ?? '',
        endorsements: [endorsementKey] as BatchConfig['recipients'][0]['endorsements'],
        auth: (server.auth as BatchConfig['recipients'][0]['auth']) ?? { mode: 'token' as const, authToken: '' },
        ddOptions: {
          version: ((sdk.version as string) ?? '2.0') as '1.7' | '2.0' | '2.1',
          strictMode: sdk.strictMode as boolean | undefined,
          batchExpand: sdk.batchExpand as boolean | undefined,
          requestDelay: sdk.requestDelay as number | undefined,
          rateLimitWait: sdk.rateLimitWait as number | undefined,
          limit: sdk.limit as number | undefined,
        },
        coreOptions: {
          version: ((sdk.version as string) ?? '2.0.0') as '2.0.0' | '2.1.0',
          enumMode: ((sdk.enumMode as string) ?? 'auto') as 'auto' | 'string' | 'isflags' | 'collections',
        },
        addEditOptions: { resource: (sdk.resource as string) ?? 'Property' },
        entityEventOptions: {
          mode: ((sdk.mode as string) ?? 'observe') as 'observe' | 'full',
          writableResource: sdk.writableResource as string | undefined,
        },
      }],
    };
    setClonedConfig(config);
    setShowNewJob(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
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
      recipientName: lookup(j.recipientUoi) ?? j.recipientName,
      providerUoi: j.providerUoi,
      providerName: (() => {
        const name = lookup(j.providerUoi) ?? j.providerUoi;
        const sys = lookupSystem(j.providerUoi, j.providerUsi);
        return sys ? `${name} / ${sys}` : name;
      })(),
      status: (j.status === 'queued' ? 'scheduled' : j.status) as JobStatus,
      scheduledAt: j.queuedAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      steps: j.steps.map(s => ({ name: s.name, status: s.status, duration: s.duration, detail: s.detail, requestDetails: s.requestDetails, artifacts: s.artifacts })),
      local: j.local,
      reports: j.reports,
      error: j.error,
      sdkConfig: j.sdkConfig,
      providerUsi: j.providerUsi,
    })),
  [liveJobs]);

  const allJobs = liveAsCertJobs;

  const endorsements = useMemo(() => {
    const set = new Set(allJobs.map(j => j.endorsement));
    return ['all', ...Array.from(set).sort()];
  }, [allJobs]);

  const filteredJobs = useMemo(() => {
    const query = search.toLowerCase();
    return allJobs
      .filter(j => {
        if (filter !== 'all' && j.status !== filter) return false;
        if (endorsementFilter !== 'all' && j.endorsement !== endorsementFilter) return false;
        if (query) {
          const searchable = [j.recipientName, j.providerName, j.endorsement, j.recipientUoi, j.providerUoi].join(' ').toLowerCase();
          if (!searchable.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Running/scheduled always float to top
        const isActiveA = a.status === 'running' || a.status === 'scheduled';
        const isActiveB = b.status === 'running' || b.status === 'scheduled';
        if (isActiveA && !isActiveB) return -1;
        if (!isActiveA && isActiveB) return 1;
        // Otherwise sort by timestamp descending (most recent first)
        const aTime = new Date(a.completedAt ?? a.startedAt ?? a.scheduledAt).getTime();
        const bTime = new Date(b.completedAt ?? b.startedAt ?? b.scheduledAt).getTime();
        return bTime - aTime;
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
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
        <div className={`${PAGE_CONTAINER} pt-6 pb-4`}>
          <div className="flex items-center justify-between mb-4">
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
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors shrink-0"
            >
              New Test Run
            </button>
          </div>

          {/* Search and filters */}
          <div className="flex items-center gap-3 flex-wrap">
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
          {liveJobs.length > 0 && (
            <div className="relative ml-auto">
              <button
                type="button"
                onClick={() => setConfirmDeleteAll(!confirmDeleteAll)}
                className="p-1.5 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 cursor-pointer transition-colors"
                title="Delete all local results"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                </svg>
              </button>
              {confirmDeleteAll && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg p-4 z-20">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Delete all local results?</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                    This will permanently remove all local certification test results from disk. This action cannot be undone.
                  </p>
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteAll(false)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => { removeAll(); setConfirmDeleteAll(false); }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors"
                    >
                      Delete All
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Content below sticky header */}
      <div className={`${PAGE_CONTAINER} pb-20`}>
        {/* Draft restore banner */}
        {draftBanner && !showNewJob && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg flex items-center justify-between">
            <div className="text-sm text-blue-800 dark:text-blue-300">
              <span className="font-medium">Work in progress found</span>
              {draftBanner.configName && <span> — {draftBanner.configName}</span>}
              <span className="text-xs text-blue-600 dark:text-blue-400 ml-2">
                {new Date(draftBanner.savedAt).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              <button
                type="button"
                onClick={() => {
                  setClonedConfig(draftBanner.config);
                  setLoadedConfigId(draftBanner.configId);
                  setLoadedConfigName(draftBanner.configName);
                  setShowNewJob(true);
                  setDraftBanner(null);
                  import('../../services/connection-manager').then(({ clearDraft }) => clearDraft()).catch(() => {});
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Restore
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftBanner(null);
                  import('../../services/connection-manager').then(({ clearDraft }) => clearDraft()).catch(() => {});
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500 cursor-pointer"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Config builder */}
        {showNewJob && (
          <div className="mb-6">
            <ConfigBuilder
              onClose={() => { setShowNewJob(false); setClonedConfig(undefined); setLoadedConfigId(null); setLoadedConfigName(null); }}
              onStart={(config) => {
                const created = start(config);
                setShowNewJob(false);
                setClonedConfig(undefined);
                setLoadedConfigId(null);
                setLoadedConfigName(null);
                if (created.length > 0) {
                  setHighlightedJobId(created[0].id);
                  setTimeout(() => {
                    const el = document.getElementById(`job-${created[0].id}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }, 100);
                }
              }}
              onSave={async (config, existingId, name) => {
                const { saveConnection, saveProfile, storeCredentials, findConnectionByKey } = await import('../../services/connection-manager');
                const recipient = config.recipients[0];
                if (!recipient) return;

                const configName = name ?? `${config.providerUoi} – ${recipient.recipientUoi} – ${recipient.endorsements.map(e => e === 'dd' ? 'DD' : e).join(', ')}`;

                // Save or reuse credentials
                let credentialsId: string | null = null;
                if (recipient.serviceRootUri) {
                  const existing = await findConnectionByKey(
                    recipient.serviceRootUri,
                    recipient.auth.mode,
                    recipient.auth.mode === 'client_credentials' ? recipient.auth.clientId : undefined,
                    recipient.auth.mode === 'token' ? recipient.description : undefined
                  );
                  if (existing) {
                    credentialsId = existing.id;
                  } else {
                    const conn = await saveConnection({
                      name: recipient.description || recipient.serviceRootUri,
                      url: recipient.serviceRootUri,
                      authMode: recipient.auth.mode,
                      clientId: recipient.auth.mode === 'client_credentials' ? recipient.auth.clientId : undefined,
                      tokenUrl: recipient.auth.mode === 'client_credentials' ? recipient.auth.tokenUrl : undefined,
                      scope: recipient.auth.mode === 'client_credentials' ? recipient.auth.scope : undefined,
                    });
                    credentialsId = conn.id;
                  }
                  // Store credentials in safeStorage
                  const creds = recipient.auth.mode === 'token'
                    ? { authToken: recipient.auth.authToken }
                    : { clientSecret: recipient.auth.clientSecret };
                  if (credentialsId && (creds.authToken || creds.clientSecret)) {
                    await storeCredentials(credentialsId, creds);
                  }
                }

                // Save cert config
                const saved = await saveProfile({
                  id: existingId,
                  name: configName,
                  credentialsId,
                  providerUoi: config.providerUoi,
                  providerUsi: recipient.providerUsi,
                  recipientUoi: recipient.recipientUoi,
                  endorsements: [...recipient.endorsements],
                  ddVersion: recipient.ddOptions?.version,
                  strictMode: recipient.ddOptions?.strictMode,
                  limit: recipient.ddOptions?.limit,
                  requestDelay: recipient.ddOptions?.requestDelay,
                  rateLimitWait: recipient.ddOptions?.rateLimitWait,
                  batchExpand: recipient.ddOptions?.batchExpand,
                });
                setLoadedConfigId(saved.id);
                setLoadedConfigName(saved.name);
                setConfigRefreshKey(k => k + 1);
              }}
              initialConfig={clonedConfig}
              savedConfigId={loadedConfigId}
              savedConfigName={loadedConfigName}
              refreshKey={configRefreshKey}
            />
          </div>
        )}

        {/* Job list */}
        <div className="space-y-3">
          {filteredJobs.map(job => (
            <JobCard key={job.id} job={job} onRerun={job.local ? () => {
              rerun(job.id).then(newId => {
                if (newId) {
                  setHighlightedJobId(newId);
                  setTimeout(() => {
                    const el = document.getElementById(`job-${newId}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }, 100);
                }
              });
            } : undefined} onDelete={job.local ? () => remove(job.id) : undefined} onCancel={() => cancel(job.id)} onClone={() => handleClone(job)} highlighted={job.id === highlightedJobId} />
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
