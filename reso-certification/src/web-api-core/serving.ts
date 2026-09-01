/**
 * Web API Core "declared-but-not-served" detection (the Core 2.1.0 carve-out).
 *
 * A resource may be DECLARED at the top level (an EntitySet in `<EntityContainer>`, or merely an
 * EntityType in `$metadata`) yet NOT SERVED there (a GET 404s / is inaccessible). Per the workgroup
 * carve-out — Core 2.1.0+ ONLY — declared-but-not-served is acceptable for most resources, but a fixed
 * set (Property, Member, Office, Field, Lookup) must always be served if declared.
 *
 * The overriding rule is anti-false-PASS: we MASK a resource's scenarios only on positive, determinate
 * evidence that it is absent from the served top-level set. That evidence must come from BOTH authoritative
 * surfaces agreeing:
 *   1. the OData **service document** (runtime truth of what is served), and
 *   2. the EDMX **EntityContainer** EntitySets (declared truth), resolved through each set's EntityType.
 * If either surface is indeterminate, or the two disagree (one says present, the other absent), we run the
 * resource exactly as today — a declared-but-404ing resource then fails for real instead of being masked.
 */

import type { EntityType, ParsedEntitySet } from '../test-runner/types.js';
import { REQUIRED_RESOURCES_V21, WELL_KNOWN_RESOURCES } from './sampling.js';

/** Whether a resource is PRESENT / ABSENT in a served-top-level surface, or the surface is INDETERMINATE. */
export type Presence = 'present' | 'absent' | 'indeterminate';

/** What the serving detection dictates for a resource: run its scenarios as today, one clean FAIL, or NA. */
export type ServingDecision = 'run' | 'fail' | 'na';

/** Resources eligible for the carve-out: the always-top-level required set (P/M/O/F/L) plus the other
 *  well-known resources (Media, OpenHouse, Showing). Anything outside this set always runs as today —
 *  we never mask a resource we don't recognize. */
const MASKABLE_RESOURCES: ReadonlySet<string> = new Set<string>([
  ...WELL_KNOWN_RESOURCES.map(r => r.resource),
  ...REQUIRED_RESOURCES_V21
]);

/**
 * Parse an OData service document body into the set of served top-level EntitySet names.
 *
 * Returns `undefined` (INDETERMINATE) unless the body is a real, COMPLETE service document — only a
 * trustworthy doc can prove a resource ABSENT:
 *   - `@odata.context` is a string whose last path segment is `$metadata`,
 *   - `value` is a NON-EMPTY array,
 *   - there is NO `@odata.nextLink` (a paged/partial doc can't prove absence).
 * Any other shape (non-object, missing/wrong context, absent/empty `value`, or a paged doc) ⇒ `undefined`.
 *
 * Non-EntitySet entries (singletons, function imports) are harmless to include: a stray match only makes a
 * resource look PRESENT, which biases toward running it (never toward a false mask).
 */
export const parseServiceDocument = (body: unknown): ReadonlySet<string> | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;

  const context = obj['@odata.context'];
  if (typeof context !== 'string' || context.split('/').pop() !== '$metadata') return undefined;

  // A paged/incomplete doc lists only some sets — it can never prove a resource absent.
  if (obj['@odata.nextLink'] != null) return undefined;

  const value = obj.value;
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const names = value
    .map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  // A non-empty `value` that yields no usable names is malformed — treat as INDETERMINATE, never as an
  // empty served set (which would read every resource as ABSENT and risk a false mask).
  return names.length === 0 ? undefined : new Set(names);
};

/** Surface 1 — the service document. `undefined` served-set ⇒ INDETERMINATE; else membership by set name. */
export const servedPresence = (served: ReadonlySet<string> | undefined, resource: string): Presence =>
  served === undefined ? 'indeterminate' : served.has(resource) ? 'present' : 'absent';

/**
 * Surface 2 — the EDMX EntityContainer's EntitySets, resolved through each set's underlying EntityType (NOT
 * by set name). No container / zero sets ⇒ INDETERMINATE (the surface says nothing). Otherwise PRESENT iff
 * some declared set exposes the resource's EntityType.
 */
export const declaredPresence = (
  entitySets: ReadonlyArray<ParsedEntitySet> | undefined,
  entityType: EntityType
): Presence =>
  entitySets === undefined || entitySets.length === 0
    ? 'indeterminate'
    : entitySets.some(es => es.entityType === entityType.name)
      ? 'present'
      : 'absent';

/**
 * Decide how to handle a resource under the Core 2.1.0 declared-but-not-served carve-out.
 *
 * `run` — run the resource's scenarios exactly as today. This is the default and the ONLY safe answer on any
 *   doubt: Core 2.0.0 (the carve-out is 2.1.0+ only), a resource we don't recognize, an indeterminate surface,
 *   or the two surfaces disagreeing (the anti-false-PASS guard — a declared-but-404ing resource stays in the
 *   run and fails for real).
 * `fail` — a determinately declared-but-not-served REQUIRED resource (P/M/O/F/L): one clean failure.
 * `na`   — a determinately declared-but-not-served non-required well-known resource (Media, …): Not Applicable
 *   (it may be available only via `$expand`).
 */
export const resolveServingDecision = (args: {
  readonly resource: string;
  readonly entityType: EntityType;
  readonly version: '2.0.0' | '2.1.0';
  readonly servedEntitySets: ReadonlySet<string> | undefined;
  readonly declaredEntitySets: ReadonlyArray<ParsedEntitySet> | undefined;
}): ServingDecision => {
  const { resource, entityType, version, servedEntitySets, declaredEntitySets } = args;

  // The carve-out is gated to Core 2.1.0+; 2.0.0 behaves exactly as written today (declared ⇒ assumed served).
  if (version === '2.0.0') return 'run';
  // Only recognized (well-known / required) resources are eligible to be masked.
  if (!MASKABLE_RESOURCES.has(resource)) return 'run';

  const served = servedPresence(servedEntitySets, resource);
  const declared = declaredPresence(declaredEntitySets, entityType);

  // Mask ONLY when BOTH surfaces are determinate AND BOTH say ABSENT. Any indeterminate surface, or a
  // disagreement (one present, one absent), keeps the resource in the run.
  if (served !== 'absent' || declared !== 'absent') return 'run';

  // Determinately declared-but-not-served: required resources are a clean FAIL; others are Not Applicable.
  return REQUIRED_RESOURCES_V21.includes(resource) ? 'fail' : 'na';
};
