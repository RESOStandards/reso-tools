import { describe, expect, it, vi } from 'vitest';
import { createLookupResolver } from '../src/lookup/resolver.js';
import type { CsdlSchema } from '../src/csdl/types.js';

/** Minimal schema with CSDL enum types and a Lookup entity set. */
const schemaWithLookupResource: CsdlSchema = {
  namespace: 'org.reso.metadata',
  entityTypes: [
    {
      name: 'Property',
      key: ['ListingKey'],
      properties: [
        { name: 'ListingKey', type: 'Edm.String' },
        { name: 'StandardStatus', type: 'Edm.String', annotations: { 'RESO.OData.Metadata.LookupName': 'StandardStatus' } },
        { name: 'City', type: 'Edm.String' },
        { name: 'PropertyType', type: 'org.reso.metadata.PropertyType' }
      ],
      navigationProperties: []
    },
    {
      name: 'Lookup',
      key: ['LookupKey'],
      properties: [
        { name: 'LookupKey', type: 'Edm.String' },
        { name: 'LookupName', type: 'Edm.String' },
        { name: 'LookupValue', type: 'Edm.String' }
      ],
      navigationProperties: []
    }
  ],
  enumTypes: [
    {
      name: 'PropertyType',
      members: [
        { name: 'Residential', value: '0' },
        { name: 'Commercial', value: '1' },
        { name: 'Land', value: '2' }
      ]
    },
    {
      name: 'StandardStatus',
      members: [
        { name: 'Active', value: '0' },
        { name: 'Pending', value: '1' }
      ]
    }
  ],
  complexTypes: [],
  actions: [],
  functions: [],
  entityContainer: {
    name: 'Default',
    entitySets: [
      { name: 'Property', entityType: 'org.reso.metadata.Property' },
      { name: 'Lookup', entityType: 'org.reso.metadata.Lookup' }
    ],
    singletons: [],
    actionImports: [],
    functionImports: []
  }
};

/** Schema without a Lookup entity set — CSDL enums only. */
const schemaWithoutLookupResource: CsdlSchema = {
  ...schemaWithLookupResource,
  entityTypes: schemaWithLookupResource.entityTypes.filter(et => et.name !== 'Lookup'),
  entityContainer: {
    name: 'Default',
    entitySets: [
      { name: 'Property', entityType: 'org.reso.metadata.Property' }
    ],
    singletons: [],
    actionImports: [],
    functionImports: []
  }
};

/** Mock fetch that returns Lookup Resource results. */
const mockFetchLookup = (lookupName: string, values: ReadonlyArray<string>) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      value: values.map(v => ({ LookupName: lookupName, LookupValue: v }))
    })
  });

describe('createLookupResolver', () => {
  it('detects hasLookupResource when Lookup entity set exists', () => {
    const resolver = createLookupResolver({ schema: schemaWithLookupResource });
    expect(resolver.hasLookupResource).toBe(true);
  });

  it('detects hasLookupResource = false when no Lookup entity set', () => {
    const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
    expect(resolver.hasLookupResource).toBe(false);
  });

  describe('resolveLookups', () => {
    it('resolves CSDL enum type members when no Lookup Resource', async () => {
      const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
      const values = await resolver.resolveLookups('PropertyType');
      expect(values).toEqual([
        { lookupName: 'PropertyType', lookupValue: 'Residential' },
        { lookupName: 'PropertyType', lookupValue: 'Commercial' },
        { lookupName: 'PropertyType', lookupValue: 'Land' }
      ]);
    });

    it('fetches from Lookup Resource when available', async () => {
      const fetchFn = mockFetchLookup('StandardStatus', ['Active', 'Closed', 'Pending']);
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        fetchFn
      });

      const values = await resolver.resolveLookups('StandardStatus');
      expect(values).toEqual([
        { lookupName: 'StandardStatus', lookupValue: 'Active' },
        { lookupName: 'StandardStatus', lookupValue: 'Closed' },
        { lookupName: 'StandardStatus', lookupValue: 'Pending' }
      ]);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(fetchFn.mock.calls[0][0]).toContain('/Lookup?');
      expect(fetchFn.mock.calls[0][0]).toContain('StandardStatus');
    });

    it('falls back to CSDL enums when Lookup Resource fetch fails', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        fetchFn
      });

      const values = await resolver.resolveLookups('StandardStatus');
      // Falls back to CSDL enum members
      expect(values).toEqual([
        { lookupName: 'StandardStatus', lookupValue: 'Active' },
        { lookupName: 'StandardStatus', lookupValue: 'Pending' }
      ]);
    });

    it('falls back to CSDL enums when Lookup Resource returns empty', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: [] })
      });
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        fetchFn
      });

      const values = await resolver.resolveLookups('PropertyType');
      expect(values).toEqual([
        { lookupName: 'PropertyType', lookupValue: 'Residential' },
        { lookupName: 'PropertyType', lookupValue: 'Commercial' },
        { lookupName: 'PropertyType', lookupValue: 'Land' }
      ]);
    });

    it('caches resolved lookups', async () => {
      const fetchFn = mockFetchLookup('StandardStatus', ['Active']);
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        fetchFn
      });

      await resolver.resolveLookups('StandardStatus');
      await resolver.resolveLookups('StandardStatus');
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('returns empty array for unknown lookup name', async () => {
      const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
      const values = await resolver.resolveLookups('NonExistent');
      expect(values).toEqual([]);
    });

    it('includes bearer token in Authorization header', async () => {
      const fetchFn = mockFetchLookup('StandardStatus', ['Active']);
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        token: 'my-token',
        fetchFn
      });

      await resolver.resolveLookups('StandardStatus');
      const headers = fetchFn.mock.calls[0][1]?.headers;
      expect(headers?.Authorization).toBe('Bearer my-token');
    });
  });

  describe('resolveLookupsForResource', () => {
    it('returns lookups keyed by field name for CSDL enums', async () => {
      const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
      const result = await resolver.resolveLookupsForResource('Property');

      // StandardStatus has LookupName annotation → resolves by lookupName
      // PropertyType has CSDL enum type → resolves by type name
      expect(Object.keys(result).sort()).toEqual(['PropertyType', 'StandardStatus']);
      expect(result.PropertyType[0].lookupValue).toBe('Residential');
      expect(result.StandardStatus[0].lookupValue).toBe('Active');
    });

    it('fetches Lookup Resource values for fields with LookupName', async () => {
      const fetchFn = mockFetchLookup('StandardStatus', ['Active', 'Closed', 'Pending']);
      const resolver = createLookupResolver({
        schema: schemaWithLookupResource,
        baseUrl: 'https://api.example.com',
        fetchFn
      });

      const result = await resolver.resolveLookupsForResource('Property');
      expect(result.StandardStatus).toHaveLength(3);
      expect(result.StandardStatus[0].lookupValue).toBe('Active');
    });

    it('returns empty object for unknown resource', async () => {
      const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
      const result = await resolver.resolveLookupsForResource('NonExistent');
      expect(result).toEqual({});
    });

    it('excludes fields that have no lookup values', async () => {
      const resolver = createLookupResolver({ schema: schemaWithoutLookupResource });
      const result = await resolver.resolveLookupsForResource('Property');

      // City and ListingKey are plain Edm.String, should not appear
      expect(result).not.toHaveProperty('City');
      expect(result).not.toHaveProperty('ListingKey');
    });
  });
});
