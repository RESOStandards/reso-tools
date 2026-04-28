import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StepDetail, type JobStep } from '../src/pages/cert/jobs-page';

// Industry baseline does a network fetch on mount. Stub it so the test
// stays self-contained.
vi.mock('../src/services/industry-baseline.js', () => ({
  getIndustryBaseline: () => null,
  initIndustryBaseline: () => undefined,
  lockResourceOrder: (order: ReadonlyArray<string>) => order,
  getResourceOrder: () => null,
}));

const makeStep = (detail?: string, status: JobStep['status'] = 'running'): JobStep => ({
  name: 'Replicate and validate',
  status,
  detail,
});

const replicationDetail = (currentStrategy: string, totalRecords: number): string =>
  JSON.stringify({
    _type: 'replication-progress',
    currentStrategy,
    resources: [
      { name: 'Property', records: totalRecords, bytes: 0 },
    ],
    totalRecords,
    totalBytes: null,
    throughput: null,
    meanResponseMs: null,
    anomalyCount: 0,
  });

describe('StepDetail', () => {
  it('renders nothing when detail is absent', () => {
    const { container } = render(<StepDetail step={makeStep()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders plain detail text for non-JSON detail', () => {
    render(<StepDetail step={makeStep('Auth credentials present')} />);
    expect(screen.getByText('Auth credentials present')).toBeTruthy();
  });

  it('renders the replication chart when detail is replication-progress JSON', () => {
    render(<StepDetail step={makeStep(replicationDetail('NextLink', 1000))} />);
    expect(screen.getByText('NextLink')).toBeTruthy();
    expect(screen.getByText('Property')).toBeTruthy();
  });

  it('keeps the chart visible after detail transitions to non-replication text', () => {
    // First render: replication-progress JSON in detail.
    const { rerender } = render(
      <StepDetail step={makeStep(replicationDetail('TimestampDesc', 500))} />,
    );
    expect(screen.getByText('TimestampDesc')).toBeTruthy();

    // Subsequent render: detail flips to a plain string between strategies.
    // The cached chart should still display — that's the bug fix.
    rerender(<StepDetail step={makeStep('Switching strategy...')} />);
    expect(screen.getByText('TimestampDesc')).toBeTruthy();
  });

  it('updates the chart when a fresh replication-progress arrives', () => {
    const { rerender } = render(
      <StepDetail step={makeStep(replicationDetail('TimestampDesc', 100))} />,
    );
    expect(screen.getByText('TimestampDesc')).toBeTruthy();

    rerender(<StepDetail step={makeStep(replicationDetail('NextLink', 200))} />);
    expect(screen.getByText('NextLink')).toBeTruthy();
    expect(screen.queryByText('TimestampDesc')).toBeNull();
  });

  it('does not infinite-loop on stable detail (regression: React #185)', () => {
    // Before the useMemo fix, parseReplicationProgress returned a fresh
    // object each render, causing the [live] dep on useEffect to fire
    // every render → setState → re-render → loop. If that bug returns
    // here, this test trips React's max-update-depth guard and throws.
    const detail = replicationDetail('NextLink', 1000);
    const { rerender } = render(<StepDetail step={makeStep(detail)} />);

    // Re-render the same detail several times. With the bug, this would
    // explode into an unbounded re-render. With the fix, the memoized
    // `live` reference is stable so the effect only fires when content
    // actually changes.
    for (let i = 0; i < 20; i++) {
      rerender(<StepDetail step={makeStep(detail)} />);
    }

    expect(screen.getByText('NextLink')).toBeTruthy();
  });
});
