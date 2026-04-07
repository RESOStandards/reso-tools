/**
 * Fixture data for the Cert UI while the real
 * POST /api/v1/certification_reports/filter response shape is being
 * captured live. Replace the fixtures import with a real fetch hook
 * once the response shape is typed and an endpoint adapter is in
 * place — the field names below are best-effort matches to the old
 * cert app's `report` shape and will need verification.
 *
 * TODO(real-shape): swap out for the real response once captured.
 */

/** Endorsement type — matches the old cert app's `endorsementsConfig` keys. */
export type EndorsementType =
  | 'data_dictionary'
  | 'web_api_server_core'
  | 'add_edit'
  | 'entity_event'
  | 'reso_common_format'
  | 'webhooks';

/** Endorsement status — semantic, drives the status pill color. */
export type EndorsementStatus =
  | 'active'
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'failed'
  | 'closed'
  | 'expired';

/** A single endorsement / cert report row. */
export interface Endorsement {
  readonly id: string;
  readonly type: EndorsementType;
  /** Human label for the type (e.g. "Data Dictionary"). */
  readonly typeLabel: string;
  readonly version: string;
  readonly status: EndorsementStatus;

  /** Owning organization (the MLS / vendor) UOI. */
  readonly providerUoi: string;
  readonly providerName: string;
  /** Optional system name (provider may have multiple systems). */
  readonly systemName?: string;
  readonly providerUsi?: string;

  /** Recipient organization UOI — who the endorsement is recorded against. */
  readonly recipientUoi: string;
  readonly recipientName?: string;

  /** ISO-8601 timestamp of last status change. */
  readonly statusTimestamp: string;

  /** True for jobs run from a local CLI runner; false for cloud. */
  readonly local: boolean;

  /** Step that failed, if status is failed/in_review. */
  readonly failedStep?: string;

  // ── DD-specific aggregates (only meaningful when type === 'data_dictionary') ──

  readonly standardResourcesCount?: number;
  readonly localResourcesCount?: number;
  readonly standardFieldsCount?: number;
  readonly localFieldsCount?: number;
  readonly standardLookupsCount?: number;
  readonly localLookupsCount?: number;
  readonly idxFieldsCount?: number;
  readonly totalStandardIdxFieldsCount?: number;
}

/**
 * Stub endorsement records spanning the variety of states/types so the
 * UI can render meaningful examples while the real wire-up is pending.
 * Timestamps are intentionally spread to make the relative-date display
 * meaningful (today, this week, last month, last year).
 */

// ── Programmatic generator (declared above ENDORSEMENT_FIXTURES so the
//    arrow function is in scope when the const initializes) ─────────────
//
// Hand-rolling enough rows to exercise infinite scroll is tedious, so we
// derive ~30 more endorsements from a small catalog of realistic-ish
// providers + a deterministic distribution of types, statuses, and dates.
// The output is stable across runs (no Date.now or Math.random in the
// derivation) so the test surface is predictable.

interface ProviderEntry {
  readonly providerUoi: string;
  readonly providerName: string;
  readonly systemName: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly recipientName: string;
}

const PROVIDER_CATALOG: ReadonlyArray<ProviderEntry> = [
  { providerUoi: 'P00010001', providerName: 'NorthstarMLS',          systemName: 'Matrix',         providerUsi: '10001', recipientUoi: 'M00010001', recipientName: 'NorthstarMLS' },
  { providerUoi: 'P00010002', providerName: 'MLSListings',           systemName: 'Paragon',        providerUsi: '10002', recipientUoi: 'M00010002', recipientName: 'MLSListings' },
  { providerUoi: 'P00010003', providerName: 'Houston Association',   systemName: 'Matrix',         providerUsi: '10003', recipientUoi: 'M00010003', recipientName: 'HAR' },
  { providerUoi: 'P00010004', providerName: 'Triad MLS',             systemName: 'Flexmls',        providerUsi: '10004', recipientUoi: 'M00010004', recipientName: 'Triad MLS' },
  { providerUoi: 'P00010005', providerName: 'Realtors Property Resource', systemName: 'RPR Online', providerUsi: '10005', recipientUoi: 'M00010005', recipientName: 'RPR' },
  { providerUoi: 'P00010006', providerName: 'BeachesMLS',            systemName: 'Matrix',         providerUsi: '10006', recipientUoi: 'M00010006', recipientName: 'BeachesMLS' },
  { providerUoi: 'P00010007', providerName: 'Metropolitan Indianapolis BoR', systemName: 'Paragon', providerUsi: '10007', recipientUoi: 'M00010007', recipientName: 'MIBOR' },
  { providerUoi: 'P00010008', providerName: 'MRED LLC',              systemName: 'connectMLS',     providerUsi: '10008', recipientUoi: 'M00010008', recipientName: 'MRED' },
  { providerUoi: 'P00010009', providerName: 'Greater Las Vegas',     systemName: 'Matrix',         providerUsi: '10009', recipientUoi: 'M00010009', recipientName: 'GLVAR' },
  { providerUoi: 'P00010010', providerName: 'Austin Board of Realtors', systemName: 'Matrix',     providerUsi: '10010', recipientUoi: 'M00010010', recipientName: 'ABoR' },
  { providerUoi: 'P00010011', providerName: 'Atlanta Realtors',      systemName: 'FBS',            providerUsi: '10011', recipientUoi: 'M00010011', recipientName: 'FMLS' },
  { providerUoi: 'P00010012', providerName: 'Maine Listings',        systemName: 'Flexmls',        providerUsi: '10012', recipientUoi: 'M00010012', recipientName: 'Maine Listings' }
];

interface TypeEntry {
  readonly type: EndorsementType;
  readonly typeLabel: string;
  readonly versions: ReadonlyArray<string>;
}

const TYPE_CATALOG: ReadonlyArray<TypeEntry> = [
  { type: 'data_dictionary',     typeLabel: 'Data Dictionary',     versions: ['2.0', '2.1'] },
  { type: 'web_api_server_core', typeLabel: 'Web API Server Core', versions: ['2.0.0', '2.1.0'] },
  { type: 'add_edit',            typeLabel: 'Add/Edit',            versions: ['1.0'] },
  { type: 'entity_event',        typeLabel: 'Entity Event',        versions: ['1.0'] }
];

/**
 * Status distribution — repeated weights drive how often each status
 * appears in the generated set. Roughly mirrors a real-world feed where
 * most things are active, fewer are in progress, very few are failed.
 */
const STATUS_DISTRIBUTION: ReadonlyArray<EndorsementStatus> = [
  'active', 'active', 'active', 'active', 'active',
  'in_progress', 'in_progress',
  'pending', 'pending',
  'in_review',
  'failed',
  'closed', 'closed',
  'expired'
];

/** Days-ago offsets, deterministic, spread across the last ~14 months. */
const DAYS_AGO_SEQUENCE: ReadonlyArray<number> = [
  1, 3, 6, 11, 19, 28, 42, 58, 77, 99, 124, 151, 180, 215, 256, 301, 350, 410
];

/** Generate a stable ISO timestamp N days before a fixed reference date. */
const daysBefore = (days: number): string => {
  // Reference epoch is the end of 2026-04-06 (the day this fixture set
  // was authored) so the relative-date display tells a stable story.
  const REFERENCE_MS = Date.UTC(2026, 3, 6, 23, 0, 0);
  return new Date(REFERENCE_MS - days * 86_400_000).toISOString();
};

/** Failed-step exemplars used to populate the failedStep field. */
const FAILED_STEPS: ReadonlyArray<string> = [
  'Variations',
  'Metadata serialization',
  'Sequence integrity check',
  'Replication',
  'Lookup resource'
];

/** Synthetic DD stat counts driven by a deterministic seed integer. */
const buildDdStats = (seed: number) => ({
  standardResourcesCount: 12 + (seed % 4),
  localResourcesCount: (seed * 3) % 5,
  standardFieldsCount: 380 + ((seed * 17) % 180),
  localFieldsCount: (seed * 7) % 50,
  standardLookupsCount: 80 + ((seed * 11) % 35),
  localLookupsCount: (seed * 5) % 6,
  idxFieldsCount: 140 + ((seed * 13) % 60),
  totalStandardIdxFieldsCount: 195
});

const generateAdditionalEndorsements = (): ReadonlyArray<Endorsement> => {
  const out: Array<Endorsement> = [];
  let seed = 0;

  for (const provider of PROVIDER_CATALOG) {
    for (const typeEntry of TYPE_CATALOG) {
      // Skip ~30% of (provider, type) combos so the matrix isn't perfectly
      // dense — real feeds are uneven and that variety is more interesting
      // to look at than a regular grid.
      if ((seed * 7 + 3) % 10 < 3) {
        seed += 1;
        continue;
      }

      const version = typeEntry.versions[seed % typeEntry.versions.length];
      const status = STATUS_DISTRIBUTION[seed % STATUS_DISTRIBUTION.length];
      const daysAgo = DAYS_AGO_SEQUENCE[seed % DAYS_AGO_SEQUENCE.length];
      const local = seed % 5 === 0;
      const isFailedLike = status === 'failed' || status === 'in_review';

      out.push({
        id: `gen-${provider.providerUoi}-${typeEntry.type}-${version}`,
        type: typeEntry.type,
        typeLabel: typeEntry.typeLabel,
        version,
        status,
        providerUoi: provider.providerUoi,
        providerName: provider.providerName,
        systemName: provider.systemName,
        providerUsi: provider.providerUsi,
        recipientUoi: provider.recipientUoi,
        recipientName: provider.recipientName,
        statusTimestamp: daysBefore(daysAgo),
        local,
        ...(isFailedLike
          ? { failedStep: FAILED_STEPS[seed % FAILED_STEPS.length] }
          : {}),
        ...(typeEntry.type === 'data_dictionary' ? buildDdStats(seed) : {})
      });

      seed += 1;
    }
  }

  return out;
};

export const ENDORSEMENT_FIXTURES: ReadonlyArray<Endorsement> = [
  {
    id: 'fixture-dd20-active',
    type: 'data_dictionary',
    typeLabel: 'Data Dictionary',
    version: '2.0',
    status: 'active',
    providerUoi: 'P00000123',
    providerName: 'Bright MLS',
    systemName: 'Matrix',
    providerUsi: '12345',
    recipientUoi: 'M00000570',
    recipientName: 'Bright MLS',
    statusTimestamp: '2026-04-05T10:23:00Z',
    local: false,
    standardResourcesCount: 14,
    localResourcesCount: 2,
    standardFieldsCount: 487,
    localFieldsCount: 38,
    standardLookupsCount: 96,
    localLookupsCount: 4,
    idxFieldsCount: 178,
    totalStandardIdxFieldsCount: 195
  },
  {
    id: 'fixture-dd21-in-progress',
    type: 'data_dictionary',
    typeLabel: 'Data Dictionary',
    version: '2.1',
    status: 'in_progress',
    providerUoi: 'P00000456',
    providerName: 'CRMLS',
    systemName: 'Paragon',
    providerUsi: '54321',
    recipientUoi: 'M00000789',
    recipientName: 'California Regional MLS',
    statusTimestamp: '2026-04-06T18:11:00Z',
    local: true,
    standardResourcesCount: 14,
    localResourcesCount: 1,
    standardFieldsCount: 522,
    localFieldsCount: 12,
    standardLookupsCount: 102,
    localLookupsCount: 0,
    idxFieldsCount: 188,
    totalStandardIdxFieldsCount: 195
  },
  {
    id: 'fixture-core21-active',
    type: 'web_api_server_core',
    typeLabel: 'Web API Server Core',
    version: '2.1.0',
    status: 'active',
    providerUoi: 'P00000123',
    providerName: 'Bright MLS',
    systemName: 'Matrix',
    recipientUoi: 'M00000570',
    recipientName: 'Bright MLS',
    statusTimestamp: '2026-03-22T14:08:00Z',
    local: false
  },
  {
    id: 'fixture-addedit-pending',
    type: 'add_edit',
    typeLabel: 'Add/Edit',
    version: '1.0',
    status: 'pending',
    providerUoi: 'P00000789',
    providerName: 'Stellar MLS',
    systemName: 'Flexmls',
    recipientUoi: 'M00000111',
    recipientName: 'Stellar MLS',
    statusTimestamp: '2026-04-04T09:42:00Z',
    local: false
  },
  {
    id: 'fixture-ee-failed',
    type: 'entity_event',
    typeLabel: 'Entity Event',
    version: '1.0',
    status: 'failed',
    providerUoi: 'P00000456',
    providerName: 'CRMLS',
    systemName: 'Paragon',
    recipientUoi: 'M00000789',
    recipientName: 'California Regional MLS',
    statusTimestamp: '2026-04-06T22:55:00Z',
    local: true,
    failedStep: 'Sequence integrity check'
  },
  {
    id: 'fixture-dd20-in-review',
    type: 'data_dictionary',
    typeLabel: 'Data Dictionary',
    version: '2.0',
    status: 'in_review',
    providerUoi: 'P00000222',
    providerName: 'REcolorado',
    systemName: 'Matrix',
    recipientUoi: 'M00000333',
    recipientName: 'REcolorado',
    statusTimestamp: '2026-03-15T11:30:00Z',
    local: false,
    failedStep: 'Variations',
    standardResourcesCount: 14,
    localResourcesCount: 0,
    standardFieldsCount: 412,
    localFieldsCount: 22,
    standardLookupsCount: 88,
    localLookupsCount: 1,
    idxFieldsCount: 165,
    totalStandardIdxFieldsCount: 195
  },
  {
    id: 'fixture-core20-closed',
    type: 'web_api_server_core',
    typeLabel: 'Web API Server Core',
    version: '2.0.0',
    status: 'closed',
    providerUoi: 'P00000222',
    providerName: 'REcolorado',
    systemName: 'Matrix',
    recipientUoi: 'M00000333',
    recipientName: 'REcolorado',
    statusTimestamp: '2025-11-08T16:00:00Z',
    local: false
  },
  {
    id: 'fixture-dd21-expired',
    type: 'data_dictionary',
    typeLabel: 'Data Dictionary',
    version: '2.1',
    status: 'expired',
    providerUoi: 'P00000999',
    providerName: 'Heartland MLS',
    systemName: 'Rapattoni',
    recipientUoi: 'M00000444',
    recipientName: 'Heartland MLS',
    statusTimestamp: '2025-08-21T08:14:00Z',
    local: false
  },
  ...generateAdditionalEndorsements()
];
