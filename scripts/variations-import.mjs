#!/usr/bin/env node
/**
 * V1 → V2 variations re-importer via the admin API.
 *
 * Reads a base64+zlib-encoded V1 variations file (the same shape S3
 * stores), walks the nested triple-index, generates UpdateItems, buckets
 * them by request-flag combination (plain / Admin Review / Fast Track),
 * and POSTs each bucket in chunks against the v2 admin endpoint.
 *
 * Usage:
 *   node --env-file=.env scripts/variations-import.mjs ~/Downloads/variations.txt
 *   node --env-file=.env scripts/variations-import.mjs ~/Downloads/variations.txt --dry-run
 *   node --env-file=.env scripts/variations-import.mjs ~/Downloads/variations.txt --chunk-size=500
 *
 * Reads the same OAuth2 env vars as variations-cli.mjs:
 *   TOKEN_URI, CLIENT_ID, CLIENT_SECRET, RESO_SERVICES_URL
 *
 * Notes:
 *   - Chunks are POSTed sequentially. Concurrent admin writes would
 *     race on the S3 ETag; sequential keeps it boring.
 *   - The "106-rejects" pre-processing from the prior session isn't
 *     reproduced here — that needed DD 2.0 reference data we don't
 *     have committed. Items with ambiguous SimpleIdentifier/StandardLookupValue
 *     mappings get pushed through; the analyst review step would be a
 *     follow-up against the resulting state.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const required = ['TOKEN_URI', 'CLIENT_ID', 'CLIENT_SECRET', 'RESO_SERVICES_URL'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const chunkSizeArg = args.find(a => a.startsWith('--chunk-size='));
const CHUNK_SIZE = chunkSizeArg ? parseInt(chunkSizeArg.split('=')[1], 10) : 1000;
const bucketsArg = args.find(a => a.startsWith('--buckets='));
const BUCKETS_FILTER = bucketsArg
  ? new Set(bucketsArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean))
  : null;
const reportOutArg = args.find(a => a.startsWith('--report-out='));
const REPORT_OUT = reportOutArg ? reportOutArg.split('=')[1] : null;
const inputPath = args.find(a => !a.startsWith('--'));
if (!inputPath) {
  console.error('Usage: variations-import.mjs <path-to-variations.txt> [--dry-run] [--chunk-size=N] [--buckets=plain,admin-review,fast-track] [--report-out=path.json]');
  process.exit(1);
}

const FLAG_KEYS = new Set(['suggestions', 'ignored', 'isFastTrack', 'isAdminReview', 'createdAt', 'updatedAt', 'targetVersion', 'detectedAt', 'reviewStartedAt', 'lastTestedAt', 'lastProviderActivityAt', 'lastAdminActivityAt', 'resolvedAt', 'providerCount']);

// ── Decode + parse ───────────────────────────────────────────────────

const raw = readFileSync(inputPath, 'utf8').trim();
const decoded = inflateSync(Buffer.from(raw, 'base64')).toString('utf8');
const file = JSON.parse(decoded);
const mappings = file.mappings ?? file;

// ── Walk + bucket ────────────────────────────────────────────────────

/** Flag bucket keys: 'plain' | 'admin-review' | 'fast-track' */
const buckets = { plain: [], 'admin-review': [], 'fast-track': [] };

const flagOf = (entry) => {
  if (entry.isFastTrack) return 'fast-track';
  if (entry.isAdminReview) return 'admin-review';
  return 'plain';
};

const flagOfSuggestion = (s) => {
  if (s.isFastTrack) return 'fast-track';
  if (s.isAdminReview) return 'admin-review';
  return 'plain';
};

const SUGGESTION_FIELD_ALLOWLIST = new Set([
  'suggestedResourceName',
  'suggestedFieldName',
  'suggestedLookupValue',
  'suggestedLegacyODataValue',
  'suggestedRelatedResourceName',
  'suggestedRelatedFieldName',
  'suggestedRelatedLookupValue',
  'strategy',
  'ddWikiUrl',
]);

const cleanSuggestion = (s) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => SUGGESTION_FIELD_ALLOWLIST.has(k)));

/** Emit items for an entry at the given path. Returns count emitted. */
const emitEntry = (entry, identity) => {
  let emitted = 0;
  const hasSuggestions = Array.isArray(entry.suggestions) && entry.suggestions.length > 0;

  if (entry.ignored && !hasSuggestions) {
    buckets[flagOf(entry)].push({ ...identity, outcome: 'Ignored' });
    emitted++;
    return emitted;
  }

  if (hasSuggestions) {
    for (const s of entry.suggestions) {
      const cleaned = cleanSuggestion(s);
      // Skip suggestions missing required identity fields — they'd error
      // server-side, no point sending.
      if (!cleaned.suggestedResourceName) continue;
      buckets[flagOfSuggestion(s)].push({ ...identity, ...cleaned });
      emitted++;
    }
    return emitted;
  }

  return emitted;
};

let totalScanned = 0;
let zombiesSkipped = 0;

for (const [resourceName, resourceData] of Object.entries(mappings)) {
  if (typeof resourceData !== 'object' || resourceData === null) continue;

  // Resource-level entry (rare): if resourceData itself has flags
  if (resourceData.ignored || (Array.isArray(resourceData.suggestions) && resourceData.suggestions.length > 0)) {
    totalScanned++;
    const emitted = emitEntry(resourceData, { resourceName });
    if (emitted === 0) zombiesSkipped++;
  }

  for (const [fieldName, fieldData] of Object.entries(resourceData)) {
    if (FLAG_KEYS.has(fieldName)) continue;
    if (typeof fieldData !== 'object' || fieldData === null) continue;

    // Field-level entry: fieldData has flags (the field itself is an entry)
    if (fieldData.ignored || (Array.isArray(fieldData.suggestions) && fieldData.suggestions.length > 0)) {
      totalScanned++;
      const emitted = emitEntry(fieldData, { resourceName, fieldName });
      if (emitted === 0) zombiesSkipped++;
    }

    // Lookup-level children
    for (const [lookupValue, lookupData] of Object.entries(fieldData)) {
      if (FLAG_KEYS.has(lookupValue)) continue;
      if (typeof lookupData !== 'object' || lookupData === null) continue;

      totalScanned++;
      const emitted = emitEntry(lookupData, { resourceName, fieldName, lookupValue });
      if (emitted === 0) zombiesSkipped++;
    }
  }
}

const totalToImport = buckets.plain.length + buckets['admin-review'].length + buckets['fast-track'].length;
console.log('═══ Walk summary ═══');
console.log(`Entries scanned:       ${totalScanned}`);
console.log(`Zombies skipped:       ${zombiesSkipped}`);
console.log(`Items to import:       ${totalToImport}`);
console.log(`  plain:               ${buckets.plain.length}`);
console.log(`  admin-review:        ${buckets['admin-review'].length}`);
console.log(`  fast-track:          ${buckets['fast-track'].length}`);
console.log(`Chunk size:            ${CHUNK_SIZE}`);
console.log(`Total POST batches:    ${Object.values(buckets).reduce((acc, b) => acc + Math.ceil(b.length / CHUNK_SIZE), 0)}`);

if (dryRun) {
  console.log('\n--dry-run set; not posting.');
  process.exit(0);
}

// ── Auth ─────────────────────────────────────────────────────────────

const fetchToken = async () => {
  const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
  const res = await fetch(process.env.TOKEN_URI, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
};

// ── POST loop ────────────────────────────────────────────────────────

const servicesUrl = process.env.RESO_SERVICES_URL.replace(/\/$/, '');

const postChunk = async (token, chunk, headers) => {
  const res = await fetch(`${servicesUrl}/v2/certification/variations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(chunk),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

const chunksOf = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const headersFor = (bucket) => {
  if (bucket === 'fast-track') return { isFastTrack: 'true' };
  if (bucket === 'admin-review') return { isAdminReview: 'true' };
  return {};
};

const aggStats = {
  totalSuggestions: 0,
  updatedResources: 0, removedResources: 0, ignoredResources: 0,
  updatedFields: 0, removedFields: 0, ignoredFields: 0,
  updatedLookups: 0, removedLookups: 0, ignoredLookups: 0,
  errors: 0,
  permissionDeniedCount: 0,
};

const token = await fetchToken();
console.log('\n═══ Importing ═══');

const startTs = Date.now();
let chunkIndex = 0;
const bucketOrder = ['plain', 'admin-review', 'fast-track'];
const reportRecords = REPORT_OUT ? [] : null;

for (const bucket of bucketOrder) {
  if (BUCKETS_FILTER && !BUCKETS_FILTER.has(bucket)) {
    console.log(`\n[${bucket}] skipped via --buckets filter`);
    continue;
  }
  const items = buckets[bucket];
  if (items.length === 0) continue;
  const chunks = chunksOf(items, CHUNK_SIZE);
  console.log(`\n[${bucket}] ${items.length} items → ${chunks.length} chunks`);

  for (let i = 0; i < chunks.length; i++) {
    chunkIndex++;
    const chunk = chunks[i];
    const t0 = Date.now();
    const { status, body } = await postChunk(token, chunk, headersFor(bucket));
    const dt = Date.now() - t0;

    if (reportRecords) {
      reportRecords.push({ bucket, chunkIndex: i + 1, totalChunks: chunks.length, items: chunk.length, status, dtMs: dt, body });
    }

    if (status !== 200) {
      console.error(`  chunk ${i + 1}/${chunks.length} (${chunk.length} items) — HTTP ${status} in ${dt}ms`);
      console.error(JSON.stringify(body, null, 2));
      if (reportRecords) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(REPORT_OUT, JSON.stringify(reportRecords, null, 2));
        console.error(`\nResponse log written to ${REPORT_OUT}`);
      }
      process.exit(2);
    }

    for (const k of Object.keys(aggStats)) {
      if (k === 'permissionDeniedCount') continue;
      if (typeof body[k] === 'number') aggStats[k] += body[k];
    }
    if (Array.isArray(body.permissionDenied)) {
      aggStats.permissionDeniedCount += body.permissionDenied.reduce((acc, g) => acc + (Array.isArray(g.items) ? g.items.length : 0), 0);
    }

    const total = aggStats.updatedFields + aggStats.updatedLookups + aggStats.ignoredFields + aggStats.ignoredLookups;
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${chunk.length} items) — ${dt}ms — running total: u=${aggStats.updatedFields + aggStats.updatedLookups} i=${aggStats.ignoredFields + aggStats.ignoredLookups} e=${aggStats.errors} d=${aggStats.permissionDeniedCount}\n`);
  }
}

const totalDt = Date.now() - startTs;
console.log('\n═══ Aggregate stats ═══');
console.log(JSON.stringify(aggStats, null, 2));
console.log(`\nTotal time: ${(totalDt / 1000).toFixed(1)}s across ${chunkIndex} chunks`);

if (reportRecords) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(REPORT_OUT, JSON.stringify(reportRecords, null, 2));
  console.log(`\nResponse log written to ${REPORT_OUT} (${reportRecords.length} chunks)`);
}
