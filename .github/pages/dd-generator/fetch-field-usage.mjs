#!/usr/bin/env node

/**
 * Fetch RESO field usage stats from the aggs API and output ranked fields per resource.
 *
 * Usage:
 *   env $(cat provider-config.env | xargs) node .github/pages/dd-generator/fetch-field-usage.mjs
 *
 * Output: .github/pages/dd-generator/field-usage.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DD_DATA_DIR = join(__dirname, '..', 'dd-data');
const OUTPUT_PATH = join(__dirname, 'field-usage.json');

// Use DD 2.0 as the baseline (current standard)
const DD_VERSION = '2.0';

// ---------------------------------------------------------------------------
// CSV Parser (same as generate.mjs)
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      let value = '';
      if (text[i] === '"') {
        i++;
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            value += text[i];
            i++;
          }
        }
      } else {
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          value += text[i];
          i++;
        }
      }
      row.push(value);
      if (i < len && text[i] === ',') {
        i++;
      } else {
        break;
      }
    }
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = (row[idx] || '').trim();
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

function loadVersion(version) {
  const fieldsPath = join(DD_DATA_DIR, version, 'fields.csv');
  const fields = parseCSV(readFileSync(fieldsPath, 'utf8'));

  const resourceMap = {};
  for (const field of fields) {
    const rn = field.ResourceName;
    if (!rn) continue;
    if (!resourceMap[rn]) resourceMap[rn] = [];
    resourceMap[rn].push(field);
  }

  return { resourceMap, fields };
}

// ---------------------------------------------------------------------------
// OAuth2 + Aggs Fetch
// ---------------------------------------------------------------------------

async function fetchToken() {
  const { TOKEN_URI, CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!TOKEN_URI || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing TOKEN_URI, CLIENT_ID, or CLIENT_SECRET environment variables');
  }

  console.log('Fetching OAuth2 token...');
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth2 token request failed: ${res.status} ${res.statusText}`);
  }

  const { access_token } = await res.json();
  return access_token;
}

async function fetchAggs(token, payload) {
  const { RESO_AGGS_URL } = process.env;
  if (!RESO_AGGS_URL) {
    throw new Error('Missing RESO_AGGS_URL environment variable');
  }

  const body = JSON.stringify(payload);
  console.log(`Sending aggs request (${payload.length} queries, ${body.length} bytes)...`);

  const res = await fetch(RESO_AGGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aggs request failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { resourceMap } = loadVersion(DD_VERSION);

  // Build field-only payload (no lookups — we just need field adoption rates)
  const payload = [];
  for (const [resourceName, fields] of Object.entries(resourceMap)) {
    const fieldNames = fields.map(f => f.StandardName).filter(Boolean);
    if (fieldNames.length > 0) {
      payload.push({ resourceName, fieldNames });
    }
  }

  console.log(`Loaded DD ${DD_VERSION}: ${Object.keys(resourceMap).length} resources`);

  const token = await fetchToken();
  const results = await fetchAggs(token, payload);

  // Response shape: { ResourceName: { FieldName: { mean, recipients }, ... }, ... }
  const ranked = {};
  for (const [resourceName, fields] of Object.entries(results)) {
    ranked[resourceName] = [];
    for (const [fieldName, stats] of Object.entries(fields)) {
      ranked[resourceName].push({
        field: fieldName,
        adoption: stats.mean ?? null,
        providers: stats.recipients ?? null,
      });
    }
  }

  // Sort each resource's fields by adoption descending
  for (const resource of Object.keys(ranked)) {
    ranked[resource].sort((a, b) => (b.adoption ?? -1) - (a.adoption ?? -1));
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(ranked, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);

  // Print top 10 for each resource as a preview
  for (const [resource, fields] of Object.entries(ranked)) {
    const top = fields.slice(0, 10);
    console.log(`\n${resource} (${fields.length} fields):`);
    for (const f of top) {
      const pct = f.adoption !== null ? (f.adoption * 100).toFixed(1) + '%' : 'n/a';
      console.log(`  ${pct.padStart(6)}  ${f.field}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
