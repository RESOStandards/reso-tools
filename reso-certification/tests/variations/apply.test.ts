/**
 * `apply-variation-decisions`: a decisions sheet applied to a report already under review, as a merge.
 *
 * The planner is pure and tested whole. The service call is tested against a stubbed fetch for what it sends:
 * the report and the pool read, then one delta save (never `replaceReviewRows`), then both read back and checked.
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
  poolActionsFor,
  verifyApplied,
  verifyPool
} from '../../src/variations/apply.js';
import type { VariationReviewItem } from '../../src/variations/review.js';

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

const plan = (rows: Parameters<typeof planApply>[0]['rows'], stored: StoredReport = STORED, pooled?: ReadonlyMap<string, string | null>) =>
  planApply({ stored, rows, providerUoi: PROVIDER, now: NOW, ...(pooled ? { pooled } : {}) });

const COORDINATES = { version: '2.1', providerUoi: PROVIDER, providerUsi: 'USI-TEST', recipientUoi: 'M00000000' };

/** A pool item for one element, with a submission per recipient given. */
const poolItem = (
  element: { readonly fieldName?: string; readonly lookupValue?: string },
  submissions: ReadonlyArray<{ readonly recipientUoi: string; readonly requestedAction?: string | null; readonly ddVersion?: string }>
): VariationReviewItem => ({
  variationKey: 'k',
  resourceName: 'Property',
  fieldName: element.fieldName ?? null,
  lookupValue: element.lookupValue ?? null,
  status: 'in-review',
  provenance: submissions.map(s => ({
    providerUoi: PROVIDER,
    providerUsi: 'USI-TEST',
    submittedAt: NOW,
    environmentName: 'production',
    ...s
  }))
});

const GRILL = { fieldName: 'Appliances', lookupValue: 'Local Grill' };
const IGNORED_GRILL: StoredReport = {
  changes: [{ resourceName: 'Property', ...GRILL, ignore: true, conversations: [{ from: RESO_COMMENT_AUTHOR, message: 'Ignored.' }] }]
};
const GRILL_ROW = { resourceName: 'Property', ...GRILL, action: 'ignore', comment: 'Ignored.' };

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

  it('sends a row the report already shows when its pool row says otherwise, so a re-run repairs the pool', () => {
    const pooled = poolActionsFor([poolItem(GRILL, [{ recipientUoi: 'M00000000', requestedAction: null }])], COORDINATES);
    const p = plan([GRILL_ROW], IGNORED_GRILL, pooled);
    expect(p.unchanged).toEqual([]);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ element: 'Property.Appliances.Local Grill', action: 'ignore', repairsPool: 'none' });
    expect(p.items[0]).not.toHaveProperty('comment');
    expect(p.items[0]?.change).toMatchObject({ ignore: true, flaggedForFastTrack: false, remove: false });
  });

  it('leaves a row alone when the report and its pool row both already show it', () => {
    const pooled = poolActionsFor([poolItem(GRILL, [{ recipientUoi: 'M00000000', requestedAction: 'ignore' }])], COORDINATES);
    expect(plan([GRILL_ROW], IGNORED_GRILL, pooled).items).toEqual([]);
  });

  it("reads only this report's pool row, not another recipient's or another DD version's", () => {
    const pooled = poolActionsFor(
      [
        poolItem(GRILL, [
          { recipientUoi: 'OTHER-RECIPIENT', requestedAction: null },
          { recipientUoi: 'M00000000', requestedAction: 'ignore' }
        ]),
        poolItem({ fieldName: 'Heating', lookupValue: 'Local Heat' }, [
          { recipientUoi: 'M00000000', requestedAction: null, ddVersion: '2.0' }
        ])
      ],
      COORDINATES
    );
    expect([...pooled]).toEqual([['Property\u001fAppliances\u001fLocal Grill', 'ignore']]);
    expect(plan([GRILL_ROW], IGNORED_GRILL, pooled).items).toEqual([]);
  });

  it('does not send a row for an element that has no pool row', () => {
    expect(plan([GRILL_ROW], IGNORED_GRILL, new Map()).items).toEqual([]);
  });
});

describe('verifyPool', () => {
  const p = plan([GRILL_ROW]);
  const key = 'Property\u001fAppliances\u001fLocal Grill';
  it('is empty when the pool row requests what was sent', () => {
    expect(verifyPool(p, new Map([[key, 'ignore']]))).toEqual([]);
  });
  it('names an item whose pool row did not take the decision, or has none', () => {
    expect(verifyPool(p, new Map([[key, null]]))).toEqual(['Property.Appliances.Local Grill: the pool row requests nothing, not ignore']);
    expect(verifyPool(p, new Map())).toEqual(['Property.Appliances.Local Grill: not in the review pool']);
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
  it('says how many items only repair the pool, and marks them', () => {
    const repair = plan([GRILL_ROW], IGNORED_GRILL, new Map([['Property\u001fAppliances\u001fLocal Grill', null]]));
    expect(summarizeApplyPlan(repair)).toBe(
      '1 item(s) to change (1 ignore), with 0 comment(s); 1 of them to bring the review pool back in line with the report.'
    );
    expect(formatApplyItems(repair)).toBe('  ignore  Property.Appliances.Local Grill  (pool row had none)');
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
  const POOL_BEFORE = { items: [poolItem(GRILL, [{ recipientUoi: 'M00000000', requestedAction: null }])] };
  const POOL_AFTER = { items: [poolItem(GRILL, [{ recipientUoi: 'M00000000', requestedAction: 'ignore' }])] };
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

  it('on a dry run, reads the report and the pool and sends nothing', async () => {
    stub([ok(STORED), ok(POOL_BEFORE)]);
    const result = await applyVariationDecisionsViaService({
      coordinates: COORDINATES,
      rows: ROWS,
      bearerToken: 'tok',
      dryRun: true,
      now: NOW
    });
    expect(result.sent).toBe(false);
    expect(result.plan.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://services.example.org/v2/certification/variations-reports/2.1/T00000000/USI-TEST/M00000000/current'
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://services.example.org/v2/certification/variations-review-items');
  });

  it('sends one delta, never a replace, and checks the read-back of the report and the pool', async () => {
    stub([ok(STORED), ok(POOL_BEFORE), ok({ variationsReportId: 'r' }), ok(AFTER), ok(POOL_AFTER)]);
    const result = await applyVariationDecisionsViaService({ coordinates: COORDINATES, rows: ROWS, bearerToken: 'tok', now: NOW });
    expect(result).toMatchObject({ sent: true, mismatches: [] });
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe('https://services.example.org/v2/certification/variations-reports/2.1/T00000000/USI-TEST/M00000000');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty('replaceReviewRows');
    expect(body).toMatchObject({ ...COORDINATES, editorInfo: [] });
    expect(body.changes).toEqual(result.plan.items.map(i => i.change));
  });

  it('reports a pool row that did not take the decision', async () => {
    stub([ok(STORED), ok(POOL_BEFORE), ok({ variationsReportId: 'r' }), ok(AFTER), ok(POOL_BEFORE)]);
    const result = await applyVariationDecisionsViaService({ coordinates: COORDINATES, rows: ROWS, bearerToken: 'tok', now: NOW });
    expect(result.mismatches).toEqual(['Property.Appliances.Local Grill: the pool row requests nothing, not ignore']);
  });

  it('sends nothing when a row is unusable', async () => {
    stub([ok(STORED), ok(POOL_BEFORE)]);
    const result = await applyVariationDecisionsViaService({
      coordinates: COORDINATES,
      rows: [...ROWS, { resourceName: 'Property', fieldName: 'Nope', comment: 'x' }],
      bearerToken: 'tok',
      now: NOW
    });
    expect(result.sent).toBe(false);
    expect(result.plan.errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names who holds the lock when the save is refused', async () => {
    const lock = { displayName: 'A Reviewer', email: 'reviewer@example.org', expiresAt: '2026-11-12T21:00:00Z' };
    stub([ok(STORED), ok(POOL_BEFORE), ok({ lock }, 409)]);
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
