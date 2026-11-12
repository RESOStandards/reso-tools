/**
 * `apply-variation-decisions`: a decisions sheet applied to a report already under review, as a merge.
 *
 * The planner is pure and tested whole. The service call is tested against a stubbed fetch for what it sends:
 * a read, then one delta save (never `replaceReviewRows`), then a read back that is checked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatApplyItems, summarizeApplyPlan } from '../../src/cli/apply-command.js';
import { lockHolderOf } from '../../src/sdk/common.js';
import {
  RESO_COMMENT_AUTHOR,
  type StoredChange,
  type StoredReport,
  applyVariationDecisionsViaService,
  planApply,
  verifyApplied
} from '../../src/variations/apply.js';

const PROVIDER = 'T00000000';
const NOW = '2026-11-12T20:00:00.000Z';
const suggestion = (value: string) => ({ suggestedResourceName: 'Property', suggestedFieldName: 'X', suggestedStandardLookupValue: value });

const STORED: StoredReport = {
  changes: [
    { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', suggestions: [suggestion('Indoor Grill')] },
    { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Gas &amp; Electric Range', suggestions: [suggestion('Gas Range')] },
    {
      resourceName: 'Property',
      fieldName: 'InteriorFeatures',
      lookupValue: 'Local Shower',
      suggestions: [suggestion('Roll-In Shower'), suggestion('Hand-Held Shower Head')]
    },
    {
      resourceName: 'Property',
      fieldName: 'Heating',
      lookupValue: 'Local Heat',
      flaggedForFastTrack: true,
      suggestions: [suggestion('Forced Air')]
    },
    {
      resourceName: 'Property',
      fieldName: 'LocalOwnership',
      suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Ownership' }]
    }
  ]
};

const plan = (rows: Parameters<typeof planApply>[0]['rows'], stored: StoredReport = STORED) =>
  planApply({ stored, rows, providerUoi: PROVIDER, now: NOW });

describe('planApply', () => {
  it('sends each named item with every flag, and its comment from RESO to the provider', () => {
    const p = plan([
      { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', action: 'ignore', comment: 'We have ignored this.' }
    ]);
    expect(p.errors).toEqual([]);
    expect(p.items.map(i => i.change)).toEqual([
      {
        resourceName: 'Property',
        fieldName: 'Appliances',
        lookupValue: 'Local Grill',
        ignore: true,
        flaggedForFastTrack: false,
        remove: false,
        conversations: [{ timestamp: NOW, from: RESO_COMMENT_AUTHOR, to: PROVIDER, message: 'We have ignored this.' }]
      }
    ]);
  });

  it("keeps an item's stored decision when its row only comments, so the pool keeps it too", () => {
    const p = plan([{ resourceName: 'Property', fieldName: 'Heating', lookupValue: 'Local Heat', comment: 'Add Forced Air.' }]);
    expect(p.items[0]?.change).toMatchObject({ ignore: false, flaggedForFastTrack: true, remove: false });
    expect(p.items[0]?.action).toBe('submit-to-ft');
    expect(p.items[0]?.replaces).toBeUndefined();
  });

  it('says which decision a row replaces', () => {
    const p = plan([{ resourceName: 'Property', fieldName: 'Heating', lookupValue: 'Local Heat', action: 'ignore' }]);
    expect(p.items[0]).toMatchObject({ action: 'ignore', replaces: 'submit-to-ft' });
  });

  it('matches a value exactly as stored, entities included', () => {
    const p = plan([
      { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Gas &amp; Electric Range', comment: 'One range or two?' }
    ]);
    expect(p.errors).toEqual([]);
    expect(p.items).toHaveLength(1);
    expect(
      plan([{ resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Gas & Electric Range', comment: 'x' }]).errors
    ).toHaveLength(1);
  });

  it('matches a field-level row to the field-level item', () => {
    const p = plan([{ resourceName: 'Property', fieldName: 'LocalOwnership', action: 'ignore' }]);
    expect(p.items.map(i => i.element)).toEqual(['Property.LocalOwnership']);
  });

  it('notes an ignore that clears more than one suggestion', () => {
    const p = plan([{ resourceName: 'Property', fieldName: 'InteriorFeatures', lookupValue: 'Local Shower', action: 'ignore' }]);
    expect(p.warnings).toEqual([
      'Property.InteriorFeatures.Local Shower: the ignore covers the element, so it clears all 2 of its suggestions.'
    ]);
  });

  it('refuses rows it cannot apply, and plans nothing when any row is refused', () => {
    const p = plan([
      { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Not There', comment: 'x' },
      { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', action: 'accept' },
      { resourceName: 'Property', fieldName: 'Heating', lookupValue: 'Local Heat', comment: 'a' },
      { resourceName: 'Property', fieldName: 'Heating', lookupValue: 'Local Heat', comment: 'b' }
    ]);
    expect(p.errors).toEqual([
      'Property.Appliances.Not There: matches no item in the stored report.',
      'Property.Appliances.Local Grill: Action "accept" is not one of ignore, remove, submit-to-ft.',
      'Property.Heating.Local Heat: named by more than one row – merge them into one.',
      'Property.Heating.Local Heat: named by more than one row – merge them into one.'
    ]);
  });

  it('does not say again what is already on the thread, so a re-run changes nothing', () => {
    const said: StoredReport = {
      changes: [
        {
          resourceName: 'Property',
          fieldName: 'Appliances',
          lookupValue: 'Local Grill',
          ignore: true,
          conversations: [{ from: RESO_COMMENT_AUTHOR, to: PROVIDER, message: 'We have ignored this.' }]
        }
      ]
    };
    const p = plan(
      [
        {
          resourceName: 'Property',
          fieldName: 'Appliances',
          lookupValue: 'Local Grill',
          action: 'ignore',
          comment: 'We have ignored this.'
        }
      ],
      said
    );
    expect(p.items).toEqual([]);
    expect(p.unchanged).toEqual(['Property.Appliances.Local Grill: already ignore, and the comment is already on the thread']);
  });

  it("does not take the provider's own words for RESO's", () => {
    const providerSaid: StoredReport = {
      changes: [
        {
          resourceName: 'Property',
          fieldName: 'Appliances',
          lookupValue: 'Local Grill',
          conversations: [{ to: 'RESO', message: 'Same words.' }]
        }
      ]
    };
    expect(
      plan([{ resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', comment: 'Same words.' }], providerSaid).items
    ).toHaveLength(1);
  });
});

describe('verifyApplied', () => {
  const p = plan([
    { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', action: 'ignore', comment: 'Ignored.' }
  ]);
  const stored = (change: Partial<StoredChange>): StoredReport => ({
    changes: [{ resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', ...change }]
  });

  it('is empty when the report shows what was sent', () => {
    expect(verifyApplied(p, stored({ ignore: true, conversations: [{ message: 'Ignored.' }] }))).toEqual([]);
  });

  it('names an item whose decision or comment did not land', () => {
    expect(verifyApplied(p, stored({ conversations: [] }))).toEqual([
      'Property.Appliances.Local Grill: the decision is none, not ignore; the comment is not on the thread'
    ]);
  });
});

describe('the plan as printed', () => {
  const p = plan([
    { resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', action: 'ignore', comment: 'Ignored.' },
    { resourceName: 'Property', fieldName: 'Heating', lookupValue: 'Local Heat', action: 'ignore' },
    { resourceName: 'Property', fieldName: 'InteriorFeatures', lookupValue: 'Local Shower', comment: 'Which shower?' }
  ]);
  it('summarizes by decision', () => {
    expect(summarizeApplyPlan(p)).toBe('3 item(s) to change (2 ignore, 1 no decision), with 2 comment(s).');
  });
  it('lists each item with what it replaces and whether it carries a comment', () => {
    expect(formatApplyItems(p).split('\n')).toEqual([
      '  ignore       Property.Appliances.Local Grill  + comment',
      '  ignore       Property.Heating.Local Heat (was Fast Track)',
      '  no decision  Property.InteriorFeatures.Local Shower  + comment'
    ]);
  });
});

describe('applyVariationDecisionsViaService', () => {
  const COORDINATES = { version: '2.1', providerUoi: PROVIDER, providerUsi: '90001', recipientUoi: 'M00000000' };
  const ROWS = [{ resourceName: 'Property', fieldName: 'Appliances', lookupValue: 'Local Grill', action: 'ignore', comment: 'Ignored.' }];
  const ok = (body: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body)
    }) as unknown as Response;
  const AFTER = {
    changes: STORED.changes.map(c =>
      c.fieldName === 'Appliances' && c.lookupValue === 'Local Grill' ? { ...c, ignore: true, conversations: [{ message: 'Ignored.' }] } : c
    )
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.RESO_SERVICES_URL;
  });

  const stub = (responses: ReadonlyArray<Response>) => {
    const queue = [...responses];
    fetchMock = vi.fn(async () => queue.shift() as Response);
    vi.stubGlobal('fetch', fetchMock);
  };

  it('on a dry run, reads the report and sends nothing', async () => {
    stub([ok(STORED)]);
    const result = await applyVariationDecisionsViaService({
      coordinates: COORDINATES,
      rows: ROWS,
      bearerToken: 'tok',
      dryRun: true,
      now: NOW
    });
    expect(result.sent).toBe(false);
    expect(result.plan.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://services.example.org/v2/certification/variations-reports/2.1/T00000000/90001/M00000000/current'
    );
  });

  it('sends one delta, never a replace, and checks the read-back', async () => {
    stub([ok(STORED), ok({ variationsReportId: 'r' }), ok(AFTER)]);
    const result = await applyVariationDecisionsViaService({ coordinates: COORDINATES, rows: ROWS, bearerToken: 'tok', now: NOW });
    expect(result).toMatchObject({ sent: true, mismatches: [] });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://services.example.org/v2/certification/variations-reports/2.1/T00000000/90001/M00000000');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty('replaceReviewRows');
    expect(body).toMatchObject({ ...COORDINATES, editorInfo: [] });
    expect(body.changes).toEqual(result.plan.items.map(i => i.change));
  });

  it('sends nothing when a row is unusable', async () => {
    stub([ok(STORED)]);
    const result = await applyVariationDecisionsViaService({
      coordinates: COORDINATES,
      rows: [...ROWS, { resourceName: 'Property', fieldName: 'Nope', comment: 'x' }],
      bearerToken: 'tok',
      now: NOW
    });
    expect(result.sent).toBe(false);
    expect(result.plan.errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names who holds the lock when the save is refused', async () => {
    const lock = { displayName: 'A Reviewer', email: 'reviewer@example.org', expiresAt: '2026-11-12T21:00:00Z' };
    stub([ok(STORED), ok({ lock }, 409)]);
    const error = await applyVariationDecisionsViaService({ coordinates: COORDINATES, rows: ROWS, bearerToken: 'tok', now: NOW }).catch(
      e => e
    );
    expect((error as { code?: string }).code).toBe('LOCKED');
    expect(lockHolderOf(error)).toMatchObject(lock);
  });

  it('says so when there is no report under review', async () => {
    stub([ok(null)]);
    await expect(applyVariationDecisionsViaService({ coordinates: COORDINATES, rows: ROWS, bearerToken: 'tok', now: NOW })).rejects.toThrow(
      /there is no report under review/
    );
  });
});
