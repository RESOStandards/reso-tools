#!/usr/bin/env node
/**
 * Repair the committed seed dataset's scale-0 Decimal fields (reso-tools-private #103 follow-up).
 *
 * The July 2026 generator chose decimal places by field NAME ("Width/Length" → 1 place) and ignored the DD
 * scale, so nine scale-0 Edm.Decimal fields carried fractional values the server's own cert rejects
 * ("MUST be integer or null but found decimal"). The generator is fixed (a field's scale is the ceiling on
 * decimal places); this script applies the fixed generator's rule and bounds to exactly those fields in the
 * existing dataset, leaving every key, FK link and other value byte-identical. Deterministic: values come from
 * a seeded PRNG so the repair is reproducible (see seed-data/README.md).
 *
 *   node scripts/repair-seed-scale-0.mjs [in.json.gz] [out.json.gz]   (defaults: seed-data/seed.json.gz in place)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

// The fixed generator's NUMERIC_BOUNDS for these names, with decimals forced to the DD scale (0).
const REPAIRS = {
  Property: {
    NumberOfSeparateElectricMeters: { min: 1, max: 20 },
    NumberOfSeparateGasMeters: { min: 1, max: 20 },
    NumberOfSeparateWaterMeters: { min: 1, max: 20 },
    MobileLength: { min: 10, max: 80 },
    MobileWidth: { min: 10, max: 80 },
  },
  Media: {
    ImageHeight: { min: 100, max: 4096 },
    ImageWidth: { min: 100, max: 4096 },
  },
  PropertyGreenVerification: { GreenVerificationMetric: { min: 0, max: 100 } },
  PropertyPowerProduction: { PowerProductionAnnual: { min: 1, max: 500 } },
};

// mulberry32 — small, seeded, reproducible.
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SEED = 20260917;
const rand = prng(SEED);
const randomInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

const [inPath = 'seed-data/seed.json.gz', outPath = inPath] = process.argv.slice(2);
const data = JSON.parse(gunzipSync(readFileSync(inPath)).toString('utf8'));
const changed = {};
for (const [resource, fields] of Object.entries(REPAIRS)) {
  for (const record of data[resource] ?? []) {
    for (const [field, { min, max }] of Object.entries(fields)) {
      const value = record[field];
      if (typeof value === 'number' && !Number.isInteger(value)) {
        record[field] = randomInt(min, max);
        changed[`${resource}.${field}`] = (changed[`${resource}.${field}`] ?? 0) + 1;
      }
    }
  }
}
writeFileSync(outPath, gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 }));
console.log(JSON.stringify({ seed: SEED, in: inPath, out: outPath, changed }, null, 1));
