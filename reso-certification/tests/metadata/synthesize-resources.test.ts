import { describe, it, expect } from 'vitest';
import { synthesizeResourcesFromFields } from '../../src/metadata/synthesize-resources.js';
import type { MetadataReport, MetadataReportField } from '@reso-standards/reso-metadata-utils';

// Tiny field-shape factory so each test can build readable fixtures
// without restating the full MetadataReportField structure every time.
const field = (resourceName: string, fieldName: string): MetadataReportField => ({
  resourceName,
  fieldName,
  type: 'Edm.String',
  annotations: [],
});

const baseReport = (overrides: Partial<MetadataReport> = {}): MetadataReport => ({
  description: 'RESO Data Dictionary Metadata Report',
  version: '2.0',
  generatedOn: '2026-04-08T00:00:00.000Z',
  resources: [],
  fields: [],
  lookups: [],
  ...overrides,
});

describe('synthesizeResourcesFromFields', () => {
  describe('synthesis path (DD 2.0/2.1 reports without a resources block)', () => {
    it('derives a resources array from distinct field.resourceName values', () => {
      const report = baseReport({
        fields: [
          field('Property', 'ListingKey'),
          field('Property', 'ListPrice'),
          field('Member', 'MemberKey'),
          field('Office', 'OfficeKey'),
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toEqual([
        { resourceName: 'Member' },
        { resourceName: 'Office' },
        { resourceName: 'Property' },
      ]);
    });

    it('produces a stable, alphabetically sorted resource list', () => {
      // The fields are inserted in a deliberately non-alphabetical order
      // so the test fails loudly if anything ever returns input order.
      const report = baseReport({
        fields: [
          field('OpenHouse', 'OpenHouseKey'),
          field('Property', 'ListingKey'),
          field('Media', 'MediaKey'),
          field('Member', 'MemberKey'),
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources.map(r => r.resourceName)).toEqual([
        'Media',
        'Member',
        'OpenHouse',
        'Property',
      ]);
    });

    it('deduplicates repeated resource names', () => {
      const report = baseReport({
        fields: [
          field('Property', 'ListingKey'),
          field('Property', 'ListPrice'),
          field('Property', 'BedroomsTotal'),
          field('Member', 'MemberKey'),
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toHaveLength(2);
      expect(result.resources).toEqual([
        { resourceName: 'Member' },
        { resourceName: 'Property' },
      ]);
    });

    it('triggers synthesis when resources is undefined (older report shape)', () => {
      // Some on-disk reports omit `resources` entirely. The type says
      // it is required, but the helper has to be lenient about input
      // it parses from disk. Construct via the type-system back door.
      const report = {
        description: 'Old DD 2.0 report',
        version: '2.0',
        generatedOn: '2026-04-08T00:00:00.000Z',
        fields: [field('Property', 'ListingKey')],
        lookups: [],
      } as unknown as MetadataReport;

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toEqual([{ resourceName: 'Property' }]);
    });

    it('skips fields with missing or empty resourceName values', () => {
      // Defensive: a malformed field with an empty resourceName should
      // not produce a `{ resourceName: '' }` entry in the output.
      const report = baseReport({
        fields: [
          field('Property', 'ListingKey'),
          { ...field('', 'Junk'), resourceName: '' },
          field('Member', 'MemberKey'),
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toEqual([
        { resourceName: 'Member' },
        { resourceName: 'Property' },
      ]);
    });

    it('preserves all other top-level fields on the report', () => {
      const report = baseReport({
        description: 'A specific description',
        version: '2.1',
        generatedOn: '2025-12-01T12:34:56.000Z',
        fields: [field('Property', 'ListingKey')],
        lookups: [
          {
            lookupName: 'org.reso.metadata.enums.StandardStatus',
            lookupValue: 'Active',
            type: 'Edm.Int32',
          },
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.description).toBe('A specific description');
      expect(result.version).toBe('2.1');
      expect(result.generatedOn).toBe('2025-12-01T12:34:56.000Z');
      expect(result.fields).toBe(report.fields);
      expect(result.lookups).toBe(report.lookups);
    });
  });

  describe('idempotent path (report already has a populated resources block)', () => {
    it('returns the input unchanged when resources is already populated', () => {
      const report = baseReport({
        resources: [{ resourceName: 'Property' }, { resourceName: 'Member' }],
        fields: [field('Property', 'ListingKey')],
      });

      const result = synthesizeResourcesFromFields(report);

      // Reference equality — the input is returned as-is, not cloned
      expect(result).toBe(report);
    });

    it('preserves extra properties on existing resource entries (DD 2.2 forward-compatibility)', () => {
      // The MetadataReportResource type uses an index signature so
      // future DD 2.2 fields (description, complex types, etc.) pass
      // through. The adapter must not strip them when the input is
      // already populated.
      const report = baseReport({
        resources: [
          {
            resourceName: 'Property',
            wikiPageURL: 'https://dd.reso.org/DD2.0/Property',
            description: 'A real estate property listing',
            // Hypothetical DD 2.2 fields we want to make sure pass through
            complexTypes: ['Address', 'Geocoordinates'],
            primaryKey: 'ListingKey',
          },
        ],
        fields: [field('Property', 'ListingKey')],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources[0]).toEqual({
        resourceName: 'Property',
        wikiPageURL: 'https://dd.reso.org/DD2.0/Property',
        description: 'A real estate property listing',
        complexTypes: ['Address', 'Geocoordinates'],
        primaryKey: 'ListingKey',
      });
    });

    it('does not synthesize when resources contains a single populated entry', () => {
      // Edge case: even a single-item resources array counts as
      // populated. Synthesis only fires when the array is empty or
      // missing entirely.
      const report = baseReport({
        resources: [{ resourceName: 'Property' }],
        fields: [
          field('Property', 'ListingKey'),
          field('Member', 'MemberKey'),
          field('Office', 'OfficeKey'),
        ],
      });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].resourceName).toBe('Property');
    });
  });

  describe('edge cases', () => {
    it('returns an empty resources array when there are no fields', () => {
      const report = baseReport({ fields: [] });

      const result = synthesizeResourcesFromFields(report);

      expect(result.resources).toEqual([]);
    });
  });
});
