import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getKeyFieldForResource } from '@reso-standards/reso-common';

/**
 * Key-coverage invariant for the DD reference data.
 *
 * The DD does not encode primary keys through 2.1, so generateEdmx resolves each resource's key
 * via getKeyFieldForResource (the Commander exceptions + the {ResourceName}Key convention). If a
 * future DD revision adds a resource whose real key is neither a listed exception nor the
 * convention, the generated <Key> would reference a non-existent property and emit invalid EDMX.
 *
 * This guard fails loudly in that case: for every resource in every shipped DD version, the
 * resolved key MUST be an actual field of that resource. When it fails, the fix is to add the new
 * resource's key to KEY_FIELD_MAP (until DD 2.2 carries keys in the spec).
 */

interface DdShape {
  readonly resources: ReadonlyArray<string | { readonly resourceName: string }>;
  readonly fields: ReadonlyArray<{ readonly resourceName: string; readonly fieldName: string }>;
}

const loadDd = (version: string): DdShape =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../reference-metadata/dd-${version}.json`, import.meta.url)), 'utf8'));

const resourceNameOf = (r: string | { readonly resourceName: string }): string =>
  typeof r === 'string' ? r : r.resourceName;

describe('DD key coverage — every resolved key is a real field', () => {
  it.each(['1.7', '2.0', '2.1'])('DD %s: getKeyFieldForResource resolves to an existing field for every resource', (version) => {
    const dd = loadDd(version);

    const fieldsByResource = dd.fields.reduce((acc, f) => {
      const set = acc.get(f.resourceName) ?? new Set<string>();
      set.add(f.fieldName);
      return acc.set(f.resourceName, set);
    }, new Map<string, Set<string>>());

    const missing = dd.resources
      .map(resourceNameOf)
      .map(resource => ({ resource, key: getKeyFieldForResource(resource) }))
      .filter(({ resource, key }) => !(fieldsByResource.get(resource)?.has(key) ?? false));

    // Empty array on success; on failure the resource + the bogus resolved key are visible.
    expect(missing).toEqual([]);
  });
});
