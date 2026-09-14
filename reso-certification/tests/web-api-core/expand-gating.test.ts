import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { ExpandScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import {
  runExpandNavScenarios,
  validateExpandedItems,
  summarizeScenarios,
} from '../../src/web-api-core/test-runner.js';
import { createExpandSchemaValidator } from '../../src/sdk/expand-schema.js';
import { coreVerdict } from '../../src/sdk/core.js';

// FULL Core 2.1.0 $expand gating. THE RULE (RESO standards lead): $expand is tested per declared COLLECTION
// navigation property. No nav → N/A skip (never a failure). A declared collection nav GATES on the DATA:
// non-2xx → SKIP (expansion not available to this client, e.g. 403 — an access/permission boundary, OData 4.01
// §11.2.5; not a Core failure); 200 with an explicit `null` collection value → FAIL (a collection is a JSON
// array, never null); 200 with items → schema-validate each expanded child against its target entity type (a
// schema-invalid item → FAIL). The RRK expanded-item warning rides alongside, non-gating. A compliant server
// never false-fails, and enforcement runs only when the expansion actually returns data.

const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));
// A real DD 2.0 metadata report → a real legacy-backed validator. `Property` is a real resource in the report,
// so we schema-validate expanded items against it (the nav→target wiring is what's under test, not the nav's
// real-world semantics). AboveGradeFinishedAreaSource is a single enum with advertised values: 'Appraiser' is
// valid, 'InvalidEnum' is a real schema-invalid fixture.
const report = getReferenceMetadata('2.0');

const expandScenario: ExpandScenario = {
  tag: 'expand',
  name: '$expand navigation property',
  category: 'expand',
  fieldParam: 'expandField',
  minVersion: '2.1.0',
};

type Nav = { readonly name: string; readonly targetType: string };

const paramsFor = (navs: ReadonlyArray<Nav>): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: 'P1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  expandField: navs[0]?.name,
  expandNavs: navs,
});

// One parent Property (ListingKey P1) whose expanded collection under `navField` is exactly `children`.
const okExpand = (children: unknown, navField = 'Media'): ODataResponse => {
  const body = { value: [{ ListingKey: 'P1', [navField]: children }] };
  return { status: 200, headers: { 'odata-version': '4.01' }, body, rawBody: JSON.stringify(body) };
};

const status = (code: number): ODataResponse => ({
  status: code,
  headers: { 'odata-version': '4.01' },
  body: { error: { code: String(code) } },
  rawBody: '{}',
});

// A direct navigation-property-path collection response: /{resource}('{key}')/{nav} → { value: [items] }.
const navPathResponse = (items: unknown[]): ODataResponse => {
  const body = { value: items };
  return { status: 200, headers: { 'odata-version': '4.01' }, body, rawBody: JSON.stringify(body) };
};

// A requester that dispatches by which nav is being expanded (`$expand=<nav>`) AND the navigation-property-path
// second leg (`…('key')/<nav>`). The nav-path defaults to a 200 empty collection (schema-valid) unless overridden.
const requesterFor = (
  byNav: Readonly<Record<string, ODataResponse>>,
  navPathByNav: Readonly<Record<string, ODataResponse>> = {},
): ODataRequester => ({
  request: async ({ url }) => {
    const expandNav = Object.keys(byNav).find((n) => url.includes(`$expand=${n}`));
    if (expandNav) return byNav[expandNav];
    const navPathNav = Object.keys(byNav).find((n) => new RegExp(`\\)/${n}(\\?|$)`).test(url));
    if (navPathNav) return navPathByNav[navPathNav] ?? navPathResponse([]);
    throw new Error(`no scripted response for ${url}`);
  },
});

// Guards the "no request should be made" cases.
const throwingRequester: ODataRequester = {
  request: async () => {
    throw new Error('no request should have been issued');
  },
};

describe('runExpandNavScenarios — no collection nav → N/A skip (never a failure)', () => {
  it('a resource with no collection nav yields one SKIPPED result and issues no request', async () => {
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([]), 'tok', throwingRequester);
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip renders N/A, not a failure
    const summary = summarizeScenarios(results);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('runExpandNavScenarios — a declared collection nav is GATING', () => {
  it('200 + a schema-valid expanded item → PASS', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    // nav-path dual kept data-consistent with the $expand (records ↔ records) per §11.2.7.
    const req = requesterFor(
      { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) },
      { Media: navPathResponse([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) },
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results).toHaveLength(1);
    expect(results[0].tag).toBe('expand-Media');
    expect(results[0].passed).toBe(true);
    expect(results[0].skipped).toBe(false);
    expect(results[0].warnings).toBeUndefined();
    expect(summarizeScenarios(results).passed).toBe(1);
  });

  it('a declared nav that non-2xx (e.g. 403 not-authorised) → SKIP, never a FAIL (access/permission boundary)', async () => {
    // OData 4.01 §11.2.5: "Properties that are not available, for example due to permissions, are not returned."
    // A 403 "Client is not authorised to $expand Resource" is an entitlement boundary, not a Core violation.
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: status(403) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip is passed:true + skipped:true — never counted as a failure
    expect(results[0].assertions.every((a) => a.passed)).toBe(true);
    expect(results[0].assertions.some((a) => a.message.includes('403') && a.message.toLowerCase().includes('not supported') && a.message.toLowerCase().includes('skipped'))).toBe(true);
    const summary = summarizeScenarios(results);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('a declared nav that 500s → SKIP, report the status, move on (a crash returns no data to test)', async () => {
    // Josh: a 500 returns no data to test → skip (the "outright fail" is reserved for a testable 2xx response).
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: status(500) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip is passed:true + skipped:true — never a failure
    expect(results[0].assertions.some((a) => a.message.includes('500'))).toBe(true); // status reported
    expect(summarizeScenarios(results).failed).toBe(0);
  });

  it('200 with a NON-ARRAY collection value ({} / scalar / string) → FAIL (a collection must be a JSON array)', async () => {
    // "outright fails": a 2xx whose expanded value isn't a Collection — not just null, but any non-array. Must be
    // `[]` when empty, else a Collection of the target type.
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    for (const bad of [{} as unknown, 42 as unknown, 'x' as unknown]) {
      const req = requesterFor({ Media: okExpand(bad) });
      const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
      expect(results[0].passed).toBe(false);
      expect(results[0].skipped).toBe(false);
      expect(results[0].assertions.some((a) => !a.passed && a.message.toLowerCase().includes('not a json array'))).toBe(true);
      expect(summarizeScenarios(results).failed).toBe(1);
    }
  });

  it('a 200 with a MALFORMED OData envelope (missing OData-Version) → FAIL, not skip (served-but-broken)', async () => {
    // The skip is gated on STATUS, not on assertODataResponse: a genuine 200 that is malformed (no OData-Version
    // header) is a served-but-broken response, NOT a non-2xx decline → it must FAIL (keeping the diagnostic), and
    // must never be mislabeled "not available / skipped".
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const malformed200: ODataResponse = { status: 200, headers: {}, body: { value: [{ ListingKey: 'P1', Media: [{ AboveGradeFinishedAreaSource: 'Appraiser' }] }] }, rawBody: '{}' };
    const req = requesterFor({ Media: malformed200 });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].skipped).toBe(false);
    expect(results[0].passed).toBe(false);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('200 but an explicit null collection value → FAIL (a collection-valued property must be a JSON array, never null)', async () => {
    // OData: a collection-valued property is a JSON array — empty at most, NEVER null. An explicit null is
    // malformed data (distinct from an ABSENT nav, which is permitted "if available").
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: okExpand(null) }); // { value: [{ ListingKey: 'P1', Media: null }] }
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].skipped).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('null') && a.message.toLowerCase().includes('array'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('200 with an EMPTY collection ([]) → PASS, not a null-fail (empty ≠ null; no data to enforce)', async () => {
    // FALSE-POSITIVE guard: an empty array is a valid collection representation — it must NOT trip the null check.
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: okExpand([]) }); // { value: [{ ListingKey: 'P1', Media: [] }] }
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(true);
    expect(results[0].assertions.every((a) => a.passed)).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(0);
  });

  it('200 with the nav ABSENT from the record → PASS, not a null-fail (absent is permitted "if available", ≠ null)', async () => {
    // FALSE-POSITIVE guard: an absent nav (server omitted it) is permitted per OData §11.2.5 — NOT the null violation.
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const absent: ODataResponse = { status: 200, headers: { 'odata-version': '4.01' }, body: { value: [{ ListingKey: 'P1' }] }, rawBody: '{}' };
    const req = requesterFor({ Media: absent });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(0);
  });

  it('200 with an array of NON-ENTITY elements (Media:[null] / [42] / ["x"]) → FAIL (must be a Collection of entity objects)', async () => {
    // Closes the gap where an array of non-objects passed with zero validation (collectExpandedItems drops them).
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    for (const bad of [[null] as unknown, [42] as unknown, ['x'] as unknown, [['nested']] as unknown]) {
      const req = requesterFor({ Media: okExpand(bad) });
      const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
      expect(results[0].passed).toBe(false);
      expect(results[0].skipped).toBe(false);
      expect(results[0].assertions.some((a) => !a.passed && a.message.toLowerCase().includes('not an entity object'))).toBe(true);
      expect(summarizeScenarios(results).failed).toBe(1);
    }
  });

  it('a malformed collection FAILS even with NO validator built (shape is validator-independent; pins shape-before-validator ordering)', async () => {
    // The shape gate runs BEFORE the no-validator skip-return: garbage shape is observable without a schema. If the
    // shape check ever moved below `if (!validator)`, Media:{} / [null] with an unbuilt validator would silently
    // skip-pass — this test catches that regression.
    for (const bad of [{} as unknown, [null] as unknown]) {
      const req = requesterFor({ Media: okExpand(bad) });
      const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, undefined); // NO validator built
      expect(results[0].passed).toBe(false);
      expect(results[0].skipped).toBe(false);
      expect(summarizeScenarios(results).failed).toBe(1);
    }
  });

  it('200 with a null PARENT record ({value:[null]}) → handled without crashing (not a mislabeled transport-error skip)', async () => {
    // A null parent entry must not throw `'Media' in null`; it is filtered, yielding a determinate result rather
    // than the indeterminate errored-skip the crash used to produce.
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const nullParent: ODataResponse = { status: 200, headers: { 'odata-version': '4.01' }, body: { value: [null] }, rawBody: '{}' };
    const req = requesterFor({ Media: nullParent });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].errored ?? false).toBe(false); // NOT an errored/transport-blip skip
    expect(results[0].passed).toBe(true);            // a DETERMINATE result (null parent filtered), not an indeterminate skip
    expect(results[0].skipped).toBe(false);
    expect(summarizeScenarios(results).failed).toBe(0); // null parent filtered — a base-collection concern, not a Media fault
  });

  it('200 but a SCHEMA-INVALID expanded item → FAIL (validate the data, not just the 200)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: okExpand([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].skipped).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('schema-invalid'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('a transport error (no server response) → SKIPPED + errored, NOT a failure (indeterminate)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const blip: ODataRequester = { request: async () => { throw new Error('network blip'); } };
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', blip, validator);
    expect(results[0].skipped).toBe(true);
    expect(results[0].errored).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(0);
  });
});

describe('runExpandNavScenarios — no validator built → SKIP, not a pass on the 200 alone (A6)', () => {
  it('200 but the expand validator could not be built → SKIPPED (indeterminate), never a determinate pass', async () => {
    const req = requesterFor({ Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) });
    // validator = undefined: the provider's metadata did not compile into an expand schema → per-item validation
    // never ran. Must be a skip, not a determinate pass on the 200 alone (and not a false-fail).
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, undefined);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip is passed:true + skipped:true — never counted as a failure
    expect(results[0].assertions.some((a) => a.message.includes('schema validation unavailable'))).toBe(true);
    const summary = summarizeScenarios(results);
    expect(summary.passed).toBe(0); // NOT a determinate pass
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('runExpandNavScenarios — the RRK warning still rides alongside, non-gating', () => {
  it('a mismatched ResourceRecordKey on a schema-valid item → nav STILL passes, warning on .warnings', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    // A schema-valid Media item — `ResourceRecordKey` is a real Media field, and under additionalProperties:false
    // the item must carry ONLY advertised fields. RRK 'WRONG' ≠ parent Property ListingKey 'P1' → non-gating
    // warning. (Validate against the Media target the expanded child actually is — matching the RRK doc: an
    // expanded Media's ResourceRecordKey should echo the parent Property's ListingKey.)
    // nav-path dual kept data-consistent (records ↔ records, §11.2.7); the RRK mismatch is on the inline leg.
    const req = requesterFor(
      { Media: okExpand([{ ResourceRecordKey: 'WRONG' }]) },
      { Media: navPathResponse([{ ResourceRecordKey: 'WRONG' }]) },
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Media' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(true); // 200 + schema-valid → passes despite the RRK mismatch
    expect(results[0].warnings?.[0]).toContain('WRONG');
    expect(summarizeScenarios(results).failed).toBe(0); // the warning is inert to the verdict
  });
});

describe('runExpandNavScenarios — several navs, one bad fails exactly that nav', () => {
  it('Media (valid) passes and Rooms (schema-invalid) fails; the failure counts in the verdict tally', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    // nav-path duals kept data-consistent with each $expand (§11.2.7): Media valid, Rooms carries the invalid item
    // (so Rooms still fails on schema-invalidity, not on a nav-path consistency artifact).
    const req = requesterFor(
      {
        Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }], 'Media'),
        Rooms: okExpand([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }], 'Rooms'),
      },
      {
        Media: navPathResponse([{ AboveGradeFinishedAreaSource: 'Appraiser' }]),
        Rooms: navPathResponse([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]),
      },
    );
    const results = await runExpandNavScenarios(
      'http://x',
      'Property',
      expandScenario,
      paramsFor([{ name: 'Media', targetType: 'Property' }, { name: 'Rooms', targetType: 'Property' }]),
      'tok',
      req,
      validator,
    );
    expect(results).toHaveLength(2);
    const media = results.find((r) => r.tag === 'expand-Media')!;
    const rooms = results.find((r) => r.tag === 'expand-Rooms')!;
    expect(media.passed).toBe(true);
    expect(rooms.passed).toBe(false);

    const summary = summarizeScenarios(results);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1); // GATING: an expand failure is a real failure now
    // And the run verdict derived from those counts is `failed` (the failure is not softened to incomplete).
    expect(coreVerdict({ totalFailed: summary.failed, coverageFailed: false, deadlineReached: false })).toBe('failed');
  });
});

describe('runExpandNavScenarios — the navigation-property-path second leg (A1)', () => {
  // web-api-core.md §2.5.10.2: after the inline $expand, a keyed GET /{resource}('{key}')/{nav} must ALSO serve
  // the collection — reaching an expansion-only target THROUGH the parent key (never a top-level GET /{target}).
  const oneNav = paramsFor([{ name: 'Media', targetType: 'Property' }]);

  it('200 + a schema-valid nav-path collection → PASS (both legs), with a nav-path assertion', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor(
      { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) },
      { Media: navPathResponse([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) },
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
    expect(results[0].assertions.some((a) => a.passed && a.message.includes('Navigation-property-path') && a.message.includes('→ 200'))).toBe(true);
    expect(summarizeScenarios(results).passed).toBe(1);
  });

  it('the nav-path GET non-2xx → NOT faulted (same access/permission boundary as the inline leg — OData §11.2.5)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor(
      { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) }, // inline leg is fine (data enforced)
      { Media: status(403) },                                              // but the nav-path leg 403s (not authorised)
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
    expect(results[0].passed).toBe(true); // inline leg validated real data; a 403 nav-path leg is not a conformance failure
    expect(results[0].assertions.some((a) => a.passed && a.message.includes('Navigation-property-path') && a.message.includes('403') && a.message.toLowerCase().includes('not supported'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(0);
  });

  it('the nav-path GET 200 but a schema-invalid item → FAIL (the nav-path collection is validated too)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor(
      { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) },        // inline valid
      { Media: navPathResponse([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]) }, // nav-path invalid
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('Navigation-property-path') && a.message.includes('schema-invalid'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('the nav-path GET returns a null / non-array collection ({value:null}) → FAIL (same shape rule as the inline leg)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const nullNavPath: ODataResponse = { status: 200, headers: { 'odata-version': '4.01' }, body: { value: null }, rawBody: '{}' };
    const req = requesterFor(
      { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) }, // inline leg valid (real data)
      { Media: nullNavPath },                                              // but the nav-path collection is null
    );
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('Navigation-property-path') && a.message.toLowerCase().includes('not a json array'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('the nav-path GET returns an array of NON-ENTITY elements ({value:[null]} / [42]) → FAIL (element shape checked on both legs)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    for (const badColl of [[null] as unknown, [42] as unknown]) {
      const navBad: ODataResponse = { status: 200, headers: { 'odata-version': '4.01' }, body: { value: badColl }, rawBody: '{}' };
      const req = requesterFor(
        { Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) }, // inline leg valid
        { Media: navBad },                                                   // nav-path collection has non-entity elements
      );
      const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
      expect(results[0].passed).toBe(false);
      expect(results[0].assertions.some((a) => !a.passed && a.message.includes('Navigation-property-path') && a.message.toLowerCase().includes('not an entity object'))).toBe(true);
    }
  });

  it('an empty $expand response yields no parent key → the nav-path leg is not exercised (no data, not a failure)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    // $expand returns zero parent records → no key to drive the keyed nav-path GET. The nav-path requester below
    // would throw if reached (it isn't): the leg is skipped with a non-failing note, and the scenario still passes.
    const req = requesterFor({ Media: navPathResponse([]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNav, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
    expect(results[0].assertions.some((a) => a.passed && a.message.includes('no parent key') && a.message.includes('not exercised'))).toBe(true);
  });
});

// The $expand form and the navigation-property-path form resolve the SAME relationship on the SAME source
// entity, so they MUST agree on has-records (OData §11.2.7: a collection nav-path returns the related entities,
// empty ONLY if none are related). The invariant: hasRecords($expand=X for key) === hasRecords(Parent('key')/X).
describe('runExpandNavScenarios — the $expand ↔ nav-property-path dual must be data-consistent (§11.2.7)', () => {
  const oneNavParams = paramsFor([{ name: 'Media', targetType: 'Property' }]);
  const validItem = { AboveGradeFinishedAreaSource: 'Appraiser' };
  const buildValidator = () => createExpandSchemaValidator({ metadataReport: report, version: '2.0' });

  // (1) records ↔ records → PASS
  it('records in $expand AND records on the nav-path → PASS (consistent)', async () => {
    const validator = await buildValidator();
    const req = requesterFor({ Media: okExpand([validItem]) }, { Media: navPathResponse([validItem]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
  });

  // (2) no records ↔ no records → PASS
  it('no records in $expand AND none on the nav-path → PASS (consistent empty↔empty)', async () => {
    const validator = await buildValidator();
    const req = requesterFor({ Media: okExpand([]) }, { Media: navPathResponse([]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
  });

  // (3) no records in $expand BUT records on the nav-path → FAIL
  it('no records in $expand BUT records on the nav-path → FAIL (§11.2.7 dual inconsistency)', async () => {
    const validator = await buildValidator();
    const req = requesterFor({ Media: okExpand([]) }, { Media: navPathResponse([validItem]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('Navigation-property-path') && a.message.includes('11.2.7'))).toBe(true);
  });

  // (4) records in $expand BUT none on the nav-path → FAIL (the case from the live fbs sweep)
  it('records in $expand BUT none on the nav-path → FAIL (§11.2.7 dual inconsistency)', async () => {
    const validator = await buildValidator();
    const req = requesterFor({ Media: okExpand([validItem]) }, { Media: navPathResponse([]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('Navigation-property-path') && a.message.includes('11.2.7'))).toBe(true);
  });

  // wrong code: a collection nav-path returning 204 is non-conformant (must be 200 empty-set, never 204) —
  // §11.2.7 / §2.6.1 — and fails even when $expand was ALSO empty (kept per option (b)).
  it('204 No Content on a collection nav-path → FAIL (wrong code; empty collection must be 200 empty-set)', async () => {
    const validator = await buildValidator();
    const noContent: ODataResponse = { status: 204, headers: { 'odata-version': '4.01' }, body: null, rawBody: '' };
    const req = requesterFor({ Media: okExpand([]) }, { Media: noContent });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(false);
  });

  // Paging tolerance: an empty first PAGE + @odata.nextLink still means related entities exist, so has-records
  // reads true and the dual does NOT false-fail a conformant server (OData JSON Format §4.5.5).
  it('records in $expand + nav-path empty first page WITH @odata.nextLink → PASS (paged, not a false-fail)', async () => {
    const validator = await buildValidator();
    const navPaged: ODataResponse = {
      status: 200,
      headers: { 'odata-version': '4.01' },
      body: { value: [], '@odata.nextLink': "http://x/Property('P1')/Media?$skiptoken=1" },
      rawBody: '{}',
    };
    const req = requesterFor({ Media: okExpand([validItem]) }, { Media: navPaged });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
  });

  it('$expand empty inline page WITH {nav}@odata.nextLink + nav-path records → PASS (has-records both sides)', async () => {
    const validator = await buildValidator();
    const expandPaged: ODataResponse = {
      status: 200,
      headers: { 'odata-version': '4.01' },
      body: { value: [{ ListingKey: 'P1', Media: [], 'Media@odata.nextLink': "http://x/Property('P1')/Media?$skiptoken=1" }] },
      rawBody: '{}',
    };
    const req = requesterFor({ Media: expandPaged }, { Media: navPathResponse([validItem]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, oneNavParams, 'tok', req, validator);
    expect(results[0].passed).toBe(true);
  });
});

describe('validateExpandedItems — the data-validation unit', () => {
  const nav: Nav = { name: 'Media', targetType: 'Property' };
  const parents = (children: unknown): ReadonlyArray<Record<string, unknown>> => [{ ListingKey: 'P1', Media: children }];

  it('no validator (couldn’t be built this run) → the ASSERTION never false-fails; the SCENARIO skips it (A6)', () => {
    // The low-level assertion is non-failing when no validator was built (never a false-fail). runOneExpandNav
    // lifts this to a scenario-level SKIP (indeterminate) rather than a determinate pass — see the
    // "no validator built → SKIP" scenario test above.
    const a = validateExpandedItems(parents([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]), nav, undefined);
    expect(a.passed).toBe(true);
  });

  it('no expanded items → PASS (nothing to schema-validate)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(validateExpandedItems(parents([]), nav, validator).passed).toBe(true);
    expect(validateExpandedItems([{ ListingKey: 'P1' }], nav, validator).passed).toBe(true); // nav absent
  });

  it('a schema-invalid item → FAIL naming the offending item', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const a = validateExpandedItems(parents([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]), nav, validator);
    expect(a.passed).toBe(false);
    expect(a.message).toContain('schema-invalid');
  });
});

describe('createExpandSchemaValidator — the legacy-backed item validator', () => {
  it('a valid item → valid; a schema-invalid item → invalid with error messages', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(v).toBeDefined();
    expect(v!.validate({ AboveGradeFinishedAreaSource: 'Appraiser' }, 'Property').valid).toBe(true);
    const bad = v!.validate({ AboveGradeFinishedAreaSource: 'InvalidEnum' }, 'Property');
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('an unadvertised field on a KNOWN target → invalid (additionalProperties:false, DD/Core mode)', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const bad = v!.validate({ AboveGradeFinishedAreaSource: 'Appraiser', DefinitelyNotAPropertyField: 'x' }, 'Property');
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('an unknown target type → treated VALID (indeterminate, never a false fail)', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(v!.validate({ Anything: 'x' }, 'NoSuchResourceType').valid).toBe(true);
  });
});

// The REAL production path: a provider-style EDMX → generateMetadataReport → createExpandSchemaValidator, then
// validate genuine expanded items. Proves the DD/Core policy end-to-end (isRCF:false, additionalProperties:false,
// the ignoreEnumerations exemptions, the totalErrors gate) against the metadata shape the runner actually builds
// from (`src/sdk/core.ts` calls generateMetadataReport before this validator), not the DD reference alone.
const PROVIDER_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="org.reso.metadata">
      <EntityType Name="Media">
        <Key><PropertyRef Name="MediaKey"/></Key>
        <Property Name="MediaKey" Type="Edm.String" MaxLength="255" Nullable="false"/>
        <Property Name="ShortText" Type="Edm.String" MaxLength="5"/>
        <Property Name="Order" Type="Edm.Int64"/>
        <Property Name="MediaCategory" Type="org.reso.metadata.enums.MediaCategory"/>
        <Property Name="ImageSizeDescription" Type="org.reso.metadata.enums.ImageSizeDescription"/>
        <Property Name="Features" Type="Collection(org.reso.metadata.enums.Feature)" Nullable="false"/>
      </EntityType>
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="org.reso.metadata.enums">
      <EnumType Name="MediaCategory"><Member Name="Photo"/><Member Name="Video"/></EnumType>
      <EnumType Name="ImageSizeDescription"><Member Name="Thumbnail"/></EnumType>
      <EnumType Name="Feature"><Member Name="Pool"/><Member Name="Garage"/></EnumType>
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="ODataService">
      <EntityContainer Name="Container"><EntitySet Name="Media" EntityType="org.reso.metadata.Media"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

// The endorsement carries the full semver (2.1.0); the exemptions file is keyed by DD major.minor (2.1).
const PROVIDER_VERSION = '2.1.0';
// Mirror the shape of schema-validation-settings.json for the one exempt Media field the fixture exercises.
const EXEMPTIONS = { '2.1': { Media: { ImageSizeDescription: { ignoreEnumerations: true } } } };

const buildProviderValidator = (validationConfig?: Readonly<Record<string, unknown>>) =>
  createExpandSchemaValidator({
    metadataReport: generateMetadataReport(PROVIDER_EDMX, PROVIDER_VERSION),
    version: PROVIDER_VERSION,
    validationConfig,
  });

describe('createExpandSchemaValidator — provider path (EDMX → generateMetadataReport → validator)', () => {
  it('a valid item (incl. a populated enum collection) → passes with 0 errors', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', MediaCategory: 'Photo', Order: 3, ShortText: 'abc', Features: ['Pool', 'Garage'] }, 'Media');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('a bad enum value on a non-exempt field → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', MediaCategory: 'NotAdvertised' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a number served as a JSON string for an Int64 → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', Order: '3' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('MUST be integer'))).toBe(true);
  });

  it('a string exceeding the provider’s declared maxLength → FAIL (isRCF:false: advertised, not suggested)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', ShortText: 'waytoolong' }, 'Media');
    expect(r.valid).toBe(false);
    // DD/Core mode wording — a hard "MUST … advertised length", NOT the RCF "SHOULD … suggested length" warning.
    expect(r.errors.some((e) => e.includes('advertised length'))).toBe(true);
    expect(r.errors.some((e) => e.includes('suggested length'))).toBe(false);
  });

  it('null for a (non-nullable) collection field → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', Features: null }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('MUST be array'))).toBe(true);
  });

  it('a field absent from the provider metadata → FAIL (additionalProperties:false)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', UndeclaredField: 'x' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a novel value on an ignoreEnumerations field → does NOT fail (downgraded to a warning)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', ImageSizeDescription: 'HugeSize' }, 'Media');
    expect(r.valid).toBe(true); // the exemption converts the unadvertised-enum error into a warning
    expect(r.errors).toHaveLength(0);
  });

  it('WITHOUT the exemption the SAME novel value fails — proving the exemption is what downgrades it', async () => {
    const v = await buildProviderValidator({}); // no exemptions threaded
    const r = v!.validate({ MediaKey: 'm1', ImageSizeDescription: 'HugeSize' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a schema that cannot be built → validator is undefined; the nav then gates on the 200 alone', async () => {
    // A report the legacy generator cannot project (returns null) → construction fails determinately.
    const brokenReport = {
      description: '', version: '2.1', generatedOn: '', resources: [], models: [],
      fields: [], lookups: undefined, actions: [], functions: [],
    } as unknown as MetadataReport;
    // The legacy generator logs the caught projection error; silence that ONE expected line to keep output clean.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const v = await createExpandSchemaValidator({ metadataReport: brokenReport, version: PROVIDER_VERSION });
    spy.mockRestore();
    expect(v).toBeUndefined();
    // An undefined validator makes the nav gate on the 200 alone — a determinate tooling failure, never a
    // silent per-item pass (validateExpandedItems short-circuits to passed:true without inspecting items).
    const parent = [{ ListingKey: 'P1', Media: [{ MediaCategory: 'anything' }] }];
    expect(validateExpandedItems(parent, { name: 'Media', targetType: 'Media' }, v).passed).toBe(true);
  });
});
