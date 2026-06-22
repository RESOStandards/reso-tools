#!/usr/bin/env node
/**
 * Bundle the canonical DD reference JSON from transport.
 *
 * transport (RESOStandards/transport) owns DD reference generation: its generate-dd-json workflow
 * regenerates references/dd/json/dd-{ver}.json from the XLSX on every sheet change. reso-tools
 * CONSUMES those artifacts — it no longer generates its own. This script copies the live JSON from
 * transport into the two reference-metadata locations reso-tools bundles:
 *   - reso-certification/reference-metadata/dd-{ver}.json         (built into dist/, cert runner)
 *   - reso-certification/src/etl/reference-metadata/dd-{ver}.json (ETL)
 *
 * Run from the repo root when transport's DD reference JSON updates:
 *   node reso-certification/utils/fetch-dd-reference.mjs
 *
 * Override the source ref with TRANSPORT_REF (default: main).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const VERSIONS = ['1.7', '2.0', '2.1'];
const REF = process.env.TRANSPORT_REF ?? 'main';

const sourceUrl = (version) =>
  `https://raw.githubusercontent.com/RESOStandards/transport/${REF}/references/dd/json/dd-${version}.json`;

const targets = (version) => [
  `reso-certification/reference-metadata/dd-${version}.json`,
  `reso-certification/src/etl/reference-metadata/dd-${version}.json`,
];

for (const version of VERSIONS) {
  const url = sourceUrl(version);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch dd-${version}.json from ${url}: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.error(`dd-${version}.json from transport is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (
    !Array.isArray(data.fields) || data.fields.length === 0 ||
    !Array.isArray(data.lookups) || data.lookups.length === 0
  ) {
    console.error(`dd-${version}.json from transport looks empty (fields/lookups missing)`);
    process.exit(1);
  }

  for (const target of targets(version)) {
    const path = resolve(target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    console.log(
      `✓ ${target} (${data.fields.length} fields, ${data.lookups.length} lookups, generatedOn ${data.generatedOn})`,
    );
  }
}

console.log(`\nBundled DD reference JSON from transport@${REF}.`);
