/**
 * Variations Save — tests for the deltas-only POST contract.
 *
 * Since the backend merge refactor (#183), the frontend sends only
 * new deltas: no GET-and-merge, exactly one fetch per save, no
 * changeId on any submitted item.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildVariationKey } from '@reso-standards/reso-client';

const mockStore = new Map<string, string>();
vi.stubGlobal('electronStorage', {
  get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  remove: vi.fn(async (key: string) => { mockStore.delete(key); }),
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../src/api/cert-client', () => ({
  requestProviderToken: vi.fn(async () => ({
    accessToken: 'test-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })),
}));

const { saveVariationsReview } = await import('../src/services/variations-save');
const variationsService = await import('../src/services/variations-service');
const authService = await import('../src/services/auth-service');

const baseInput = {
  version: '2.1',
  providerUoi: 'P001',
  providerUsi: 'S001',
  recipientUoi: 'R001',
  userName: 'Josh',
  userEmail: 'josh@reso.org',
};

beforeEach(async () => {
  mockStore.clear();
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => null });
  authService.__resetForTesting();
  authService.__setStorageForTesting({
    get: async (k) => mockStore.get(k) ?? null,
    set: async (k, v) => { mockStore.set(k, v); },
    remove: async (k) => { mockStore.delete(k); },
  });
  await authService.setCredentials({ username: 'tester', apiToken: 'cert-api-token' });
});

describe('saveVariationsReview — deltas-only contract', () => {
  it('returns false when there are no actions or comments', async () => {
    const result = await saveVariationsReview({
      ...baseInput,
      actions: [],
      comments: [],
    });
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch the existing report before saving (no GET-then-POST)', async () => {
    const getSpy = vi.spyOn(variationsService, 'getVariationsReport');

    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'ListPrice'), status: 'ignored' }],
      comments: [],
    });

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('issues exactly one fetch call per save', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'ListPrice'), status: 'ignored' }],
      comments: [],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends only the new changes (no past changes, no changeId)', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'ListPrice'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].changeId).toBeUndefined();
  });

  it('sends exactly one editorInfo entry, no changeId, matching the user', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'X'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.editorInfo).toHaveLength(1);
    expect(body.editorInfo[0]).toMatchObject({
      displayName: 'Josh',
      email: 'josh@reso.org',
      providerUoi: 'P001',
      username: 'Josh',
    });
    expect(body.editorInfo[0].changeId).toBeUndefined();
    expect(body.editorInfo[0].editedOn).toBeTruthy();
  });

  it('builds correct payload for ignore actions', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'ListPrice'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0]).toMatchObject({
      resourceName: 'Property',
      fieldName: 'ListPrice',
      ignore: true,
      flaggedForFastTrack: false,
    });
  });

  it('builds correct payload for fast-track actions', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'CustomField'), status: 'fast-track' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0].flaggedForFastTrack).toBe(true);
    expect(body.changes[0].ignore).toBe(false);
  });

  it('builds correct payload for remove actions', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'BadField'), status: 'remove' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0].remove).toBe(true);
  });

  it('parses three-part keys (resource, field, lookup)', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'StandardStatus', 'Active'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0]).toMatchObject({
      resourceName: 'Property',
      fieldName: 'StandardStatus',
      lookupValue: 'Active',
    });
  });

  it('preserves printable punctuation in lookup value (Unit Separator delimiter does not collide)', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'Foo', 'bar:baz:qux'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0]).toMatchObject({
      resourceName: 'Property',
      fieldName: 'Foo',
      lookupValue: 'bar:baz:qux',
    });
  });

  it('attaches comments to related actions', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'ListPrice'), status: 'ignored' }],
      comments: [{
        variationKey: buildVariationKey('Property', 'ListPrice'),
        timestamp: '2026-04-21T00:00:00Z',
        from: 'P001',
        to: 'RESO',
        message: 'This is a local field name',
      }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes[0].conversations).toHaveLength(1);
    expect(body.changes[0].conversations[0].message).toBe('This is a local field name');
  });

  it('includes standalone comments not attached to actions', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [],
      comments: [{
        variationKey: buildVariationKey('Property', 'SomeField'),
        timestamp: '2026-04-21T00:00:00Z',
        from: 'P001',
        to: 'RESO',
        message: 'Question about this field',
      }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      resourceName: 'Property',
      fieldName: 'SomeField',
    });
    expect(body.changes[0].conversations).toHaveLength(1);
  });

  it('preserves report identifiers in the POST body', async () => {
    await saveVariationsReview({
      ...baseInput,
      actions: [{ key: buildVariationKey('Property', 'X'), status: 'ignored' }],
      comments: [],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      description: 'RESO Data Dictionary Change Log',
    });
    expect(body.certificationRequestId).toBeTruthy();
  });
});
