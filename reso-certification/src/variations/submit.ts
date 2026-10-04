/**
 * Submit a variations report to the Variations Service.
 *
 * This is the SHARED path. The CLI calls it, and the desktop is meant to call the same function
 * rather than keeping its own copy -- a second implementation of this logic is exactly how the
 * report-id hash ended up duplicated across two repositories with a drift hazard nobody noticed.
 * Presentation differs per surface; the semantics live here.
 *
 * NO PROMPTING, NO TTY AWARENESS. Confirmation is a parameter. A caller decides how consent was
 * obtained -- a terminal prompt, a dialog, or an explicit flag -- and this function behaves
 * identically whichever it was. That matters because the alternative is a command that does
 * different things depending on where it runs, which is how automation quietly performs the
 * destructive act a human would have been warned about.
 *
 * THE REPORT'S IDENTITY IS NOT OURS TO MINT. The service issues `variationsReportId` on a first push
 * and returns the stored one thereafter, so this sends none and reports back whatever came. The
 * alternative -- deriving it here -- would require this implementation and the service's to agree
 * byte-for-byte forever, because the service builds `endorsementId` from it and scopes the pool
 * sweep by that. A one-character divergence means a push addresses a different endorsement and the
 * replace silently fails to replace.
 *
 * PUSHING A REPORT IS STARTING A REVIEW. The same request writes the review rows, so there is no
 * separate "start review" step to call first.
 */

import { readFile } from 'node:fs/promises';
import { lockedError, mintProviderToken, serviceError } from '../sdk/common.js';
import type { LockHolderInfo } from '../sdk/common.js';

const REPORT_ROUTE = '/v2/certification/variations-reports';

export interface SubmitVariationsReportInput {
  /** Path to the `variations-report.json` a DD run produced. */
  readonly reportPath?: string;
  /** The report body, when the caller already holds it. Takes precedence over `reportPath`. */
  readonly report?: Record<string, unknown>;
  /** A session token (desktop/UI). Absent on the CLI, which mints from `.env`. */
  readonly bearerToken?: string;
  /** Shapes the auth-failure wording: a CLI user fixes `.env`, a UI user logs in again. */
  readonly fromCli?: boolean;
  /**
   * Proceed over an existing pending review.
   *
   * This is CONSENT, not a mode. It never overrides a lock: a lock means somebody is actively
   * working, and no flag on a stateless call outranks that. It covers a pending review with no lock
   * and nothing more.
   */
  readonly overwrite?: boolean;
  /** Report what would happen and write nothing. */
  readonly dryRun?: boolean;
}

export interface SubmitVariationsReportResult {
  /** The identity the service issued or confirmed. Print it; it is the user's handle. */
  readonly variationsReportId?: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly version: string;
  /** How many changes the report carried. */
  readonly changeCount: number;
  /** True when nothing was sent because `dryRun` was set. */
  readonly dryRun: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const resolveServicesUrl = (): string => {
  const servicesUrl = process.env.RESO_SERVICES_URL;
  if (!servicesUrl) throw serviceError('SERVICE_ERROR', 'Variations Service: RESO_SERVICES_URL is not set.');
  return servicesUrl;
};

const resolveToken = async (input: SubmitVariationsReportInput, what: string): Promise<string> => {
  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli
        ? `${what} requires authentication. Set TOKEN_URI, CLIENT_ID and CLIENT_SECRET (or CERT_AUTH_API_BASE_URL, CERT_AUTH_API_USERNAME and CERTIFICATION_API_KEY) in your .env so the CLI can mint a provider token.`
        : `${what} requires authentication. Pass a provider token (bearerToken) — e.g. the session token from logging in.`
    );
  }
  return token;
};

/** The four coordinates the route is addressed by, read off the report itself. */
const coordinatesOf = (
  report: Record<string, unknown>
): { version: string; providerUoi: string; providerUsi: string; recipientUoi: string } => {
  const version = typeof report.version === 'string' ? report.version : '';
  const providerUoi = typeof report.providerUoi === 'string' ? report.providerUoi : '';
  const providerUsi = typeof report.providerUsi === 'string' ? report.providerUsi : '';
  const recipientUoi = typeof report.recipientUoi === 'string' ? report.recipientUoi : '';

  const missing = Object.entries({ version, providerUoi, providerUsi, recipientUoi })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw serviceError(
      'SERVICE_ERROR',
      `The report is missing ${missing.join(', ')}. A variations report produced by a DD run carries all four; this file may be the wrong artifact.`
    );
  }
  return { version, providerUoi, providerUsi, recipientUoi };
};

const lockFrom = (body: unknown): LockHolderInfo | undefined => {
  if (!isRecord(body) || !isRecord(body.lock)) return undefined;
  const { displayName, email, expiresAt, heldByProviderUoi } = body.lock;
  if (typeof displayName !== 'string' || typeof email !== 'string' || typeof expiresAt !== 'string') return undefined;
  return { displayName, email, expiresAt, ...(typeof heldByProviderUoi === 'string' ? { heldByProviderUoi } : {}) };
};

/**
 * Submit the report, or report what submitting would do.
 *
 * A fresh run is a COMPLETE report, so this is a full replace of whatever is on record. That is the
 * destructive shape the service's lock gate guards, which is why `overwrite` exists and why it
 * cannot reach past a lock.
 */
export const submitVariationsReportViaService = async (input: SubmitVariationsReportInput): Promise<SubmitVariationsReportResult> => {
  const what = 'Submitting the variations report';

  if (!input.report && !input.reportPath) {
    throw serviceError('SERVICE_ERROR', `${what} needs either a report body or a path to one.`);
  }

  const report = input.report ?? (JSON.parse(await readFile(input.reportPath as string, 'utf8')) as Record<string, unknown>);

  if (!isRecord(report)) throw serviceError('SERVICE_ERROR', `${what} failed: the report is not an object.`);

  const { version, providerUoi, providerUsi, recipientUoi } = coordinatesOf(report);
  const changes = Array.isArray(report.changes) ? report.changes : [];

  if (input.dryRun) {
    // Nothing is sent. Deliberately not a HEAD or a probe either: a dry run that touched the service
    // would be a different operation from the one it claims to preview.
    return { providerUoi, providerUsi, recipientUoi, version, changeCount: changes.length, dryRun: true };
  }

  const servicesUrl = resolveServicesUrl();
  const token = await resolveToken(input, what);

  const url = `${servicesUrl}${REPORT_ROUTE}/${encodeURIComponent(version)}/${encodeURIComponent(providerUoi)}/${encodeURIComponent(providerUsi)}/${encodeURIComponent(recipientUoi)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // `replaceReviewRows` declares the full replace explicitly. Its ABSENCE means a delta, so an
    // omission is the safe reading rather than the destructive one -- and a fresh run is never a
    // delta, so saying so is correct and not merely cautious.
    //
    // No `variationsReportId` is sent: the service issues it. See the file header.
    body: JSON.stringify({ ...report, replaceReviewRows: true })
  });

  if (response.status === 401 || response.status === 403) {
    throw serviceError(
      'AUTH_REJECTED',
      input.fromCli
        ? `${what}: the provider token was rejected. Re-check your .env credentials.`
        : `${what}: your session token was rejected or has expired. Log in again to continue.`
    );
  }

  if (response.status === 409) {
    // Somebody is actively reviewing. No flag overrides this, by design: `overwrite` covers a
    // pending review with no lock, and a lock that a stateless call could clear would not be a lock.
    const body = await response.json().catch(() => undefined);
    const lock = lockFrom(body);
    const who = lock ? `${lock.displayName} (${lock.email})` : 'another user';
    const until = lock ? `, until ${lock.expiresAt}` : '';
    throw lockedError(
      `${what} was refused: this report is locked for review by ${who}${until}. Submitting would replace what they have open. Ask them to release it, or ask an administrator to clear it.`,
      lock
    );
  }

  if (response.status === 503) {
    throw serviceError(
      'SERVICE_ERROR',
      `${what} was refused: the service could not verify whether this report is being reviewed, so it wrote nothing. This is not a problem with your report — retry shortly.`
    );
  }

  if (!response.ok) {
    // Include the service's own message. A bare status is not enough to act on: a 404 from the
    // gateway (no such route) and a 404 from the handler (unknown route) look identical otherwise,
    // and they need completely different fixes.
    const detail = await response.text().catch(() => '');
    const trimmed = detail.trim().slice(0, 300);
    throw serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}${trimmed ? ` — ${trimmed}` : ''}`);
  }

  const body: unknown = await response.json().catch(() => undefined);
  const variationsReportId = isRecord(body) && typeof body.variationsReportId === 'string' ? body.variationsReportId : undefined;

  return {
    ...(variationsReportId ? { variationsReportId } : {}),
    providerUoi,
    providerUsi,
    recipientUoi,
    version,
    changeCount: changes.length,
    dryRun: false
  };
};
