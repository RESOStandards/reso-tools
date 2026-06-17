/**
 * computeVariationsV2 — the edit-distance budget tracks the runtime `fuzziness` parameter
 * (value-agnostic matcher; never a hardcoded 0.25).
 *
 * "ListtPrice" (raw length 10) is edit-distance d=1 from "ListPrice". The budget is
 * floor(fuzziness · 10): at the default 0.25 → 2 (admits d=1); at 0.05 → 0 (rejects d=1). A matcher
 * that hardcoded 0.25 would admit at both — so the 0.05 case has teeth.
 *
 * (Cert determinism is enforced by pinning the parameter to the default at the cloud-dispatch
 * boundary, not by the matcher; the matcher stays tunable, as exercised here.)
 *
 * Real DD 1.7 values; synthetic inputs — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const VERSION = '1.7';

const suggestsField = (fieldName: string, fuzziness: number, target: string): boolean => {
  const { variations } = computeVariationsV2({
    metadataReportJson: { fields: [{ resourceName: 'Property', fieldName }] },
    referenceMetadata: getReferenceMetadata(VERSION),
    version: VERSION,
    fuzziness,
    applyVersionBucketing: false,
  }) as { variations: { fields?: Array<Record<string, unknown>> } };
  return (variations.fields ?? []).some(
    (f) =>
      f.suggestedFieldName === target ||
      ((f.suggestions as Array<Record<string, unknown>>) ?? []).some((s) => s.suggestedFieldName === target),
  );
};

describe('computeVariationsV2: edit-distance budget scales on the runtime fuzziness parameter', () => {
  it('default 0.25 admits "ListtPrice" → "ListPrice" (d=1 ≤ floor(0.25·10)=2)', () => {
    expect(suggestsField('ListtPrice', 0.25, 'ListPrice')).toBe(true);
  });

  it('0.05 rejects the same match (d=1 > floor(0.05·10)=0) — proves the budget reads the param', () => {
    expect(suggestsField('ListtPrice', 0.05, 'ListPrice')).toBe(false);
  });
});
