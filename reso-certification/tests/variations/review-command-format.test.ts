import { describe, it, expect } from 'vitest';
import {
  displayVariationKey,
  displayMapping,
  formatReviewItemsTable,
  formatEndorsementStatusTable,
  formatProvenance,
} from '../../src/cli/variations-review-command.js';
import type { VariationReviewItem } from '../../src/variations/review.js';

const SEP = '';

const item = (overrides: Partial<VariationReviewItem> = {}): VariationReviewItem => ({
  variationKey: `Property${SEP}BuyerAgentKeyNumeric`,
  resourceName: 'Property',
  fieldName: 'BuyerAgentKeyNumeric',
  lookupValue: null,
  status: 'pending',
  outcome: null,
  mapping: { suggestedFieldName: 'Buyer' },
  strategy: null,
  suggestions: null,
  provenance: [
    {
      providerUoi: 'T00000001',
      providerUsi: '1001',
      recipientUoi: 'M00000001',
      submittedAt: '2026-09-16T15:27:11.915Z',
      environmentName: 'qa',
      submittedByProviderUoi: 'T00000009',
      lastEditorRole: 'admin',
    },
    {
      providerUoi: 'T00000002',
      providerUsi: '1002',
      recipientUoi: 'M00000002',
      submittedAt: '2026-08-28T08:25:02.044Z',
      environmentName: 'qa',
      submittedByProviderUoi: 'T00000009',
      lastEditorRole: 'admin',
    },
  ],
  otherDrafts: [],
  ...overrides,
});

describe('displayVariationKey', () => {
  it('joins the separator-delimited segments with dots', () => {
    expect(displayVariationKey(`Property${SEP}Roof${SEP}Corrugated`)).toBe('Property.Roof.Corrugated');
    expect(displayVariationKey('Property')).toBe('Property');
  });
});

describe('displayMapping', () => {
  it('shows a field target, a lookup target and an expansion target in their natural shapes', () => {
    expect(displayMapping({ suggestedFieldName: 'Buyer' })).toBe('Buyer');
    expect(displayMapping({ suggestedLegacyODataValue: 'EdmDate' })).toBe('EdmDate');
    expect(displayMapping({ suggestedStandardLookupValue: 'Corrugated Steel' })).toBe('Corrugated Steel');
    expect(displayMapping({ suggestedResourceName: 'Property', suggestedFieldName: 'OpenHouses' })).toBe('Property.OpenHouses');
  });
  it('is a dash when there is no mapping', () => {
    expect(displayMapping(null)).toBe('-');
    expect(displayMapping({})).toBe('-');
  });
});

describe('formatReviewItemsTable', () => {
  it('renders one row per item with the tuple count and the earliest submission', () => {
    const out = formatReviewItemsTable([item()]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^status\s+element\s+mapping\s+strategy\s+tuples\s+first submitted\s+outcome$/);
    expect(lines[2]).toMatch(/^pending\s+Property\.BuyerAgentKeyNumeric\s+Buyer\s+-\s+2\s+2026-08-28T08:25:02\s+-$/);
  });
  it('shows the strategy when the pool has one and the outcome once decided', () => {
    const out = formatReviewItemsTable([item({ strategy: 'Substring', status: 'resolved', outcome: 'ignored' })]);
    expect(out.split('\n')[2]).toMatch(/^resolved\s+Property\.BuyerAgentKeyNumeric\s+Buyer\s+Substring\s+2\s+2026-08-28T08:25:02\s+ignored$/);
  });
  it('says so when there is nothing', () => {
    expect(formatReviewItemsTable([])).toBe('No items in review.');
  });
});

describe('formatProvenance', () => {
  it('lists every tuple under its item, in the order served', () => {
    const out = formatProvenance([item()]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Property.BuyerAgentKeyNumeric → Buyer [pending]');
    expect(lines[1]).toMatch(/^ {2}2026-09-16T15:27:11 {2}T00000001\/1001\/M00000001 {2}by T00000009 {2}qa {2}admin$/);
    expect(lines[2]).toMatch(/^ {2}2026-08-28T08:25:02 {2}T00000002\/1002\/M00000002 {2}by T00000009 {2}qa {2}admin$/);
  });
});

describe('formatEndorsementStatusTable', () => {
  it('renders one row per submission with both statuses', () => {
    const out = formatEndorsementStatusTable([
      {
        providerUoi: 'T00000001',
        providerUsi: '1001',
        recipientUoi: 'M00000001',
        endorsementId: 'M00000001-T00000001-1001-data-dictionary-2.1-abc',
        endorsement: 'data-dictionary',
        version: '2.1',
        lifecycleStatus: 'in-review',
        reviewStatus: 'in-review',
        updatedAt: '2026-09-16T15:27:11.915Z',
      },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^provider\s+usi\s+recipient\s+endorsement\s+version\s+lifecycle\s+review\s+updated$/);
    expect(lines[2]).toMatch(/^T00000001\s+1001\s+M00000001\s+data-dictionary\s+2\.1\s+in-review\s+in-review\s+2026-09-16T15:27:11$/);
  });
  it('says so when there is nothing', () => {
    expect(formatEndorsementStatusTable([])).toBe('No submissions.');
  });
});
