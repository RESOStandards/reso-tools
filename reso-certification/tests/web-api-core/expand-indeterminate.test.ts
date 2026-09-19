import { describe, expect, it } from 'vitest';
import type { ExpandScenario, ODataRequester, ODataResponse, TestParams } from '../../src/web-api-core/test-runner.js';
import { runExpandNavScenarios, summarizeScenarios, validateExpandedItems } from '../../src/web-api-core/test-runner.js';
import { createExpandSchemaValidator } from '../../src/sdk/expand-schema.js';
import type { MetadataReport } from '../../src/sdk/types.js';

/**
 * reso-tools #297 — a per-item schema verdict is one of exactly three: valid, invalid, indeterminate. Indeterminate
 * (the validator could not evaluate the item — a compile failure isolated to a NON-warm-up resource, an unknown
 * target type) is never rendered as "all N items valid", and the navigation's verdict never depends on which
 * resource happened to warm the compile. Before this change the per-item catch returned `{ valid: true }` and the
 * unknown-target route returned an empty error map, so a grossly invalid item on a second resource PASSED.
 */
const f = (resourceName: string, fieldName: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ resourceName, fieldName, type, nullable: true, isCollection: false, isExpansion: false, annotations: [], ...extra });

const propertyFields = [f('Property', 'ListingKey', 'Edm.String', { nullable: false, isPrimaryKey: true }), f('Property', 'ListPrice', 'Edm.Decimal')];
// Member carries a navigation whose target type has NO definition anywhere (the 494d9be shape: a containment
// target / set≠type) — its resource-specific schema cannot compile.
const memberFields = [
  f('Member', 'MemberKey', 'Edm.String', { nullable: false }),
  f('Member', 'MemberStatus', 'Edm.String', { maxLength: 5 }),
  f('Member', 'Media', 'Collection(org.reso.metadata.ContainedMedia)', { typeName: 'ContainedMedia', isCollection: true, isExpansion: true }),
];
const reportWith = (fields: ReadonlyArray<Record<string, unknown>>): MetadataReport =>
  ({ description: '', version: '2.1', generatedOn: '', resources: [], models: [], actions: [], functions: [], lookups: [], fields } as unknown as MetadataReport);
/** Property first → Property is the warm-up resource; Member's compile failure is only reachable per item. */
const propertyFirst = reportWith([...propertyFields, ...memberFields]);
/** Member first → Member is the warm-up resource; its compile failure is caught at construction. */
const memberFirst = reportWith([...memberFields, ...propertyFields]);

// Grossly schema-invalid Member item: unadvertised field + maxLength overflow + wrong type.
const badMember = { MemberKey: 'm1', MemberStatus: 'waytoolongvalue', TotallyUndeclared: 1, ListPrice: 'not-a-number' };

const expandScenario: ExpandScenario = { tag: 'expand', name: '$expand navigation property', category: 'expand', fieldParam: 'expandField', minVersion: '2.1.0' };
const paramsFor = (navs: ReadonlyArray<{ name: string; targetType: string }>): TestParams => ({
  resource: 'Property', keyField: 'ListingKey', keyValue: 'P1', enumMode: 'string', integerValueHigh: 0, skippedTypes: [], sampleComplete: true, expandField: navs[0]?.name, expandNavs: navs,
});
const respond = (body: unknown): ODataResponse => ({ status: 200, headers: { 'odata-version': '4.01' }, body, rawBody: JSON.stringify(body) });
const requesterFor = (expanded: unknown[], navName: string): ODataRequester => ({
  request: async ({ url }) => {
    if (url.includes(`$expand=${navName}`)) return respond({ value: [{ ListingKey: 'P1', [navName]: expanded }] });
    if (new RegExp(`\\)/${navName}(\\?|$)`).test(url)) return respond({ value: expanded });
    throw new Error(`no scripted response for ${url}`);
  },
});

describe('#297 — per-item validator failure is INDETERMINATE, never "all N items valid"', () => {
  it('T1 the reproduction shape: a grossly invalid item on a non-warm-up resource whose schema cannot compile → SKIP with reason, not PASS', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: propertyFirst, version: '2.1.0', validationConfig: {} });
    expect(validator).toBeDefined(); // the warm-up (Property) compiled, so construction succeeds — the hole was per item
    const item = validator!.validate(badMember, 'Member');
    expect(item.valid).toBe(false);
    expect(item.indeterminate).toBe(true);
    expect(item.reason).toBeTruthy();

    const assertion = validateExpandedItems([{ MemberKey: 'x', Members: [badMember] }], { name: 'Members', targetType: 'Member' }, validator);
    expect(assertion.message).not.toMatch(/all 1 expanded .* valid/);
    expect(assertion.indeterminate).toBe(true);
    expect(assertion.message).toMatch(/not (evaluated|validated)/);

    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Members', targetType: 'Member' }]), 'tok', requesterFor([badMember], 'Members'), validator);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip, never a determinate pass or a false fail
    expect(summarizeScenarios(results).failed).toBe(0);
  });

  it('T2 an unknown target type → indeterminate with the reason, not { valid: true }', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: propertyFirst, version: '2.1.0', validationConfig: {} });
    const item = validator!.validate(badMember, 'NoSuchType');
    expect(item.valid).toBe(false);
    expect(item.indeterminate).toBe(true);
    expect(item.reason).toMatch(/NoSuchType/);
    const assertion = validateExpandedItems([{ K: 'x', Nav: [badMember] }], { name: 'Nav', targetType: 'NoSuchType' }, validator);
    expect(assertion.message).not.toMatch(/valid against/);
    expect(assertion.indeterminate).toBe(true);
  });

  it('T3 order independence: with Member as the warm-up resource the verdict class is the same (SKIP), never PASS in either order', async () => {
    const a = await createExpandSchemaValidator({ metadataReport: propertyFirst, version: '2.1.0', validationConfig: {} });
    const b = await createExpandSchemaValidator({ metadataReport: memberFirst, version: '2.1.0', validationConfig: {} });
    const nav = [{ name: 'Members', targetType: 'Member' }];
    const ra = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor(nav), 'tok', requesterFor([badMember], 'Members'), a);
    const rb = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor(nav), 'tok', requesterFor([badMember], 'Members'), b);
    expect([ra[0].passed, ra[0].skipped]).toEqual([rb[0].passed, rb[0].skipped]);
    expect(ra[0].skipped).toBe(true);
  });

  it('T4 control: the warm-up resource still validates — an unadvertised field on Property FAILS as before', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: propertyFirst, version: '2.1.0', validationConfig: {} });
    const item = validator!.validate({ ListingKey: 'p1', TotallyUndeclared: 1 }, 'Property');
    expect(item.valid).toBe(false);
    expect(item.indeterminate).toBeFalsy();
    expect(item.errors.join(' ')).toMatch(/TotallyUndeclared/);
    const ok = validator!.validate({ ListingKey: 'p1', ListPrice: 100 }, 'Property');
    expect(ok.valid).toBe(true);
  });

  it('T5 mixed page: an evaluable invalid item + an indeterminate item → FAIL that names the invalid item AND keeps the indeterminate count', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: propertyFirst, version: '2.1.0', validationConfig: {} });
    const mixed = { validate: (item: Record<string, unknown>, t: string) => (t === 'Mixed' ? ('bad' in item ? { valid: false, errors: ['field bad is not advertised'] } : { valid: false, indeterminate: true, errors: [], reason: 'compile failed' }) : validator!.validate(item, t)) };
    const assertion = validateExpandedItems([{ K: 'x', Nav: [{ bad: 1 }, { other: 1 }] }], { name: 'Nav', targetType: 'Mixed' }, mixed);
    expect(assertion.passed).toBe(false);
    expect(assertion.message).toMatch(/1\/2/);
    expect(assertion.message).toMatch(/not evaluated|indeterminate/);
  });

  it('T6 the validator-absent path is unchanged: no validator → the scenario is SKIP before leg 2 (#287)', async () => {
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Members', targetType: 'Member' }]), 'tok', requesterFor([badMember], 'Members'), undefined);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true);
  });

  // A third resource whose schema compiles: its verdict must not depend on whether an uncompilable resource was
  // evaluated before it. The legacy validate() mutates the shared schema's oneOf before ajv.compile and restored it
  // only on the success path, so one compile throw left a dangling $ref that every later not-yet-compiled resource
  // inherited: a grossly invalid Office item FAILED when validated before Member and SKIPPED after it.
  const officeFields = [f('Office', 'OfficeKey', 'Edm.String', { nullable: false }), f('Office', 'OfficeName', 'Edm.String', { maxLength: 5 })];
  const badOffice = { OfficeKey: 'o1', OfficeName: 'waytoolongvalue', TotallyUndeclared: 1 };
  const threeResources = reportWith([...propertyFields, ...memberFields, ...officeFields]);

  it('T7 no residue from a compile failure: a compilable resource validated AFTER the uncompilable one is still evaluated (FAIL), same as before it', async () => {
    const before = await createExpandSchemaValidator({ metadataReport: threeResources, version: '2.1.0', validationConfig: {} });
    const officeFirst = before!.validate(badOffice, 'Office');
    expect(officeFirst.indeterminate).toBeFalsy();
    expect(officeFirst.valid).toBe(false);

    const after = await createExpandSchemaValidator({ metadataReport: threeResources, version: '2.1.0', validationConfig: {} });
    const member = after!.validate(badMember, 'Member');
    expect(member.indeterminate).toBe(true);
    const officeAfter = after!.validate(badOffice, 'Office');
    expect(officeAfter.indeterminate).toBeFalsy(); // was: indeterminate — Member's compile throw poisoned the shared schema
    expect(officeAfter.valid).toBe(false);
    expect(officeAfter.errors.length).toBeGreaterThan(0);
  });

  it('T8 the uncompilable resource declared FIRST: a validator is still built, its own items are indeterminate, a grossly invalid Office item still FAILS', async () => {
    // before: the single warm-up on the first-declared resource threw, no validator was built, and every
    // navigation was skipped — including one whose expanded data was genuinely schema-invalid
    const memberFirstThree = reportWith([...memberFields, ...propertyFields, ...officeFields]);
    const validator = await createExpandSchemaValidator({ metadataReport: memberFirstThree, version: '2.1.0', validationConfig: {} });
    expect(validator).toBeDefined();
    const member = validator!.validate(badMember, 'Member');
    expect(member.indeterminate).toBe(true);
    expect(member.reason).toMatch(/could not be compiled/);
    const office = validator!.validate(badOffice, 'Office');
    expect(office.indeterminate).toBeFalsy();
    expect(office.valid).toBe(false);
    const assertion = validateExpandedItems([{ ListingKey: 'P1', Offices: [badOffice] }], { name: 'Offices', targetType: 'Office' }, validator);
    expect(assertion.passed).toBe(false);
  });
});
