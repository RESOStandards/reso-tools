import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateJsonSchema, validate, combineErrors, checkResoContext, RESO_CONTEXT_MESSAGES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js')
);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

/**
 * reso-tools #298 — `@reso.context` is validated when present (RCF "Context" section / IANA `reso` URN registration §3.4.1(a):
 * `urn:reso:metadata:{version}:resource:{resource-name}`, lowercase resource name; RCF allows additional
 * trailing parameters), and the length severity follows the ACQUISITION PATH, never the annotation's presence.
 *
 * Severity table (Josh, 2026-09-17):  RCF payload → absent / malformed / version or resource disagreement = error;
 * transport-acquired (Web API Core, DD replicated over the provider's Web API) → absent allowed and the other
 * three are warnings until DD 3.0, when the context becomes required and they fail; `maxLength` overflow is a
 * MUST on the transport path with or without a context, advisory on an RCF payload.
 *
 * Amendment (Josh, 2026-09-21): RCF is taken as-is. On the DECLARED rcf path local fields and values outside the
 * standard set are accepted; a DD field is held to its type; length, precision and scale beyond the DD's are
 * warnings (a scale-0 decimal over its precision cap or with a fractional value); the Int16/32/64 range caps and a
 * non-numeric value stay the type MUST. Transport and the presence heuristic are unchanged.
 */
const CTX = 'urn:reso:metadata:2.0:resource:property';

describe('checkResoContext — shape, version and resource rules by acquisition mode', () => {
  const rcf = (context: unknown, over: Record<string, unknown> = {}) => checkResoContext({ context, resource: 'Property', version: '2.0', mode: 'rcf', ...over });
  const transport = (context: unknown, over: Record<string, unknown> = {}) => checkResoContext({ context, resource: 'Property', version: '2.0', mode: 'transport', ...over });
  const severities = (r: { findings: ReadonlyArray<{ severity: string }> }) => r.findings.map(f => f.severity);

  it('well-formed, matching → no findings on either path', () => {
    expect(rcf(CTX).findings).toEqual([]);
    expect(transport(CTX).findings).toEqual([]);
  });

  it('absent: RCF → error (required); transport → nothing until DD 3.0, error from 3.0', () => {
    expect(rcf(undefined).findings).toEqual([{ severity: 'error', message: RESO_CONTEXT_MESSAGES.REQUIRED }]);
    expect(transport(undefined).findings).toEqual([]);
    expect(severities(transport(undefined, { version: '3.0' }))).toEqual(['error']);
  });

  it.each([
    ['missing the resource element', 'urn:reso:metadata:2.0'],
    ['wrong prefix', 'urn:acme:metadata:2.0:resource:property'],
    ['uppercase resource name (the URN assignment is lowercase)', 'urn:reso:metadata:2.0:resource:Property'],
    ['a field element is not a payload context', 'urn:reso:metadata:2.0:resource:property:field:listprice'],
    ['not a string', 42],
  ])('malformed — %s: RCF → error, transport → warning (error from DD 3.0)', (_label, context) => {
    expect(severities(rcf(context))).toEqual(['error']);
    expect(rcf(context).findings[0].message).toMatch(/urn:reso:metadata:\{version\}:resource:\{resource-name\}/);
    expect(severities(transport(context))).toEqual(['warning']);
    expect(severities(transport(context, { version: '3.0' }))).toEqual(['error']);
  });

  it('trailing parameters after the resource element are accepted (RCF: "additional parameters may be added")', () => {
    expect(rcf('urn:reso:metadata:2.0:resource:property:action:create').findings).toEqual([]);
  });

  it('version segment disagrees with the run version: RCF → error, transport → warning; the run version is authoritative', () => {
    const r = rcf('urn:reso:metadata:1.7:resource:property');
    expect(severities(r)).toEqual(['error']);
    expect(r.findings[0].message).toMatch(/1\.7/); expect(r.findings[0].message).toMatch(/2\.0/);
    expect(severities(transport('urn:reso:metadata:1.7:resource:property'))).toEqual(['warning']);
  });

  it('resource segment disagrees with the requested resource: RCF → error, transport → warning', () => {
    const r = rcf('urn:reso:metadata:2.0:resource:member');
    expect(severities(r)).toEqual(['error']);
    expect(r.findings[0].message).toMatch(/member/); expect(r.findings[0].message).toMatch(/Property/);
    expect(severities(transport('urn:reso:metadata:2.0:resource:member'))).toEqual(['warning']);
  });

  it('no run version given → the version segment is only checked for being a known DD version', () => {
    expect(rcf('urn:reso:metadata:1.7:resource:property', { version: undefined }).findings).toEqual([]);
    expect(severities(rcf('urn:reso:metadata:9.9:resource:property', { version: undefined }))).toEqual(['error']);
  });
});

describe('validate() — severity follows the acquisition path, not the annotation', () => {
  const metadata = structuredClone(getReferenceMetadata('2.0'));
  metadata.fields.push({ resourceName: 'Property', fieldName: 'TestMaxLengthField', nullable: false, annotations: [], type: 'Edm.String', maxLength: 5 });
  const overflow = { TestMaxLengthField: 'waytoolongvalue' };
  const run = async (jsonPayload: Record<string, unknown>, acquisition?: string) => {
    const jsonSchema = await generateJsonSchema({ metadataReportJson: metadata });
    return combineErrors(validate({ jsonSchema, jsonPayload, resourceName: 'Property', version: '2.0', errorMap: {}, ...(acquisition ? { acquisition } : {}) }));
  };
  const MUST = 'MUST have a maximum advertised length of 5 characters';
  const SHOULD = 'SHOULD have a maximum suggested length of 5 characters';

  it('transport + a well-formed context: maxLength overflow is still a MUST error (before #298 it became an advisory warning)', async () => {
    const report = await run({ '@reso.context': CTX, ...overflow }, 'transport');
    expect(report.totalErrors).toBe(1);
    expect(report.errors?.[MUST]).toBeTruthy();
    expect(report.totalWarnings).toBe(0);
  });

  it('transport without a context: unchanged — MUST error, nothing about the context (allowed until DD 3.0)', async () => {
    const report = await run({ '@odata.context': '$metadata#Property', ...overflow }, 'transport');
    expect(report.totalErrors).toBe(1);
    expect(report.totalWarnings).toBe(0);
  });

  it('transport + a malformed context: the context finding is a WARNING and the length rule stays a MUST', async () => {
    const report = await run({ '@reso.context': 'urn:reso:metadata:2.0:resource:Property', ...overflow }, 'transport');
    expect(report.totalErrors).toBe(1);
    expect(report.totalWarnings).toBe(1);
    expect(Object.keys(report.warnings ?? {}).join(' ')).toMatch(/@reso\.context/);
  });

  it('RCF + a well-formed context: length overflow is advisory (SHOULD warning), no context finding', async () => {
    const report = await run({ '@reso.context': CTX, ...overflow }, 'rcf');
    expect(report.totalErrors).toBe(0);
    expect(report.totalWarnings).toBe(1);
    expect(report.warnings?.[SHOULD]).toBeTruthy();
  });

  it('RCF without a context: ERROR — RCF payloads MUST carry @reso.context', async () => {
    const report = await run({ ...overflow }, 'rcf');
    expect(report.totalErrors).toBe(1);
    expect(Object.keys(report.errors ?? {}).join(' ')).toMatch(/@reso\.context/);
  });

  it('RCF context errors keep their wording: the first word is not shouted (no "THE" / "RCF" upper-casing artefact)', async () => {
    const absent = await run({ ...overflow }, 'rcf');
    const malformed = await run({ '@reso.context': 'urn:reso:metadata:2.0:resource:Property' }, 'rcf');
    const messages = [...Object.keys(absent.errors ?? {}), ...Object.keys(malformed.errors ?? {})];
    expect(messages.some(m => m.startsWith('RCF payloads MUST'))).toBe(true);
    expect(messages.some(m => m.startsWith('The "@reso.context"'))).toBe(true);
    expect(messages.some(m => /^(THE|RCF PAYLOADS)\b/.test(m))).toBe(false);
  });

  it('RCF + a context whose version disagrees with the run: ERROR naming both', async () => {
    const report = await run({ '@reso.context': 'urn:reso:metadata:1.7:resource:property' }, 'rcf');
    expect(report.totalErrors).toBe(1);
    expect(Object.keys(report.errors ?? {}).join(' ')).toMatch(/1\.7.*2\.0|2\.0.*1\.7/);
  });

  it('no acquisition given (legacy callers): the presence heuristic is preserved', async () => {
    const withCtx = await run({ '@reso.context': CTX, ...overflow });
    expect(withCtx.totalWarnings).toBe(1); expect(withCtx.totalErrors).toBe(0);
    const without = await run({ ...overflow });
    expect(without.totalErrors).toBe(1);
  });

  // --- review of 2026-09-19: the context must never steer the transport path, and no finding may be lost -------

  it('transport + a context naming ANOTHER resource: the page is validated against the REQUESTED resource (MUST kept) and the disagreement is a warning', async () => {
    // before: the context selected the schema resource, so a Property page was validated as Member (or not at all)
    const report = await run({ '@reso.context': 'urn:reso:metadata:2.0:resource:member', ...overflow }, 'transport');
    expect(report.totalErrors).toBe(1);
    expect(report.errors?.[MUST]).toBeTruthy();
    expect(report.totalWarnings).toBe(1);
    expect(Object.keys(report.warnings ?? {}).join(' ')).toMatch(/does not match the requested resource/);
  });

  it('transport + a context the legacy resolver cannot parse at all (wrong prefix, five segments): still validated, MUST kept, MALFORMED warning kept', async () => {
    // before: the unresolvable context made the resource "invalid", the page went unvalidated and the early
    // return handed back the caller's empty accumulator, so the warning written to the local cache was lost
    const report = await run({ '@reso.context': 'urn:foo:2.0:resource:property', ...overflow }, 'transport');
    expect(report.totalErrors).toBe(1);
    expect(report.errors?.[MUST]).toBeTruthy();
    expect(report.totalWarnings).toBe(1);
    expect(Object.keys(report.warnings ?? {}).join(' ')).toMatch(/@reso\.context/);
  });

  it('RCF + a well-formed context naming a resource the schema does not define: the result carries stats and caches (no TypeError downstream), the payload error, and a COUNTED error (the payload was not validated)', async () => {
    const jsonSchema = await generateJsonSchema({ metadataReportJson: metadata });
    const result = validate({ jsonSchema, jsonPayload: { '@reso.context': 'urn:reso:metadata:2.0:resource:notaresource', value: [{ A: 1 }] }, resourceName: 'Notaresource', version: '2.0', errorMap: {}, acquisition: 'rcf' });
    expect(result.stats).toBeDefined(); // before: `return errorMap` → {} → replication's destructure of stats threw
    expect(result.errorCache).toBeDefined();
    expect(result.warningsCache).toBeDefined();
    const payloadErrors = result.payloadErrors as Record<string, Record<string, unknown>>;
    expect(Object.values(payloadErrors).some(byMessage => 'Invalid resource' in byMessage)).toBe(true);
    const report = combineErrors(result);
    expect(report.totalErrors).toBe(1); // a payload nobody validated is never a pass
    expect(Object.keys(report.errors ?? {}).join(' ')).toMatch(/notaresource.*not defined/i);
  });

  it('transport with the run version in its 2.1.0 form and a 2.1 context: no version-mismatch finding (major.minor compared)', async () => {
    const meta21 = structuredClone(getReferenceMetadata('2.1'));
    const jsonSchema = await generateJsonSchema({ metadataReportJson: meta21 });
    const report = combineErrors(validate({ jsonSchema, jsonPayload: { '@reso.context': 'urn:reso:metadata:2.1:resource:property', ListingKey: 'x' }, resourceName: 'Property', version: '2.1.0', errorMap: {}, acquisition: 'transport' }));
    expect(report.totalWarnings).toBe(0);
    expect(report.totalErrors).toBe(0);
  });

  it('an item embedded in a page (an $expand child) is never REQUIRED to carry its own context, even from DD 3.0', () => {
    const r = checkResoContext({ context: undefined, resource: 'Member', version: '3.0', mode: 'transport', embedded: true });
    expect(r.findings).toEqual([]);
    const page = checkResoContext({ context: undefined, resource: 'Member', version: '3.0', mode: 'transport' });
    expect(page.findings.map((f: { severity: string }) => f.severity)).toEqual(['error']);
    expect(page.findings[0].message).toMatch(/^The "@reso\.context" annotation MUST be present/); // a transport page, not an RCF payload
    expect(checkResoContext({ context: undefined, resource: 'Member', version: '2.0', mode: 'rcf' }).findings[0].message).toMatch(/^RCF payloads MUST carry/);
  });

  it('embedded, through validate(): at DD 3.0 an $expand child without a context has no context finding; a child carrying a WRONG context is still checked', async () => {
    const meta21 = structuredClone(getReferenceMetadata('2.1'));
    const jsonSchema = await generateJsonSchema({ metadataReportJson: meta21 });
    const item = (payload: Record<string, unknown>, embedded: boolean) =>
      combineErrors(validate({ jsonSchema, jsonPayload: payload, resourceName: 'Member', version: '3.0', errorMap: {}, acquisition: 'transport', embedded }));
    const bare = item({ MemberKey: 'm' }, true);
    expect(bare.totalErrors).toBe(0); expect(bare.totalWarnings).toBe(0);
    const page = item({ MemberKey: 'm' }, false);
    expect(page.totalErrors).toBe(1); // the page itself is required to carry it from 3.0
    const wrong = item({ '@reso.context': 'urn:reso:metadata:3.0:resource:office', MemberKey: 'm' }, true);
    expect(wrong.totalErrors).toBe(1); // present and disagreeing: checked even on an embedded item (error at 3.0)
    expect(Object.keys(wrong.errors ?? {}).join(' ')).toMatch(/does not match the requested resource/);
  });

  it('major.minor comparison locks the false-pass side too: a 2.1.0 run against a 2.0 context is a mismatch', async () => {
    const meta21 = structuredClone(getReferenceMetadata('2.1'));
    const jsonSchema = await generateJsonSchema({ metadataReportJson: meta21 });
    const report = combineErrors(validate({ jsonSchema, jsonPayload: { '@reso.context': 'urn:reso:metadata:2.0:resource:property', ListingKey: 'x' }, resourceName: 'Property', version: '2.1.0', errorMap: {}, acquisition: 'transport' }));
    expect(report.totalWarnings).toBe(1);
    expect(Object.keys(report.warnings ?? {}).join(' ')).toMatch(/version does not match/);
  });

  it('RCF as-is applies to the DECLARED rcf path only: a value outside the standard set is accepted there, and stays an error on the presence heuristic and on transport', async () => {
    // AboveGradeFinishedAreaSource is an enumeration in the DD 2.0 reference; "NotAStandardValue" is outside it
    const jsonSchema = await generateJsonSchema({ metadataReportJson: metadata });
    const payload = { '@reso.context': CTX, AboveGradeFinishedAreaSource: 'NotAStandardValue' };
    const declaredRcf = combineErrors(validate({ jsonSchema, jsonPayload: payload, resourceName: 'Property', version: '2.0', errorMap: {}, acquisition: 'rcf' }));
    expect(declaredRcf.totalErrors).toBe(0); // extension accepted
    expect(declaredRcf.totalWarnings).toBe(0); // accepted, not warned about
    const heuristic = combineErrors(validate({ jsonSchema, jsonPayload: payload, resourceName: 'Property', version: '2.0', errorMap: {} }));
    expect(heuristic.totalErrors).toBe(1); // a legacy caller validating provider metadata keeps the DD rule
    const transport = combineErrors(validate({ jsonSchema, jsonPayload: payload, resourceName: 'Property', version: '2.0', errorMap: {}, acquisition: 'transport' }));
    expect(transport.totalErrors).toBe(1);
    expect(Object.keys(transport.errors ?? {}).join(' ')).toMatch(/MUST be advertised/);
  });

  it('a scale-0 DD decimal: over its precision or with a fractional value is a warning on declared rcf (precision, scale), a MUST on transport', async () => {
    const jsonSchema = await generateJsonSchema({ metadataReportJson: metadata });
    const run = (jsonPayload: Record<string, unknown>, acquisition: string) =>
      combineErrors(validate({ jsonSchema, jsonPayload, resourceName: 'Property', version: '2.0', errorMap: {}, acquisition }));
    // Property.BathroomsFull is Edm.Decimal precision 3, scale 0
    const overPrecision = run({ '@reso.context': CTX, BathroomsFull: 12345 }, 'rcf');
    expect(overPrecision.totalErrors).toBe(0); expect(overPrecision.totalWarnings).toBe(1);
    expect(Object.keys(overPrecision.warnings ?? {}).join(' ')).toMatch(/precision/);
    const fractional = run({ '@reso.context': CTX, BathroomsFull: 2.5 }, 'rcf');
    expect(fractional.totalErrors).toBe(0); expect(fractional.totalWarnings).toBe(1);
    expect(Object.keys(fractional.warnings ?? {}).join(' ')).toMatch(/scale 0/);
    const wrongType = run({ '@reso.context': CTX, BathroomsFull: 'two' }, 'rcf');
    expect(wrongType.totalErrors).toBe(1); // a non-numeric value is the type MUST
    const transport = run({ '@reso.context': CTX, BathroomsFull: 12345 }, 'transport');
    expect(transport.totalErrors).toBe(1); expect(transport.totalWarnings).toBe(0);
    const transportFraction = run({ '@reso.context': CTX, BathroomsFull: 2.5 }, 'transport');
    expect(transportFraction.totalErrors).toBe(1);
  });

  it('the numeric downgrades reach a scale-0 decimal two expansions deep and inside a collection expansion on rcf, stay a MUST on transport, and never touch an Int16 / Int64 range cap or the presence heuristic', async () => {
    // a synthetic Edm.Int16 beside the DD 2.0 reference: its range cap is the type's own bound, a MUST everywhere
    const meta = structuredClone(metadata);
    meta.fields.push({ resourceName: 'Property', fieldName: 'TestInt16', nullable: true, annotations: [], type: 'Edm.Int16' });
    const jsonSchema = await generateJsonSchema({ metadataReportJson: meta });
    const run = (jsonPayload: Record<string, unknown>, acquisition?: string) =>
      combineErrors(validate({ jsonSchema, jsonPayload, resourceName: 'Property', version: '2.0', errorMap: {}, ...(acquisition ? { acquisition } : {}) }));
    // depth 2: Property → ListAgent (Member) → Office (Office) → NumberOfBranches (Edm.Decimal, scale 0)
    const deep = (v: number) => ({ '@reso.context': CTX, ListingKey: 'p', ListAgent: { MemberKey: 'm', Office: { OfficeKey: 'o', NumberOfBranches: v } } });
    const deepFraction = run(deep(1.5), 'rcf');
    expect(deepFraction.totalErrors).toBe(0); expect(deepFraction.totalWarnings).toBe(1);
    expect(Object.keys(deepFraction.warnings ?? {}).join(' ')).toMatch(/scale 0/);
    const deepOver = run(deep(12345), 'rcf');
    expect(deepOver.totalErrors).toBe(0); expect(deepOver.totalWarnings).toBe(1);
    expect(run(deep(1.5), 'transport').totalErrors).toBe(1);
    // an Int16 over its range or with a fraction: the type MUST on rcf too
    const int16Over = run({ '@reso.context': CTX, TestInt16: 70000 }, 'rcf');
    expect(int16Over.totalErrors).toBe(1); expect(int16Over.totalWarnings).toBe(0);
    expect(Object.keys(int16Over.errors ?? {}).join(' ')).toMatch(/MUST be <= 65535/);
    const int16Fraction = run({ '@reso.context': CTX, TestInt16: 1.5 }, 'rcf');
    expect(int16Fraction.totalErrors).toBe(1); expect(int16Fraction.totalWarnings).toBe(0);
    // the presence heuristic (no acquisition, context present): both numeric cases stay a MUST
    const heuristicOver = run({ '@reso.context': CTX, BathroomsFull: 12345 });
    expect(heuristicOver.totalErrors).toBe(1); expect(heuristicOver.totalWarnings).toBe(0);
    const heuristicFraction = run({ '@reso.context': CTX, BathroomsFull: 2.5 });
    expect(heuristicFraction.totalErrors).toBe(1); expect(heuristicFraction.totalWarnings).toBe(0);
    // depth 2 over precision on transport, single record and the `value` envelope: the MUST holds
    expect(run(deep(12345), 'transport').totalErrors).toBe(1);
    const deepPage = run({ '@reso.context': CTX, value: [{ ListingKey: 'p', ListAgent: { MemberKey: 'm', Office: { OfficeKey: 'o', NumberOfBranches: 12345 } } }] }, 'transport');
    expect(deepPage.totalErrors).toBe(1); expect(deepPage.totalWarnings).toBe(0);
    // through a COLLECTION expansion (an index segment after the expansion): Media[0].Order is a scale-0 decimal
    const inCollection = (v: number) => ({ '@reso.context': CTX, value: [{ ListingKey: 'p', Media: [{ MediaKey: 'm', Order: v }] }] });
    const collFraction = run(inCollection(1.5), 'rcf');
    expect(collFraction.totalErrors).toBe(0); expect(collFraction.totalWarnings).toBe(1);
    expect(Object.keys(collFraction.warnings ?? {}).join(' ')).toMatch(/scale 0/);
    const collOver = run(inCollection(12345), 'rcf');
    expect(collOver.totalErrors).toBe(0); expect(collOver.totalWarnings).toBe(1);
    expect(Object.keys(collOver.warnings ?? {}).join(' ')).toMatch(/precision/);
    // a real Edm.Int64 in the reference (EntityEvent.EntityEventSequence): its range cap and a fraction stay a MUST on rcf
    const eventCtx = 'urn:reso:metadata:2.0:resource:entityevent';
    const event = (v: number) => combineErrors(validate({ jsonSchema, jsonPayload: { '@reso.context': eventCtx, EntityEventSequence: v }, resourceName: 'EntityEvent', version: '2.0', errorMap: {}, acquisition: 'rcf' }));
    expect(event(1e30).totalErrors).toBe(1); expect(event(1e30).totalWarnings).toBe(0);
    expect(event(1.5).totalErrors).toBe(1); expect(event(1.5).totalWarnings).toBe(0);
  });

  it('the schema is left as it was found after a compile failure (no residue for the next resource)', async () => {
    // A minimal report: Member carries a navigation whose target type has no definition anywhere (the 494d9be
    // shape), so its resource-specific schema cannot compile; Property and Office reference nothing and compile.
    // (In the full DD reference the poison is transitive — Property → ListAgent → Member — so the isolated case
    // needs a report where nobody references Member.)
    const field = (resourceName: string, fieldName: string, type: string, extra: Record<string, unknown> = {}) =>
      ({ resourceName, fieldName, type, nullable: true, isCollection: false, isExpansion: false, annotations: [], ...extra });
    const minimal = {
      description: '', version: '2.0', generatedOn: '', resources: [], models: [], actions: [], functions: [], lookups: [],
      fields: [
        field('Property', 'ListingKey', 'Edm.String', { nullable: false }), field('Property', 'TestMaxLengthField', 'Edm.String', { maxLength: 5 }),
        field('Member', 'MemberKey', 'Edm.String', { nullable: false }),
        field('Member', 'Media', 'Collection(org.reso.metadata.ContainedMedia)', { typeName: 'ContainedMedia', isCollection: true, isExpansion: true }),
        field('Office', 'OfficeKey', 'Edm.String', { nullable: false }), field('Office', 'OfficeName', 'Edm.String', { maxLength: 5 }),
      ],
    };
    const jsonSchema = await generateJsonSchema({ metadataReportJson: minimal });
    const before = JSON.stringify(jsonSchema.oneOf);
    expect(() => validate({ jsonSchema, jsonPayload: { MemberKey: 'm' }, resourceName: 'Member', version: '2.0', errorMap: {}, acquisition: 'transport' })).toThrow();
    expect(JSON.stringify(jsonSchema.oneOf)).toBe(before); // before: the mutated oneOf (Member's properties merged in) was left behind
    // and the next resources are evaluated, not poisoned
    const office = combineErrors(validate({ jsonSchema, jsonPayload: { OfficeKey: 'o', OfficeName: 'waytoolongvalue' }, resourceName: 'Office', version: '2.0', errorMap: {}, acquisition: 'transport' }));
    expect(office.totalErrors).toBe(1);
    expect(office.errors?.[MUST]).toBeTruthy();
    const property = combineErrors(validate({ jsonSchema, jsonPayload: { ListingKey: 'p', ...overflow }, resourceName: 'Property', version: '2.0', errorMap: {}, acquisition: 'transport' }));
    expect(property.totalErrors).toBe(1);
  });
});
