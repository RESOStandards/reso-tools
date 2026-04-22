/**
 * Variations Save — tests for payload building, key parsing, and change ID computation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electronStorage
const mockStore = new Map<string, string>();
vi.stubGlobal('electronStorage', {
  get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  remove: vi.fn(async (key: string) => { mockStore.delete(key); }),
});

// Mock fetch for saveVariationsReport
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockStore.clear();
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => null });
});

const { saveVariationsReview } = await import('../src/services/variations-save');

describe('saveVariationsReview', () => {
  it('returns false when there are no actions or comments', async () => {
    const result = await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });
    expect(result).toBe(false);
  });

  it('builds correct payload for ignore actions', async () => {
    // Mock the getVariationsReport call (returns null = no existing report)
    mockFetch
      .mockResolvedValueOnce({ ok: false }) // getVariationsReport returns 404
      .mockResolvedValueOnce({ ok: true }); // saveVariationsReport succeeds

    const result = await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:ListPrice', status: 'ignored' }],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check the save payload
    const saveCall = mockFetch.mock.calls[1];
    const body = JSON.parse(saveCall[1].body);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].resourceName).toBe('Property');
    expect(body.changes[0].fieldName).toBe('ListPrice');
    expect(body.changes[0].ignore).toBe(true);
    expect(body.changes[0].flaggedForFastTrack).toBe(false);
  });

  it('builds correct payload for fast-track actions', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:CustomField', status: 'fast-track' }],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.changes[0].flaggedForFastTrack).toBe(true);
    expect(body.changes[0].ignore).toBe(false);
  });

  it('builds correct payload for remove actions', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:BadField', status: 'remove' }],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.changes[0].remove).toBe(true);
  });

  it('parses three-part keys (resource:field:lookup)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:StandardStatus:Active', status: 'ignored' }],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.changes[0].resourceName).toBe('Property');
    expect(body.changes[0].fieldName).toBe('StandardStatus');
    expect(body.changes[0].lookupValue).toBe('Active');
  });

  it('attaches comments to related actions', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:ListPrice', status: 'ignored' }],
      comments: [{
        variationKey: 'Property:ListPrice',
        timestamp: '2026-04-21T00:00:00Z',
        from: 'P001',
        to: 'RESO',
        message: 'This is a local field name',
      }],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.changes[0].conversations).toHaveLength(1);
    expect(body.changes[0].conversations[0].message).toBe('This is a local field name');
  });

  it('includes standalone comments not attached to actions', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [],
      comments: [{
        variationKey: 'Property:SomeField',
        timestamp: '2026-04-21T00:00:00Z',
        from: 'P001',
        to: 'RESO',
        message: 'Question about this field',
      }],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].resourceName).toBe('Property');
    expect(body.changes[0].fieldName).toBe('SomeField');
    expect(body.changes[0].conversations).toHaveLength(1);
  });

  it('includes editor info with changeId', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await saveVariationsReview({
      version: '2.1',
      providerUoi: 'P001',
      providerUsi: 'S001',
      recipientUoi: 'R001',
      actions: [{ key: 'Property:X', status: 'ignored' }],
      comments: [],
      userName: 'Josh',
      userEmail: 'josh@reso.org',
      token: 'test-token',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.editorInfo).toHaveLength(1);
    expect(body.editorInfo[0].displayName).toBe('Josh');
    expect(body.editorInfo[0].email).toBe('josh@reso.org');
    expect(body.editorInfo[0].providerUoi).toBe('P001');
    expect(body.editorInfo[0].changeId).toBeDefined();
    expect(body.changes[0].changeId).toBe(body.editorInfo[0].changeId);
  });
});
