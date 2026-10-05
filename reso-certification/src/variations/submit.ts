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
import type { Decision, DecisionAction } from './decisions.js';

const REPORT_ROUTE = '/v2/certification/variations-reports';
const DECISIONS_ROUTE = '/v2/certification/save-variation-decisions';

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

/** The two auth fields both write paths carry. Structural, so `resolveToken` serves either input. */
interface ServiceAuthInput {
  readonly bearerToken?: string;
  readonly fromCli?: boolean;
}

const resolveToken = async (input: ServiceAuthInput, what: string): Promise<string> => {
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

// ── Decisions on a review already open ──────────────────────────────────────
//
// The second half of the flow above. The report push starts the review and writes the pool rows
// as `pending`; this records what the reviewer decided about individual items.
//
// IT IS NOT A SECOND SUBMISSION. The report route takes the whole report and replaces the rows;
// this route takes a list of per-item decisions and leaves everything it does not name alone.
//
// EVERY ACTION HERE FANS OUT ACROSS ORGANIZATIONS, which is why the service requires admin or
// FT-admin authority on it. The canonical store holds one winner per variation key, so deciding a
// key decides it for every provider that flagged it. A provider's own channel is `requestedAction`
// on their own row, written by the report push -- not this route.
//
// THE RESULT IS PER ITEM, AND A 200 IS NOT A SUCCESS REPORT. Five of the six outcome buckets mean
// something did NOT happen: `stale` (someone resolved it first), `rejected` (not in the pool, or a
// mapping the DD refused), `locked` (a report holding the item is open in front of someone), `noop`
// (already in the state asked for). A caller that prints "sent N decisions" and stops has reported
// success for work the service declined. So the arrays come back whole, and the caller is expected
// to look at them.

/** One decision as applied. `outcome` is absent for `submit-to-ft`, which sets a status, not an outcome. */
export interface AppliedDecision {
  readonly variationKey: string;
  readonly action: DecisionAction;
  readonly outcome?: string;
}

/** Somebody resolved this key before the decision arrived, so it was left as they left it. */
export interface StaleDecision {
  readonly variationKey: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly currentOutcome?: string;
}

/** A key the service declined to act on, with its reason. Covers `noop` and `rejected` alike. */
export interface DeclinedDecision {
  readonly variationKey: string;
  readonly reason: string;
}

/** A key skipped because a report carrying it is locked for review by someone else. */
export interface LockedDecision extends DeclinedDecision {
  readonly lock?: LockHolderInfo;
}

export interface SaveVariationDecisionsInput extends ServiceAuthInput {
  readonly decisions: ReadonlyArray<Decision>;
  /**
   * DD version the service validates `accept` / `ft-mapped` mapping targets against.
   *
   * Pass the version off the report. The service defaults to 2.1 when this is absent, so a 2.0
   * report's mappings would otherwise be checked against the wrong dictionary -- and a target that
   * is valid in one version and absent in the other is exactly the case a reviewer needs told.
   */
  readonly ddVersion?: string;
  /**
   * Display name recorded as the editor on every row this call touches, and used as the label on
   * the notifications it fans out.
   *
   * Body-supplied, so it is the caller's own claim about itself rather than anything the token
   * established. cert-backend #212 moves the editor identity to the auth context, at which point
   * this stops being read; passing it is then inert rather than wrong.
   */
  readonly userDisplayName?: string;
}

export interface SaveVariationDecisionsResult {
  readonly applied: ReadonlyArray<AppliedDecision>;
  readonly stale: ReadonlyArray<StaleDecision>;
  readonly noop: ReadonlyArray<DeclinedDecision>;
  readonly rejected: ReadonlyArray<DeclinedDecision>;
  readonly locked: ReadonlyArray<LockedDecision>;
  /** Providers the service notified about the decisions. Empty is normal: the editor is not notified. */
  readonly rollupNotificationsFanOutTo: ReadonlyArray<string>;
}

const arrayAt = <T>(body: unknown, key: string): ReadonlyArray<T> =>
  isRecord(body) && Array.isArray(body[key]) ? (body[key] as ReadonlyArray<T>) : [];

/** Read the service's per-item buckets off a body, tolerating any the service omitted. */
const resultFrom = (body: unknown): SaveVariationDecisionsResult => ({
  applied: arrayAt<AppliedDecision>(body, 'applied'),
  stale: arrayAt<StaleDecision>(body, 'stale'),
  noop: arrayAt<DeclinedDecision>(body, 'noop'),
  rejected: arrayAt<DeclinedDecision>(body, 'rejected'),
  locked: arrayAt<LockedDecision>(body, 'locked'),
  rollupNotificationsFanOutTo: arrayAt<string>(body, 'rollupNotificationsFanOutTo')
});

/**
 * Record decisions against a review that is already open.
 *
 * Refusals that stop the whole batch throw; per-item outcomes come back in the result. The division
 * follows the service: it validates the batch before it takes its lock, so a 400 or a 403 means
 * nothing at all was written, while a 200 can carry any mix of applied and declined.
 */
export const saveVariationDecisionsViaService = async (input: SaveVariationDecisionsInput): Promise<SaveVariationDecisionsResult> => {
  const what = 'Saving variation decisions';

  if (input.decisions.length === 0) throw serviceError('SERVICE_ERROR', `${what} needs at least one decision.`);

  const servicesUrl = resolveServicesUrl();
  const token = await resolveToken(input, what);

  const response = await fetch(`${servicesUrl}${DECISIONS_ROUTE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      decisions: input.decisions,
      ...(input.ddVersion ? { ddVersion: input.ddVersion } : {}),
      ...(input.userDisplayName ? { userDisplayName: input.userDisplayName } : {})
    })
  });

  if (response.status === 401) {
    throw serviceError(
      'AUTH_REJECTED',
      input.fromCli
        ? `${what}: the provider token was rejected. Re-check your .env credentials.`
        : `${what}: your session token was rejected or has expired. Log in again to continue.`
    );
  }

  // 403 is a DIFFERENT answer from 401 on this route and is not an expired session. The token was
  // read and found to carry no authority over other organizations -- which every action here needs,
  // because one decision settles a key for every provider holding it. Telling a provider to log in
  // again would send them round a loop that cannot succeed.
  if (response.status === 403) {
    throw serviceError(
      'AUTH_REJECTED',
      `${what} was refused: this route needs administrator authority, because a decision resolves the item for every organization that flagged it. A provider's own request travels on the report submission instead.`
    );
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => undefined);

    // Two different 409s, and conflating them would hide the one that matters.
    //
    // With per-item buckets, the pool was already written and the canonical write then failed under
    // the lock: the two stores DISAGREE until something reconciles them, and the operator has to
    // know which keys are in that state. Without them, the canonical store's own lock is held by
    // another resolver and nothing was written at all.
    if (isRecord(body) && Array.isArray(body.applied)) {
      const partial = resultFrom(body);
      const keys = partial.applied.map(a => a.variationKey);
      const detail = typeof body.detail === 'string' ? ` Service detail: ${body.detail}` : '';
      throw serviceError(
        'SERVICE_ERROR',
        `${what} left the stores disagreeing: the review pool was updated for ${keys.length} item(s) but the canonical write failed. Those items read as decided in the pool and are NOT in the canonical store.${detail}${
          keys.length > 0 ? ` Affected: ${keys.join(', ')}.` : ''
        } Re-run the same decisions once the service is healthy; re-applying them is safe.`
      );
    }

    const lock = lockFrom(body);
    const who = lock ? `${lock.displayName} (${lock.email})` : 'another administrator';
    throw lockedError(
      `${what} was refused: ${who} is resolving decisions right now${lock ? `, until ${lock.expiresAt}` : ''}. Nothing was written. Retry when they are done.`,
      lock
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const trimmed = detail.trim().slice(0, 300);
    throw serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}${trimmed ? ` — ${trimmed}` : ''}`);
  }

  return resultFrom(await response.json().catch(() => undefined));
};
