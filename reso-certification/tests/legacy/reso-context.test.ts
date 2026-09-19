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

  it('RCF + a well-formed context naming a resource the schema does not define: the result carries stats and caches (no TypeError downstream) and the payload error', async () => {
    const jsonSchema = await generateJsonSchema({ metadataReportJson: metadata });
    const result = validate({ jsonSchema, jsonPayload: { '@reso.context': 'urn:reso:metadata:2.0:resource:notaresource', value: [{ A: 1 }] }, resourceName: 'Notaresource', version: '2.0', errorMap: {}, acquisition: 'rcf' });
    expect(result.stats).toBeDefined(); // before: `return errorMap` → {} → replication's destructure of stats threw
    expect(result.errorCache).toBeDefined();
    expect(result.warningsCache).toBeDefined();
    const payloadErrors = result.payloadErrors as Record<string, Record<string, unknown>>;
    expect(Object.values(payloadErrors).some(byMessage => 'Invalid resource' in byMessage)).toBe(true);
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
