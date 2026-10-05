/**
 * Posting decisions to a review that is already open.
 *
 * The flow, in Josh's words (2026-10-04): "we got a variations report, we're submitting it for
 * review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin." This is the selection half.
 *
 * What these pin is the division of labor between throwing and reporting, because that is where the
 * design decision is. The service validates the whole batch BEFORE it takes its lock, so a 400 or a
 * 403 means nothing was written and throwing is honest. A 200 is different: it can carry any mix of
 * applied and declined, and five of the six buckets mean something did NOT happen. So a 200 comes
 * back whole and the caller has to look.
 *
 * And the two 409s, which share a status and nothing else. One says another administrator holds the
 * canonical store and nothing was written. The other says the pool was written and the canonical
 * write then failed -- the stores disagree, and which keys are in that state is the only thing worth
 * knowing at that moment. Conflating them would report a reconcilable divergence as "try later".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockHolderOf } from '../../src/sdk/common.js';
import { saveVariationDecisionsViaService } from '../../src/variations/submit.js';
import { VARIATION_KEY_SEPARATOR } from '../../src/variations/decisions.js';

const US = VARIATION_KEY_SEPARATOR;
const KEY = `Property${US}LeaseTerm${US}Months - 4`;

const ok = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const fail = (status: number, body?: unknown, text = '') =>
  ({
    ok: false,
    status,
    statusText: 'Refused',
    json: async () => body,
    text: async () => (text === '' ? JSON.stringify(body ?? {}) : text)
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.RESO_SERVICES_URL = 'https://services.example.org';
  fetchMock = vi.fn(async () => ok({ applied: [{ variationKey: KEY, action: 'submit-to-ft' }] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.RESO_SERVICES_URL = undefined;
});

const save = (over: Record<string, unknown> = {}) =>
  saveVariationDecisionsViaService({
    decisions: [{ variationKey: KEY, action: 'submit-to-ft' }],
    bearerToken: 'tok',
    fromCli: true,
    ...over
  });

const sentBody = () => JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));

describe('the request', () => {
  it('posts the decisions to the save route', async () => {
    await save();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://services.example.org/v2/certification/save-variation-decisions');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(sentBody().decisions).toEqual([{ variationKey: KEY, action: 'submit-to-ft' }]);
  });

  it('sends JSON, not the compressed text/plain the compute route takes', async () => {
    // The service only decompresses when the content type is exactly text/plain. Declaring JSON and
    // sending base64 would parse as an empty body, which the route answers as "decisions[] required".
    await save();
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('passes the DD version through, so mappings are checked against the right dictionary', async () => {
    // Absent, the service assumes 2.1. A 2.0 report's targets would then be validated against a
    // dictionary they were never written for.
    await save({ ddVersion: '2.0' });
    expect(sentBody().ddVersion).toBe('2.0');
  });

  it('omits ddVersion when the caller has none rather than inventing one', async () => {
    await save();
    expect(sentBody().ddVersion).toBeUndefined();
  });

  it('passes the editor display name when given', async () => {
    await save({ userDisplayName: 'Josh Darnell' });
    expect(sentBody().userDisplayName).toBe('Josh Darnell');
  });

  it('refuses an empty batch without contacting the service', async () => {
    await expect(save({ decisions: [] })).rejects.toThrow(/at least one decision/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a 200 reports per item, and is not a success report', () => {
  it('returns every bucket the service sent, declined ones included', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        applied: [{ variationKey: KEY, action: 'ignore', outcome: 'ignored' }],
        stale: [{ variationKey: 'a', resolvedBy: 'T1', resolvedAt: '2026-10-04T00:00:00Z', currentOutcome: 'accepted' }],
        noop: [{ variationKey: 'b', reason: 'already in target state (ft-submitted)' }],
        rejected: [{ variationKey: 'c', reason: 'variationKey not found in pool' }],
        locked: [{ variationKey: 'd', reason: 'A report holding this item is locked for review by someone else.' }],
        rollupNotificationsFanOutTo: ['T00000045']
      })
    );
    const result = await save();
    expect(result.applied).toHaveLength(1);
    expect(result.stale[0].resolvedBy).toBe('T1');
    expect(result.noop[0].reason).toMatch(/already in target state/);
    expect(result.rejected[0].reason).toMatch(/not found in pool/);
    expect(result.locked[0].reason).toMatch(/locked for review/);
    expect(result.rollupNotificationsFanOutTo).toEqual(['T00000045']);
  });

  it('gives every bucket as an array even when the service omits it', async () => {
    // A caller decides its exit code by adding these up. An undefined bucket would throw on .length
    // at exactly the moment it is being asked whether anything was declined.
    fetchMock.mockResolvedValueOnce(ok({ applied: [] }));
    const result = await save();
    for (const bucket of [result.applied, result.stale, result.noop, result.rejected, result.locked]) {
      expect(Array.isArray(bucket)).toBe(true);
    }
  });

  it('carries the lock holder on a locked item, so a caller can say who to ask', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        locked: [
          {
            variationKey: KEY,
            reason: 'A report holding this item is locked for review by someone else.',
            lock: { displayName: 'Anna', email: 'anna@example.org', expiresAt: '2026-10-04T14:30:00Z' }
          }
        ]
      })
    );
    const result = await save();
    expect(result.locked[0].lock?.displayName).toBe('Anna');
  });
});

describe('refusals that stop the whole batch', () => {
  it('reads a 403 as missing authority, not as a stale session', async () => {
    // The two answers need different fixes. Telling a provider to log in again sends them round a
    // loop that cannot succeed: no provider holds authority over another organization, which is what
    // every action on this route exercises.
    fetchMock.mockResolvedValueOnce(fail(403, { message: 'Admin access required to resolve variation decisions' }));
    const message = (await save().catch((e: unknown) => e as Error)).message;
    expect(message).toMatch(/administrator authority/i);
    expect(message).not.toMatch(/log in again/i);
  });

  it('reads a 401 as a credential problem', async () => {
    fetchMock.mockResolvedValue(fail(401, { message: 'Unauthorized' }));
    await expect(save()).rejects.toThrow(/\.env credentials/i);
  });

  it('reads a 409 with no per-item buckets as another administrator holding the store', async () => {
    fetchMock.mockResolvedValueOnce(
      fail(409, {
        message: 'Lock exists!',
        lock: { displayName: 'Anna', email: 'anna@example.org', expiresAt: '2026-10-04T14:30:00Z' }
      })
    );
    const error = await save().catch((e: unknown) => e);
    expect((error as Error & { code?: string }).code).toBe('LOCKED');
    expect((error as Error).message).toMatch(/nothing was written/i);
    expect(lockHolderOf(error)?.displayName).toBe('Anna');
  });

  it('reads a 409 WITH per-item buckets as the stores disagreeing, and names the keys', async () => {
    // The dangerous one. The pool says decided, the canonical store does not. Reporting this as a
    // lock would tell the operator to come back later when what they actually need is the list of
    // keys that are now in two different states.
    fetchMock.mockResolvedValueOnce(
      fail(409, {
        message: 'Canonical write failed — refresh and retry',
        applied: [{ variationKey: KEY, action: 'ignore', outcome: 'ignored' }],
        stale: [],
        noop: [],
        rejected: [],
        detail: 'PreconditionFailed'
      })
    );
    const error = await save().catch((e: unknown) => e);
    expect((error as Error & { code?: string }).code).toBe('SERVICE_ERROR');
    expect((error as Error).message).toMatch(/stores disagreeing/i);
    expect((error as Error).message).toContain(KEY);
    expect((error as Error).message).toContain('PreconditionFailed');
  });

  it('includes the service’s own message on any other failure', async () => {
    // A bare status is not actionable: a 404 from the gateway and one from the handler look
    // identical and need completely different fixes.
    fetchMock.mockResolvedValueOnce(fail(400, undefined, 'each decision needs a variationKey'));
    await expect(save()).rejects.toThrow(/each decision needs a variationKey/);
  });

  it('refuses when the services URL is not configured, before any request', async () => {
    process.env.RESO_SERVICES_URL = '';
    await expect(save()).rejects.toThrow(/RESO_SERVICES_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
