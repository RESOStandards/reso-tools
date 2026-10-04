/**
 * Submitting a variations report: the shared path the CLI and the desktop both call.
 *
 * What these pin is mostly the REFUSALS, because the happy path is a POST and the refusals are where
 * the design decisions live:
 *
 *   - A lock refusal is its own error code, not a generic failure, so a caller can say "Anna has this
 *     open until 14:30" instead of printing a status.
 *   - No flag reaches past a lock. `overwrite` is consent for a pending review with no lock, and a
 *     lock a stateless call could clear would not be a lock.
 *   - A 503 is reported as "nothing was written, retry" rather than as a failed report, because the
 *     service refuses rather than half-writing when it cannot verify lock state.
 *   - A dry run touches nothing at all -- not even a probe, since a dry run that contacted the
 *     service would be a different operation from the one it previews.
 *
 * And the identity: this sends none and reports back whatever the service issued. Deriving it here
 * would mean two implementations having to agree forever, because the service builds `endorsementId`
 * from it and scopes the pool sweep by that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockHolderOf } from '../../src/sdk/common.js';
import { submitVariationsReportViaService } from '../../src/variations/submit.js';

const REPORT = {
  version: '2.1',
  providerUoi: 'T00000076',
  providerUsi: '50009',
  recipientUoi: 'M00000100',
  changes: [
    { resourceName: 'Property', fieldName: 'Sprinklers' },
    { resourceName: 'Property', fieldName: 'Fencing' },
  ],
};

const ok = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body }) as unknown as Response;

const fail = (status: number, body?: unknown) =>
  ({ ok: false, status, statusText: 'Refused', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.RESO_SERVICES_URL = 'https://services.example.org';
  fetchMock = vi.fn(async () => ok({ variationsReportId: 'issued-by-the-server' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.RESO_SERVICES_URL = undefined;
});

const submit = (over: Record<string, unknown> = {}) =>
  submitVariationsReportViaService({ report: REPORT, bearerToken: 'tok', fromCli: true, ...over });

describe('a submission is a full replace, declared explicitly', () => {
  it('declares replaceReviewRows so the service does not have to infer it', async () => {
    // A fresh run is a COMPLETE report, never a delta. Absence of the flag means delta, so the safe
    // reading is the default -- saying so explicitly is correct here, not merely cautious.
    await submit();
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.replaceReviewRows).toBe(true);
  });

  it('sends NO variationsReportId — the service issues it', async () => {
    // Deriving it client-side is what this avoids: the service builds endorsementId from it and
    // scopes the pool sweep by that, so two implementations would have to agree byte-for-byte.
    await submit();
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.variationsReportId).toBeUndefined();
  });

  it('reports back the identity the service issued, as the caller’s handle', async () => {
    const result = await submit();
    expect(result.variationsReportId).toBe('issued-by-the-server');
  });

  it('addresses the route by the report’s own coordinates', async () => {
    await submit();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/v2/certification/variations-reports/2.1/T00000076/50009/M00000100');
  });
});

describe('a lock refusal is actionable, not a generic failure', () => {
  const lockedBody = {
    message: 'locked',
    lock: { displayName: 'Anna Reviewer', email: 'anna@example.org', expiresAt: '2026-10-04T14:30:00.000Z', heldByProviderUoi: 'T00000076' },
  };

  it('throws LOCKED rather than SERVICE_ERROR', async () => {
    // Collapsing this into a generic failure would make "retry when they are done" indistinguishable
    // from "something is broken".
    fetchMock.mockResolvedValue(fail(409, lockedBody));
    await expect(submit()).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('carries the holder, so a caller can say who to ask', async () => {
    fetchMock.mockResolvedValue(fail(409, lockedBody));
    const error = await submit().catch((e: unknown) => e);
    expect(lockHolderOf(error)?.email).toBe('anna@example.org');
    expect(lockHolderOf(error)?.expiresAt).toBe('2026-10-04T14:30:00.000Z');
  });

  it('names the holder in the message too, for a plain terminal', async () => {
    fetchMock.mockResolvedValue(fail(409, lockedBody));
    await expect(submit()).rejects.toThrow(/Anna Reviewer/);
  });

  it('still refuses with --overwrite — no flag reaches past a lock', async () => {
    // The rule, in the owner's words: overwrite covers pending reviews with no locks. A lock a
    // stateless call could clear would not be a lock.
    fetchMock.mockResolvedValue(fail(409, lockedBody));
    await expect(submit({ overwrite: true })).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('degrades to a usable message when the service names no holder', async () => {
    fetchMock.mockResolvedValue(fail(409, { message: 'locked' }));
    await expect(submit()).rejects.toThrow(/another user/);
  });
});

describe('an unverifiable lock state is not a failed report', () => {
  it('explains that nothing was written and a retry is the fix', async () => {
    // The service fails closed rather than half-writing. Reporting that as "your submission failed"
    // would send someone looking at their report, which is not where the problem is.
    fetchMock.mockResolvedValue(fail(503));
    await expect(submit()).rejects.toThrow(/wrote nothing|not a problem with your report/i);
  });
});

describe('a dry run touches nothing', () => {
  it('makes no request at all', async () => {
    const result = await submit({ dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it('still reports what would be submitted', async () => {
    const result = await submit({ dryRun: true });
    expect(result.changeCount).toBe(2);
    expect(result.providerUoi).toBe('T00000076');
  });

  it('needs no credentials, because it contacts nothing', async () => {
    // A dry run that demanded auth would be checking something it does not use.
    const result = await submitVariationsReportViaService({ report: REPORT, dryRun: true, fromCli: true });
    expect(result.dryRun).toBe(true);
  });
});

describe('a report that is not a variations report is caught before anything is sent', () => {
  it('names the missing coordinates rather than failing at the service', async () => {
    // The likeliest mistake is pointing this at metadata-report.json, which carries none of them.
    await expect(
      submitVariationsReportViaService({ report: { version: '2.1' }, bearerToken: 'tok', fromCli: true }),
    ).rejects.toThrow(/providerUoi, providerUsi, recipientUoi/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('auth wording follows the surface', () => {
  it('tells a CLI user to fix .env', async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(submit()).rejects.toThrow(/\.env/);
  });

  it('tells a session user to log in again', async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(submit({ fromCli: false })).rejects.toThrow(/log in again/i);
  });
});
