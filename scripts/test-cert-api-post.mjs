#!/usr/bin/env node
/**
 * Tests posting the sample-reports fixtures to the Cert API.
 *
 * Hits the endpoints defined in RESOStandards/reso-certification PR #2539:
 *   POST /api/v1/certification_reports/<type>/<providerUoi>              (success)
 *   POST /api/v1/certification_reports/<type>/<providerUoi>/failed       (failed)
 *   POST /api/v1/payload/data_availability/<reportId>                    (DD availability)
 *
 * Env vars (from ~/work/reso/reso-certification-utils/.env):
 *   CERT_AUTH_API_BASE_URL     (e.g. https://services.reso.org)
 *   CERTIFICATION_API_KEY      (base64 of apiKeyId:apiKey)
 *   CURRENT_PROVIDER_UOI
 *   CURRENT_PROVIDER_USI       (falls back to 'S00000001' if unset)
 *   CURRENT_RECIPIENT_UOI      (falls back to 'T00000001' if unset)
 *
 * Usage:
 *   node scripts/test-cert-api-post.mjs --dry-run
 *   node scripts/test-cert-api-post.mjs --only=dd-2.0
 *   node scripts/test-cert-api-post.mjs            # post all fixtures
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = args.find(a => a.startsWith('--only='))?.slice('--only='.length);

// ── Env loading ─────────────────────────────────────────────────────
const ENV_FILE = resolve(process.env.HOME, 'work/reso/reso-certification-utils/.env');
const loadEnv = () => {
  if (!existsSync(ENV_FILE)) {
    console.error(`Missing env file: ${ENV_FILE}`);
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
};

const env = loadEnv();
const BASE = env.CERT_AUTH_API_BASE_URL ?? env.RESO_SERVICES_URL;
const API_KEY = env.CERTIFICATION_API_KEY;
const PROVIDER_UOI = env.CURRENT_PROVIDER_UOI;
const PROVIDER_USI = env.CURRENT_PROVIDER_USI ?? 'S00000001';
const RECIPIENT_UOI = env.CURRENT_RECIPIENT_UOI ?? 'T00000001';

if (!BASE) { console.error('Missing CERT_AUTH_API_BASE_URL / RESO_SERVICES_URL'); process.exit(1); }
if (!API_KEY) { console.error('Missing CERTIFICATION_API_KEY (uncomment the QA block in .env)'); process.exit(1); }
if (!PROVIDER_UOI) { console.error('Missing CURRENT_PROVIDER_UOI'); process.exit(1); }

console.log(`Base URL:     ${BASE}`);
console.log(`Provider UOI: ${PROVIDER_UOI}`);
console.log(`Provider USI: ${PROVIDER_USI}`);
console.log(`Recipient UOI: ${RECIPIENT_UOI}`);
console.log(`Mode:         ${DRY_RUN ? 'DRY RUN (no actual POST)' : 'LIVE'}`);
console.log();

// ── Fixture map ─────────────────────────────────────────────────────
// Endorsement → API type + which fixtures we care about
const SCENARIOS = [
  {
    key: 'dd-2.0',
    apiType: 'data_dictionary',
    successBodyFile: 'sample-reports/dd-2.0/metadata-report.json',
    failedStep: 'Schema Validation',
    availabilityBodyFile: 'sample-reports/dd-2.0/data-availability-schema-validation-errors.json',
  },
  {
    key: 'core-2.0.0',
    apiType: 'web_api_server_core',
    successBodyFile: null, // Core doesn't post a metadata-report shape — only /failed and /success are relevant. Left blank.
    failedStep: 'Core Scenarios',
  },
  {
    key: 'add-edit-2.0.0',
    apiType: 'add_edit',
    successBodyFile: null,
    failedStep: 'Add/Edit Scenarios',
  },
  {
    key: 'entity-event-1.0.0',
    apiType: 'entity_event', // TODO confirm with backend — may differ
    successBodyFile: null,
    failedStep: 'EntityEvent Observe',
  },
];

// ── HTTP helper ─────────────────────────────────────────────────────
const post = async (url, headers, body) => {
  if (DRY_RUN) {
    console.log(`  → POST ${url}`);
    console.log(`    headers: ${JSON.stringify({ ...headers, Authorization: '<redacted>' })}`);
    console.log(`    body bytes: ${JSON.stringify(body).length}`);
    return { status: 0, body: { reportId: 'DRY_RUN_ID', id: 'DRY_RUN_ID' } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${API_KEY}`, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`  → POST ${url}`);
  console.log(`    ← ${res.status} ${res.statusText}`);
  console.log(`    ← ${typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`);
  return { status: res.status, body: parsed };
};

const readFixture = (relPath) => JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf-8'));

// ── Run scenarios ───────────────────────────────────────────────────
const run = async () => {
  for (const s of SCENARIOS) {
    if (ONLY && s.key !== ONLY) continue;

    console.log(`── ${s.key} (${s.apiType}) ─────────────────────────`);

    // 1. Post a failed report (works without a prior success).
    const reportSummary = readFixture(`sample-reports/${s.key}/report.json`);
    const failedBody = {
      description: reportSummary.description,
      version: reportSummary.version,
      generatedOn: reportSummary.generatedOn,
      recipientEmail: 'dev+cert-test@reso.org',
      failedStep: s.failedStep,
    };
    const failedUrl = `${BASE}/api/v1/certification_reports/${s.apiType}/${PROVIDER_UOI}/failed`;
    const failedHeaders = { recipientuoi: RECIPIENT_UOI, providerusi: PROVIDER_USI };
    console.log(`\n[FAILED] ${s.apiType}`);
    await post(failedUrl, failedHeaders, failedBody);

    // 2. If the endorsement has a success body, post that too.
    if (s.successBodyFile) {
      const body = readFixture(s.successBodyFile);
      const successUrl = `${BASE}/api/v1/certification_reports/${s.apiType}/${PROVIDER_UOI}`;
      const successHeaders = { recipientuoi: RECIPIENT_UOI, providerusi: PROVIDER_USI, send_notification: 'false' };
      console.log(`\n[SUCCESS] ${s.apiType}`);
      const { status, body: respBody } = await post(successUrl, successHeaders, body);

      // 3. If DD succeeded and we have an availability fixture, post it too.
      if (status >= 200 && status < 300 && s.availabilityBodyFile) {
        const reportId = respBody.id ?? respBody.reportId;
        if (reportId) {
          const availUrl = `${BASE}/api/v1/payload/data_availability/${reportId}`;
          console.log(`\n[AVAILABILITY] ${s.apiType} (reportId: ${reportId})`);
          await post(availUrl, {}, readFixture(s.availabilityBodyFile));
        }
      }
    }
    console.log();
  }
};

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
