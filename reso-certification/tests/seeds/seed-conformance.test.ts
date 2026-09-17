import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/**
 * Known-good / known-bad seed datasets (Josh, 2026-09-17): the reference server's committed seed must pass the
 * DD schema rules the server certifies against, and the dataset that FAILED them is kept as a fixture so the
 * rule that caught it — and the repair — stay regression-guarded.
 *
 * known-bad-scale-0-decimals: the July 2026 generator chose decimal places by field name and ignored the DD
 * scale; nine scale-0 Edm.Decimal fields carried fractional values ("MUST be integer or null but found decimal").
 * known-good: the same dataset with exactly those nine fields regenerated under the fixed rule
 * (reso-reference-server/scripts/repair-seed-scale-0.mjs, seeded PRNG 20260917) — every key, FK link and other
 * value unchanged. The reference server ships known-good as seed-data/seed.json.gz.
 */
const require = createRequire(import.meta.url);
const { generateJsonSchema, validate, combineErrors } = require(resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js'));
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const INTEGER_RULE = 'MUST be integer or null but found decimal';
const load = (name: string): Record<string, ReadonlyArray<Record<string, unknown>>> =>
  JSON.parse(gunzipSync(readFileSync(resolve(import.meta.dirname, `../fixtures/seeds/${name}.json.gz`))).toString('utf8'));

/** Per resource: the fields the integer rule flags, with counts. */
const integerFindings = async (seed: Record<string, ReadonlyArray<Record<string, unknown>>>): Promise<Record<string, Record<string, number>>> => {
  const jsonSchema = await generateJsonSchema({ metadataReportJson: getReferenceMetadata('2.0'), additionalProperties: false });
  const out: Record<string, Record<string, number>> = {};
  for (const [resourceName, records] of Object.entries(seed)) {
    if (!Array.isArray(records) || records.length === 0) continue;
    const report = combineErrors(validate({ jsonSchema, jsonPayload: { value: records }, resourceName, version: '2.0', errorMap: {}, acquisition: 'transport' }));
    const fields = report.errors?.[INTEGER_RULE]?.resources?.[resourceName]?.fields ?? {};
    const counts = Object.fromEntries(Object.entries(fields).map(([f, x]) => [f, (x as { count?: number }).count ?? 0]));
    if (Object.keys(counts).length > 0) out[resourceName] = counts;
  }
  return out;
};

const scale0Fields = (): ReadonlySet<string> =>
  new Set((getReferenceMetadata('2.0').fields as ReadonlyArray<{ resourceName: string; fieldName: string; type: string; scale?: number }>)
    .filter(f => f.type === 'Edm.Decimal' && f.scale === 0).map(f => `${f.resourceName}.${f.fieldName}`));

describe('reference-server seed datasets — known-bad and known-good', () => {
  it('known-bad reproduces the nine scale-0 integer violations, with these exact counts', async () => {
    expect(await integerFindings(load('known-bad-scale-0-decimals'))).toEqual({
      Property: { MobileLength: 28, MobileWidth: 23, NumberOfSeparateGasMeters: 32, NumberOfSeparateWaterMeters: 27, NumberOfSeparateElectricMeters: 34 },
      Media: { ImageHeight: 136, ImageWidth: 151 },
      PropertyGreenVerification: { GreenVerificationMetric: 29 },
      PropertyPowerProduction: { PowerProductionAnnual: 22 },
    });
  });

  it('known-good has no integer-rule finding on any resource, and no scale-0 Decimal field holds a fractional value', async () => {
    const seed = load('known-good');
    expect(await integerFindings(seed)).toEqual({});
    const scale0 = scale0Fields();
    const fractional = Object.entries(seed).flatMap(([res, records]) => records.flatMap(r => Object.entries(r).filter(([k, v]) => scale0.has(`${res}.${k}`) && typeof v === 'number' && !Number.isInteger(v)).map(([k]) => `${res}.${k}`)));
    expect(fractional).toEqual([]);
  });

  it('the repair changed only the nine fields: every other value, every key and every record count is identical', () => {
    const bad = load('known-bad-scale-0-decimals');
    const good = load('known-good');
    const repaired = new Set(['Property.MobileLength', 'Property.MobileWidth', 'Property.NumberOfSeparateGasMeters', 'Property.NumberOfSeparateWaterMeters', 'Property.NumberOfSeparateElectricMeters', 'Media.ImageHeight', 'Media.ImageWidth', 'PropertyGreenVerification.GreenVerificationMetric', 'PropertyPowerProduction.PowerProductionAnnual']);
    expect(Object.keys(good).sort()).toEqual(Object.keys(bad).sort());
    for (const [res, records] of Object.entries(bad)) {
      expect(good[res].length).toBe(records.length);
      records.forEach((rec, i) => {
        const other = good[res][i];
        expect(Object.keys(other).sort()).toEqual(Object.keys(rec).sort());
        for (const [k, v] of Object.entries(rec)) {
          if (repaired.has(`${res}.${k}`)) { if (typeof v === 'number' && !Number.isInteger(v)) expect(Number.isInteger(other[k])).toBe(true); else expect(other[k]).toEqual(v); }
          else expect(other[k]).toEqual(v);
        }
      });
    }
  });
});
