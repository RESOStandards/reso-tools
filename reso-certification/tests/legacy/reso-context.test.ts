import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateJsonSchema, validate, combineErrors, checkResoContext, RESO_CONTEXT_MESSAGES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js')
);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

/**
 * reso-tools #298 — `@reso.context` is validated when present (RCF §3.4.1(a), IANA `reso` URN assignment:
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
});
