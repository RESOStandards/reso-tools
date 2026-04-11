import { render, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollection } from '../src/hooks/use-collection';

// Mock the API client
vi.mock('../src/api/client.js', () => ({
  queryCollection: vi.fn(),
  fetchCollectionByUrl: vi.fn(),
}));

// Mock the error formatter
vi.mock('../src/utils/error-messages.js', () => ({
  formatError: (_raw: string, msg: string) => ({ description: msg, serverMessage: msg }),
}));

import { queryCollection } from '../src/api/client.js';

const mockedQuery = vi.mocked(queryCollection);

/** Test harness that renders the hook and exposes its return value. */
const HookHarness = ({
  resource,
  params = {},
  enabled = true,
  onResult,
}: {
  readonly resource: string;
  readonly params?: { $filter?: string; $orderby?: string; $select?: string; $expand?: string };
  readonly enabled?: boolean;
  readonly onResult: (result: ReturnType<typeof useCollection>) => void;
}) => {
  const result = useCollection(resource, params, enabled);
  onResult(result);
  return null;
};

describe('useCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears rows synchronously when resource changes', async () => {
    const results: Array<ReturnType<typeof useCollection>> = [];
    const capture = (r: ReturnType<typeof useCollection>) => { results.push(r); };

    // First resource returns some rows
    mockedQuery.mockResolvedValueOnce({
      value: [{ id: '1', Name: 'Row A' }],
      '@odata.count': 1,
    });

    const { rerender } = render(
      <HookHarness resource="Lookup" params={{}} onResult={capture} />
    );

    // Wait for the initial fetch to complete
    await waitFor(() => {
      const latest = results[results.length - 1];
      expect(latest.rows).toHaveLength(1);
    });

    // Set up the mock for the next resource
    mockedQuery.mockResolvedValueOnce({
      value: [{ id: '2', ListingKey: 'Prop1' }],
      '@odata.count': 1,
    });

    // Clear results tracker to capture the resource-switch renders
    const switchStart = results.length;

    // Switch resource
    rerender(
      <HookHarness resource="Property" params={{}} onResult={capture} />
    );

    // The FIRST render after switching should have empty rows
    // (synchronous clear, not waiting for useEffect)
    const firstRenderAfterSwitch = results[switchStart];
    expect(firstRenderAfterSwitch.rows).toHaveLength(0);
    expect(firstRenderAfterSwitch.count).toBeUndefined();
    expect(firstRenderAfterSwitch.error).toBeNull();
  });

  it('fetches new data after resource change', async () => {
    const results: Array<ReturnType<typeof useCollection>> = [];
    const capture = (r: ReturnType<typeof useCollection>) => { results.push(r); };

    mockedQuery.mockResolvedValueOnce({
      value: [{ id: '1', LookupKey: 'L1' }],
      '@odata.count': 1,
    });

    const { rerender } = render(
      <HookHarness resource="Lookup" params={{}} onResult={capture} />
    );

    await waitFor(() => {
      expect(results[results.length - 1].rows).toHaveLength(1);
    });

    // Switch to Property
    mockedQuery.mockResolvedValueOnce({
      value: [{ id: '2', ListingKey: 'P1' }, { id: '3', ListingKey: 'P2' }],
      '@odata.count': 2,
    });

    rerender(
      <HookHarness resource="Property" params={{}} onResult={capture} />
    );

    // Wait for Property data to load
    await waitFor(() => {
      const latest = results[results.length - 1];
      expect(latest.rows).toHaveLength(2);
      expect(latest.rows[0]).toHaveProperty('ListingKey', 'P1');
    });

    // Verify the old Lookup data is not present
    const latest = results[results.length - 1];
    expect(latest.rows.some(r => 'LookupKey' in r)).toBe(false);
  });

  it('does not fetch when disabled', async () => {
    const results: Array<ReturnType<typeof useCollection>> = [];
    const capture = (r: ReturnType<typeof useCollection>) => { results.push(r); };

    render(
      <HookHarness resource="Property" params={{}} enabled={false} onResult={capture} />
    );

    // Give it a tick
    await act(async () => {});

    expect(mockedQuery).not.toHaveBeenCalled();
    expect(results[results.length - 1].rows).toHaveLength(0);
  });
});
