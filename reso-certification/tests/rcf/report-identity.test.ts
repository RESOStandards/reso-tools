import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUBMITTABLE_REPORT_FILENAME, readRcfReportIdentity, submittableVariationsReport } from '../../src/cli/rcf-command.js';
import type { VariationsServiceReport } from '../../src/variations/index.js';
import { submitVariationsReportViaService } from '../../src/variations/index.js';

/**
 * An rcf run writes a variations report that submit-variations-report takes, once it is told whose review it is.
 *
 * A DD run takes the provider, system and recipient from its config file and writes them into
 * variations-report.json. rcf has no config file, so it takes them as flags. These fail if a partial identity is
 * accepted, if a report is written with nothing in it to review, or if what rcf writes is not what submit reads.
 *
 * Identities here are synthetic.
 */
const IDENTITY = { providerUoi: 'P001', providerUsi: 'S001', recipientUoi: 'R001' };
const GENERATED_ON = '2026-10-27T23:00:00.000Z';

const lookup = {
  level: 'lookup',
  resourceName: 'Property',
  fieldName: 'StandardStatus',
  lookupValue: 'Coming soon',
  suggestions: [{ suggestedLookupValue: 'Coming Soon', strategy: 'Substring', exactMatch: true }],
  enforcement: 'must-fix'
};
const field = {
  level: 'field',
  resourceName: 'Property',
  fieldName: 'ListPrce',
  suggestions: [{ suggestedFieldName: 'ListPrice' }],
  enforcement: 'must-fix'
};

const serviceReport = (variations: Record<string, unknown>): VariationsServiceReport => ({
  description: 'Data Dictionary Variations Report',
  version: '2.1',
  fuzziness: 0.25,
  variations
});

describe('the report identity rcf is given', () => {
  it('takes all three, less surrounding space', () => {
    expect(readRcfReportIdentity({ providerUoi: ' P001 ', providerUsi: 'S001', recipientUoi: 'R001\n' })).toEqual({
      ok: true,
      identity: IDENTITY
    });
  });

  it('is none when no flag is given, or only empty ones', () => {
    expect(readRcfReportIdentity({})).toEqual({ ok: true, identity: undefined });
    expect(readRcfReportIdentity({ providerUoi: '', providerUsi: '  ' })).toEqual({ ok: true, identity: undefined });
  });

  it('refuses a partial set and names what is missing', () => {
    expect(readRcfReportIdentity({ providerUoi: 'P001', providerUsi: 'S001' })).toEqual({
      ok: false,
      error:
        '--provider-uoi, --provider-usi, --recipient-uoi go together, because a review is filed under all three. Missing: --recipient-uoi'
    });
    const onlyRecipient = readRcfReportIdentity({ recipientUoi: 'R001' });
    expect(onlyRecipient.ok).toBe(false);
    expect(onlyRecipient.ok ? '' : onlyRecipient.error).toMatch(/Missing: --provider-uoi, --provider-usi$/);
  });

  it('refuses a value with a space or a slash inside', () => {
    expect(readRcfReportIdentity({ ...IDENTITY, providerUsi: 'S 001' })).toEqual({
      ok: false,
      error: '--provider-usi must be one value, with no spaces or slashes'
    });
    expect(readRcfReportIdentity({ ...IDENTITY, recipientUoi: 'R001/x' }).ok).toBe(false);
  });
});

describe('the report rcf writes for submit', () => {
  it('has the shape a DD run writes: version and coordinates first, then the buckets', () => {
    const report = submittableVariationsReport(
      { version: '2.1', variations: serviceReport({ fields: [field], lookups: [lookup] }) },
      IDENTITY,
      GENERATED_ON
    );
    expect(report).toEqual({ version: '2.1', ...IDENTITY, generatedOn: GENERATED_ON, fuzziness: 0.25, fields: [field], lookups: [lookup] });
    expect(Object.keys(report ?? {}).slice(0, 6)).toEqual([
      'version',
      'providerUoi',
      'providerUsi',
      'recipientUoi',
      'generatedOn',
      'fuzziness'
    ]);
  });

  it('is not written without an identity, without a variations pass, or when the pass found nothing', () => {
    const found = { version: '2.1', variations: serviceReport({ lookups: [lookup] }) };
    expect(submittableVariationsReport(found, undefined, GENERATED_ON)).toBeUndefined();
    expect(submittableVariationsReport({ version: '2.1' }, IDENTITY, GENERATED_ON)).toBeUndefined();
    expect(
      submittableVariationsReport({ version: '2.1', variations: serviceReport({ fields: [], lookups: [] }) }, IDENTITY, GENERATED_ON)
    ).toBeUndefined();
  });

  it('is what submit-variations-report reads: its own dry run takes the coordinates and counts the changes', async () => {
    const report = submittableVariationsReport(
      { version: '2.1', variations: serviceReport({ fields: [field], lookups: [lookup] }) },
      IDENTITY,
      GENERATED_ON
    );
    expect(await submitVariationsReportViaService({ report, dryRun: true })).toEqual({
      ...IDENTITY,
      version: '2.1',
      changeCount: 2,
      dryRun: true
    });
  });

  it('goes in the file a DD run writes', () => {
    const ddStep = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/sdk/dd.ts'), 'utf8');
    expect(SUBMITTABLE_REPORT_FILENAME).toBe('variations-report.json');
    expect(ddStep).toContain(`join(ctx.outputPath, '${SUBMITTABLE_REPORT_FILENAME}')`);
  });
});
