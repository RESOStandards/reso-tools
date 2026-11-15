/**
 * The quick scan for full type coverage across resources, run on the metadata before any record is sampled.
 *
 * Full type coverage is always required, and the types a server has are read across every resource it declares,
 * whichever resources a run tests (Josh, 2026-11-15: "full coverage checking beyond the current resource (just like we
 * do in other cases) if only one resource is selected"; "we need to make sure someone can't just select a resource with
 * one type, choose full coverage, and then pass"). A type the server declares only on resources the run will not test
 * cannot be met by it, so the run says so at once and how to reach full coverage: "test another resource that looks like
 * it has full coverage (we could identify candidates), or have them test across all resources to meet full coverage if
 * one resource doesn't have every type", and "It's a quick scan too so we can tell them quickly."
 *
 * The scan never fails a run the coverage step would pass. It flags a type only when it is declared on a resource the
 * run will not test (so the coverage step counts it as declared, `core.ts` `unsampled`) and no resource the run tests
 * has a field that selection could fill that type's slot with (so the coverage step cannot meet it). "Could fill" is
 * read the way selection reads a field (the scalar type lists of `sampling.ts`, `resolveEnum` for lookups) and always
 * includes what `declaredCoreType` declares, so it is never narrower than "declares".
 */

import { resolveEnum } from '@reso-standards/reso-client';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import type { EntityProperty } from '../test-runner/types.js';
import { type CoreType, declaredCoreType } from './declared-types.js';
import { isMultiRep, isSingleRep } from './enum-selection.js';
import { CORE_TYPES, TYPES_REQUIRED } from './type-coverage.js';

/** The Core types one resource declares, and the ones a field of it could fill when tested. */
export interface ResourceTypes {
  readonly resource: string;
  readonly declared: ReadonlyArray<CoreType>;
  readonly fillable: ReadonlyArray<CoreType>;
}

/** A type the server declares that no resource the run tests can meet, with the resources that declare it. */
export interface UnreachableType {
  readonly type: CoreType;
  readonly declaredOn: ReadonlyArray<string>;
}

export interface CoverageScan {
  /** Types the server declares only on resources the run will not test. Empty when the run can meet every type. */
  readonly unreachable: ReadonlyArray<UnreachableType>;
  /** Resources that declare every type the server declares: any one of them, tested alone, could meet full coverage. */
  readonly wholeResources: ReadonlyArray<string>;
}

/** The scalar types selection reads (`sampling.ts` INTEGER_TYPES, DECIMAL_TYPES, DATE_TYPES, DATETIME_TYPES). */
const SCALAR_FILL: Readonly<Record<string, CoreType>> = {
  'Edm.Int16': 'integer',
  'Edm.Int32': 'integer',
  'Edm.Int64': 'integer',
  'Edm.Decimal': 'decimal',
  'Edm.Double': 'decimal',
  'Edm.Date': 'date',
  'Edm.DateTimeOffset': 'timestamp'
};

/** The type a field could fill when its resource is tested, read as selection reads it. */
const fillableType = (property: EntityProperty, enumTypes: ReadonlyArray<CsdlEnumType>): CoreType | undefined => {
  const scalar = SCALAR_FILL[property.type];
  if (scalar !== undefined) return scalar;
  const field = resolveEnum(
    { name: property.name, type: property.type, ...(property.annotations && { annotations: property.annotations }) },
    { enumTypes }
  );
  if (field === null) return undefined;
  if (isSingleRep(field.representation)) return 'singleLookup';
  return isMultiRep(field.representation) ? 'multiLookup' : undefined;
};

const inOrder = (types: ReadonlySet<CoreType>): ReadonlyArray<CoreType> => CORE_TYPES.filter(type => types.has(type));

/** What one resource's metadata declares, and what its fields could fill. */
export const resourceTypesOf = (
  resource: string,
  properties: ReadonlyArray<EntityProperty>,
  enumTypes: ReadonlyArray<CsdlEnumType>
): ResourceTypes => {
  const declared = new Set(properties.flatMap(p => declaredCoreType(p, enumTypes) ?? []));
  const fillable = new Set([...declared, ...properties.flatMap(p => fillableType(p, enumTypes) ?? [])]);
  return { resource, declared: inOrder(declared), fillable: inOrder(fillable) };
};

/** Which types the server declares that the resources to be tested cannot meet, and which resources carry every type. */
export const scanResourceCoverage = (resources: ReadonlyArray<ResourceTypes>, tested: ReadonlyArray<string>): CoverageScan => {
  const isTested = (resource: string): boolean => tested.includes(resource);
  const serverTypes = CORE_TYPES.filter(type => resources.some(r => r.declared.includes(type)));
  const fillableOnTested = new Set(resources.filter(r => isTested(r.resource)).flatMap(r => r.fillable));
  const unreachable = serverTypes
    .filter(type => !fillableOnTested.has(type))
    .map(type => ({ type, declaredOn: resources.filter(r => !isTested(r.resource) && r.declared.includes(type)).map(r => r.resource) }));
  const wholeResources = resources.filter(r => serverTypes.every(type => r.declared.includes(type))).map(r => r.resource);
  return { unreachable, wholeResources };
};

const NAME_RESOURCES = 'name resources with --resources';

const listed = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** How many resources the reason names per type; a server with many resources would otherwise bury the advice. */
const RESOURCES_NAMED = 3;
const someOf = (items: ReadonlyArray<string>): string =>
  items.length <= RESOURCES_NAMED
    ? listed(items)
    : `${items.slice(0, RESOURCES_NAMED).join(', ')} and ${items.length - RESOURCES_NAMED} more`;

/** How to reach full coverage: a resource that declares every type, else the resources that declare the missing ones. */
export const coverageScanAdvice = (scan: CoverageScan): string =>
  scan.wholeResources.length > 0
    ? `${listed(scan.wholeResources)} ${scan.wholeResources.length === 1 ? 'declares' : 'each declare'} every type the server has: test ${
        scan.wholeResources.length === 1 ? 'it' : 'one of them'
      }, or add the resources that declare the missing types (${NAME_RESOURCES})`
    : `No one resource declares every type the server has, so test across resources: add the ones that declare the missing types (${NAME_RESOURCES})`;

/** Why the run cannot meet full type coverage with the resources it tests, or undefined when it can. */
export const coverageScanReason = (scan: CoverageScan): string | undefined => {
  if (scan.unreachable.length === 0) return undefined;
  const types = scan.unreachable.map(u => u.type);
  const where = scan.unreachable.map(u => `${u.type} on ${someOf(u.declaredOn)}`).join('; ');
  return `${TYPES_REQUIRED}. The resources this run tests do not have ${listed(types)}, so full type coverage cannot be met. Declared on resources not tested: ${where}. ${coverageScanAdvice(scan)}`;
};
