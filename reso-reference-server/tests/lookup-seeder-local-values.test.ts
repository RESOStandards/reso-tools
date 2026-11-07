/**
 * Lookup rows for local values (2026-11-06). A local value has no StandardName: it is written as a provider's local
 * Lookup Resource row reads as metadata (reso-certification `metadata/lookup-resource.ts`), the display value as the
 * lookupValue and its OData name as the LegacyODataValue. The seeder gave every value a StandardLookupValue and the
 * lookupValue as its OData name, so a local value read as standard and its OData name had spaces in it, as a local
 * OrganizationType value such as Local Association would.
 */

import { describe, expect, it } from 'vitest';
import { buildLookupRecords } from '../src/metadata/lookup-seeder.js';
import type { ResoMetadata } from '../src/metadata/types.js';

const metadata = {
  generatedOn: '2026-11-06T00:00:00.000Z',
  lookups: [
    {
      lookupName: 'org.reso.metadata.enums.StandardStatus',
      lookupValue: 'ActiveUnderContract',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Active Under Contract' },
        { term: 'RESO.OData.Metadata.LegacyODataValue', value: 'ActiveUnderContract' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.OrganizationType',
      lookupValue: 'Local Association',
      type: 'Edm.Int32',
      annotations: [{ term: 'RESO.OData.Metadata.LegacyODataValue', value: 'LocalAssociation' }]
    },
    { lookupName: 'org.reso.metadata.enums.City', lookupValue: 'Cleveland', type: 'Edm.Int32' }
  ]
} as unknown as ResoMetadata;

describe('the Lookup rows the seeder builds', () => {
  const [standard, local, bare] = buildLookupRecords(metadata);

  it('gives a standard value its standard name, as before', () => {
    expect(standard).toMatchObject({
      LookupName: 'StandardStatus',
      LookupValue: 'Active Under Contract',
      StandardLookupValue: 'Active Under Contract',
      LegacyODataValue: 'ActiveUnderContract'
    });
  });

  it('gives a local value no standard name, and its OData name from the metadata', () => {
    expect(local).toMatchObject({
      LookupName: 'OrganizationType',
      LookupValue: 'Local Association',
      StandardLookupValue: null,
      LegacyODataValue: 'LocalAssociation'
    });
  });

  it('falls back to the lookupValue for an OData name the metadata does not give', () => {
    expect(bare).toMatchObject({ LookupName: 'City', LookupValue: 'Cleveland', StandardLookupValue: null, LegacyODataValue: 'Cleveland' });
  });
});
