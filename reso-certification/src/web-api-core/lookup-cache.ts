/**
 * Per-run cache of provider Lookup Resource rows, keyed by the provider's LookupName.
 *
 * The Web API Core Lookup Resource scenario (RCP-032/039) fetches EVERY `/Lookup` row for a field's LookupName
 * to prove the field's sampled values are published there. Many fields across many resources share ONE
 * LookupName (the Lookup Resource is deliberately shared), so keying the cache by LookupName lets a second
 * field that references an already-fetched LookupName reuse those rows instead of re-paging the whole enum —
 * the cache-hit win. Scope is ONE run: the cache is created per run in `sampleAndTest` and threaded down, never
 * a module-level global, so no run ever sees another run's stale rows.
 *
 * A row's value is polymorphic across THREE legal wire forms — the human `LookupValue`, the DD-standard
 * display `StandardLookupValue`, and the machine `LegacyODataValue` — and a provider may serve a data value as
 * any of them, so membership unions all three. `toStandard` maps any form back to the row's StandardLookupValue.
 *
 * Mirrors `standard-map.ts`: a plain object of closures over a captured `Map`, the local mutable state scoped
 * to the builder and read-only through the returned interface — never leaked.
 */

/** A parsed /Lookup row. The three columns whose union forms a value's legal wire forms. */
const LOOKUP_VALUE_FIELD = 'LookupValue';
const STANDARD_LOOKUP_VALUE_FIELD = 'StandardLookupValue';
const LEGACY_ODATA_VALUE_FIELD = 'LegacyODataValue';

/** A per-run cache of /Lookup rows keyed internally by the provider's LookupName; queried by (resource, field). */
export interface LookupCache {
  /** Store the fetched rows for a LookupName. Idempotent — a LookupName already filled is left as-is, so a
   *  shared LookupName is fetched at most once across the run (the cache-hit dedup). */
  readonly put: (lookupName: string, rows: ReadonlyArray<Record<string, unknown>>) => void;
  /** True when `value` appears on any cached row for the field's LookupName under ANY of the three legal wire
   *  forms (LookupValue | StandardLookupValue | LegacyODataValue). */
  readonly has: (resource: string, field: string, value: string) => boolean;
  /** The StandardLookupValue of the cached row that carries `value` in any wire form, or undefined when no
   *  cached row matches (or the row has no StandardLookupValue). */
  readonly toStandard: (resource: string, field: string, value: string) => string | undefined;
  /** The cached rows for the field's LookupName, or undefined when that LookupName was never filled (a cache
   *  miss — the caller must fetch). Used by the SLV-validity pass and the fetch-skip on a cache hit. */
  readonly rowsFor: (resource: string, field: string) => ReadonlyArray<Record<string, unknown>> | undefined;
}

/** A filled cache entry: the rows plus a membership set unioning all three value forms across them. */
interface CachedLookup {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly members: ReadonlySet<string>;
}

/** The three value forms present on a /Lookup row, as strings, null/undefined dropped. */
const valueFormsOf = (row: Record<string, unknown>): ReadonlyArray<string> =>
  [row[LOOKUP_VALUE_FIELD], row[STANDARD_LOOKUP_VALUE_FIELD], row[LEGACY_ODATA_VALUE_FIELD]]
    .filter((v) => v != null)
    .map((v) => String(v));

/**
 * Build a {@link LookupCache}. `deps.lookupNameFor` resolves a (resource, field) pair to the provider's
 * LookupName (off the per-resource `TestParams.lookupNameByField`); when it can't, the field name is the
 * fallback key — mirroring the Lookup Resource assertion's `?? field`, so the put key and the query key agree.
 */
export const createLookupCache = (deps: {
  readonly lookupNameFor: (resource: string, field: string) => string | undefined;
}): LookupCache => {
  // Local mutable store, scoped to this run and read-only through the returned closures — never leaked. Keyed
  // by LookupName so fields that share a LookupName dedupe to ONE entry (the cache-hit win).
  const store = new Map<string, CachedLookup>();

  const resolveName = (resource: string, field: string): string => deps.lookupNameFor(resource, field) ?? field;

  const put = (lookupName: string, rows: ReadonlyArray<Record<string, unknown>>): void => {
    if (store.has(lookupName)) return; // idempotent — a shared LookupName is filled exactly once
    const members = new Set<string>(rows.flatMap(valueFormsOf));
    store.set(lookupName, { rows, members });
  };

  const has = (resource: string, field: string, value: string): boolean =>
    store.get(resolveName(resource, field))?.members.has(value) ?? false;

  const toStandard = (resource: string, field: string, value: string): string | undefined => {
    const row = store.get(resolveName(resource, field))?.rows.find((r) => valueFormsOf(r).includes(value));
    const slv = row?.[STANDARD_LOOKUP_VALUE_FIELD];
    return slv != null ? String(slv) : undefined;
  };

  const rowsFor = (resource: string, field: string): ReadonlyArray<Record<string, unknown>> | undefined =>
    store.get(resolveName(resource, field))?.rows;

  return { put, has, toStandard, rowsFor };
};
