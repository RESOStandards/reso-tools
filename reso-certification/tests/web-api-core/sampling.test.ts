import { describe, it, expect } from 'vitest';
import { detectEnumMode } from '../../src/web-api-core/sampling.js';
import type { EntityType } from '../../src/test-runner/types.js';

const makeEntityType = (properties: ReadonlyArray<{ name: string; type: string; annotations?: Record<string, string> }>): EntityType => ({
  name: 'TestEntity',
  keyProperties: ['TestKey'],
  properties: properties.map(p => ({
    name: p.name,
    type: p.type,
    annotations: p.annotations,
  })),
});

describe('detectEnumMode', () => {
  it('detects string mode from Edm.String with LookupName annotation', () => {
    const entityType = makeEntityType([
      { name: 'ListingKey', type: 'Edm.String' },
      { name: 'StandardStatus', type: 'Edm.String', annotations: { 'RESO.OData.Metadata.LookupName': 'StandardStatus' } },
      { name: 'ListPrice', type: 'Edm.Decimal' },
    ]);
    expect(detectEnumMode(entityType)).toBe('string');
  });

  it('detects collections mode from Collection(org.reso.metadata.enums.*)', () => {
    const entityType = makeEntityType([
      { name: 'ListingKey', type: 'Edm.String' },
      { name: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus' },
      { name: 'Features', type: 'Collection(org.reso.metadata.enums.Features)' },
    ]);
    expect(detectEnumMode(entityType)).toBe('collections');
  });

  it('detects isflags mode from org.reso.metadata.enums.* without collections', () => {
    const entityType = makeEntityType([
      { name: 'ListingKey', type: 'Edm.String' },
      { name: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus' },
      { name: 'ListPrice', type: 'Edm.Decimal' },
    ]);
    expect(detectEnumMode(entityType)).toBe('isflags');
  });

  it('defaults to string mode when no enum fields exist', () => {
    const entityType = makeEntityType([
      { name: 'ListingKey', type: 'Edm.String' },
      { name: 'ListPrice', type: 'Edm.Decimal' },
      { name: 'BedroomsTotal', type: 'Edm.Int32' },
    ]);
    expect(detectEnumMode(entityType)).toBe('string');
  });

  it('string mode takes priority over enum types when both present', () => {
    const entityType = makeEntityType([
      { name: 'StandardStatus', type: 'Edm.String', annotations: { 'RESO.OData.Metadata.LookupName': 'StandardStatus' } },
      { name: 'OtherField', type: 'org.reso.metadata.enums.SomeEnum' },
    ]);
    expect(detectEnumMode(entityType)).toBe('string');
  });
});
