import { describe, it, expect } from 'vitest';
import { adaptPoolItemsToReport } from '../src/pages/cert/variations-page';
import type { VariationItem, VariationItemStatus } from '../src/services/variations-service';

// Minimal pool item; only the fields the adapter reads matter.
const item = (overrides: Partial<VariationItem> & { status: VariationItemStatus }): VariationItem => ({
  variationKey: 'k',
  resourceName: 'Property',
  fieldName: 'ExteriorFeatures',
  lookupValue: 'Grill',
  provenance: [],
  otherDrafts: [],
  lastUpdatedAt: '2026-06-22T00:00:00.000Z',
  ...overrides,
});

describe('adaptPoolItemsToReport (#203: in-review only)', () => {
  it('keeps only status === pending rows; counts derive from the same filtered set', () => {
    const report = adaptPoolItemsToReport([
      item({ variationKey: 'a', status: 'pending' }),
      item({ variationKey: 'b', status: 'resolved', outcome: 'ignored' }),
      item({ variationKey: 'c', status: 'resolved', outcome: 'accepted' }),
      item({ variationKey: 'd', status: 'ft-submitted' }),
    ]);
    expect(report.variations).toHaveLength(1);
    expect(report.counts.total).toBe(1);
    expect(report.counts.lookups).toBe(1); // the surviving pending row is a lookup
    expect(report.counts.ignored).toBe(0); // a pending row carries no resolved 'ignored' outcome
  });

  it('drops a resolved-ignored item even though it carries outcome === ignored', () => {
    const report = adaptPoolItemsToReport([item({ status: 'resolved', outcome: 'ignored' })]);
    expect(report.variations).toHaveLength(0);
    expect(report.counts.total).toBe(0);
  });

  it('keeps an item the viewer is mid-review on (still pending on the service until Submit)', () => {
    const report = adaptPoolItemsToReport([
      item({ status: 'pending', myDraft: { action: 'ignore', draftedAt: '2026-06-22T00:00:00.000Z' } }),
    ]);
    expect(report.variations).toHaveLength(1);
  });
});
