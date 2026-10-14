/**
 * Marking a variations report the way the review UI marks it.
 *
 * The flow, in Josh's words (2026-10-04): "we got a variations report, we're submitting it for
 * review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin." And the constraint that fixes the
 * shape: "client passes the variations report and comments and the backend should do everything from
 * there", which "should make the same output as if a user is on the UI".
 *
 * So there is ONE request and marking is a FIELD ON THE CHANGE, not a second call. The service
 * declares `ignore`, `flaggedForFastTrack` and `conversations` on a change and derives the pool
 * row's `requestedAction` from the flags. What this file pins is that the right field lands on the
 * right entry, and that a sheet which cannot be applied cleanly is not applied at all.
 *
 * THE FIXTURE IS THE REAL SHAPE. It comes from an actual DD 2.1 run and carries the five level
 * buckets a run writes, not the flat `changes` array the service stores. An earlier version of this
 * module read `.changes` off the on-disk artifact, found undefined, and told the operator their
 * report "may be the wrong artifact" -- a false accusation that every fixture in this suite agreed
 * with, because every fixture used the service's shape.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VARIATION_LEVEL_KEYS } from '../../src/variations/constants.js';
import { SHEET_ACTIONS, applySheetToReport, countEntries } from '../../src/variations/decisions.js';
import type { DecisionReport } from '../../src/variations/decisions.js';

const NOW = '2026-10-05T04:30:00.000Z';

const report = (): DecisionReport =>
  JSON.parse(readFileSync(new URL('../fixtures/variations-report-level-buckets.json', import.meta.url), 'utf-8')) as DecisionReport;

const apply = (rows: ReadonlyArray<Record<string, unknown>>, r: DecisionReport = report()) => applySheetToReport(r, rows as never, NOW);

/** The entry a row landed on, found by its identity rather than by index. */
const lookupAt = (r: DecisionReport, value: string) => (r.lookups ?? []).find(e => e.lookupValue === value);

describe('the report is level-bucketed, as a run writes it', () => {
  it('counts entries across every bucket, not off a changes array', () => {
    // 3 lookups + 1 field + 1 expansion. There is no `changes` key on this artifact at all.
    expect(countEntries(report())).toBe(5);
    expect((report() as Record<string, unknown>).changes).toBeUndefined();
  });

  it('declares the five buckets a run writes, bound to reso-common’s own set', () => {
    // A bucket reso-common adds and this list omits is a compile error, not a silent skip of a
    // whole level of variations. The `satisfies` and the exhaustiveness check in constants.ts carry
    // that; this pins the order, which fixes entry ordering.
    expect(VARIATION_LEVEL_KEYS).toEqual(['resources', 'fields', 'lookups', 'expansions', 'complexTypes']);
  });

  it('addresses a lookup entry carried in the legacy wire form', () => {
    // LookupEntry declares lookupValue AND legacyODataValue, both optional, so an entry can be
    // named by either. Matching only the first would make a legacy-form variation permanently
    // unaddressable: the operator types what the report showed and is told it is not in the report.
    const base = report();
    const legacy: DecisionReport = {
      ...base,
      lookups: [{ level: 'lookup', resourceName: 'Property', fieldName: 'Roof', legacyODataValue: 'StandingSeamSteel', suggestions: [] }]
    };
    const out = applySheetToReport(
      legacy,
      [{ resourceName: 'Property', fieldName: 'Roof', lookupValue: 'StandingSeamSteel', action: 'ignore' }],
      NOW
    );
    expect(out.errors).toEqual([]);
    expect(out.report.lookups?.[0].ignore).toBe(true);
    expect(out.applied[0].element).toBe('Property.Roof.StandingSeamSteel');
  });

  it('tolerates a report missing a bucket entirely', () => {
    const { complexTypes, resources, ...partial } = report();
    expect(countEntries(partial as DecisionReport)).toBe(5);
  });
});

describe('an action becomes a flag on the entry it names', () => {
  it('writes flaggedForFastTrack for submit-to-ft, which the service reads as fast-track', () => {
    // provider.ts: `flaggedForFastTrack === true ? 'fast-track'`. The sheet word and the wire field
    // differ, so this is the join that has to be right.
    const out = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }]);
    expect(out.errors).toEqual([]);
    expect(lookupAt(out.report, 'Months - 4')?.flaggedForFastTrack).toBe(true);
  });

  it('writes ignore for ignore, and remove for remove', () => {
    const ignored = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 3', action: 'ignore' }]);
    expect(lookupAt(ignored.report, 'Months - 3')?.ignore).toBe(true);
    const removed = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 3', action: 'remove' }]);
    expect(lookupAt(removed.report, 'Months - 3')?.remove).toBe(true);
  });

  it('marks only the entry named, leaving its siblings alone', () => {
    // Both LeaseTerm values are in the report and only one is being flagged.
    const out = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }]);
    expect(lookupAt(out.report, 'Months - 3')?.flaggedForFastTrack).toBeUndefined();
    expect(lookupAt(out.report, 'Hardboard Siding')?.flaggedForFastTrack).toBeUndefined();
  });

  it('marks an entry in the fields bucket, addressed with no lookup value', () => {
    const out = apply([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }]);
    expect(out.errors).toEqual([]);
    expect(out.report.fields?.[0].ignore).toBe(true);
    expect(out.applied[0].bucket).toBe('fields');
  });

  it('marks an entry in the expansions bucket', () => {
    const out = apply([{ resourceName: 'Property', fieldName: 'RIAR_Description', action: 'ignore' }]);
    expect(out.report.expansions?.[0].ignore).toBe(true);
    expect(out.applied[0].bucket).toBe('expansions');
  });

  it('preserves everything else on the entry it marks', () => {
    const before = lookupAt(report(), 'Months - 4');
    const out = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }]);
    const after = lookupAt(out.report, 'Months - 4');
    expect(after?.suggestions).toEqual(before?.suggestions);
    expect(after?.enforcement).toBe(before?.enforcement);
    expect(after?.level).toBe('lookup');
  });

  it('does not mutate the report it was given', () => {
    const before = report();
    const snapshot = JSON.stringify(before);
    applySheetToReport(before, [{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'ignore' }], NOW);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('a comment names who may read it', () => {
  it('appends the comment with the report’s organization as its audience', () => {
    // Josh: "it's from Admin targeted at providerUoi", "anyone who has an account at providerUoi
    // sees it". No `from`: that is filled from the auth context, which a client cannot read.
    const out = apply([
      { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', comment: 'DD has no 4-month term.' }
    ]);
    expect(lookupAt(out.report, 'Months - 4')?.conversations).toEqual([
      { timestamp: NOW, to: 'T00000045', message: 'DD has no 4-month term.' }
    ]);
  });

  it('carries an action and a comment on the same row', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'LeaseTerm',
        lookupValue: 'Months - 4',
        action: 'submit-to-ft',
        comment: 'Is the enumeration sufficient?'
      }
    ]);
    const entry = lookupAt(out.report, 'Months - 4');
    expect(entry?.flaggedForFastTrack).toBe(true);
    expect(entry?.conversations).toHaveLength(1);
    expect(out.applied[0]).toEqual({
      bucket: 'lookups',
      element: 'Property.LeaseTerm.Months - 4',
      action: 'submit-to-ft',
      commented: true
    });
  });

  it('appends to an existing thread rather than replacing it', () => {
    const base = report();
    const withThread: DecisionReport = {
      ...base,
      lookups: (base.lookups ?? []).map(e =>
        e.lookupValue === 'Months - 4'
          ? { ...e, conversations: [{ timestamp: '2026-10-01T00:00:00.000Z', to: 'RESO', message: 'earlier' }] }
          : e
      )
    };
    const out = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', comment: 'later' }], withThread);
    const thread = lookupAt(out.report, 'Months - 4')?.conversations ?? [];
    expect(thread.map(c => c.message)).toEqual(['earlier', 'later']);
  });

  it('refuses every comment when the report names no organization to address them to', () => {
    // `to` decides who sees it. An absent one is not "addressed to nobody", it is a readership
    // nothing defines, so nothing is written.
    const { providerUoi, ...withoutProvider } = report();
    const out = apply([{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'a note' }], withoutProvider as DecisionReport);
    expect(out.applied).toEqual([]);
    expect(out.errors[0]).toMatch(/no organization to address/i);
  });

  it('still applies an action when the report names no organization, since no comment needs one', () => {
    const { providerUoi, ...withoutProvider } = report();
    const out = apply([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }], withoutProvider as DecisionReport);
    expect(out.errors).toEqual([]);
    expect(out.report.fields?.[0].ignore).toBe(true);
  });

  it('takes the timestamp as an argument so the output is deterministic', () => {
    const rows = [{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'x' }];
    expect(JSON.stringify(apply(rows).report)).toBe(JSON.stringify(apply(rows).report));
  });
});

describe('a sheet that cannot be applied cleanly is not applied at all', () => {
  it('refuses a row matching no entry', () => {
    const out = apply([{ resourceName: 'Property', fieldName: 'NotInTheReport', action: 'ignore' }]);
    expect(out.applied).toEqual([]);
    expect(out.errors[0]).toMatch(/matches no entry/i);
  });

  it('refuses an under-specified row and names what it matched', () => {
    // Both LeaseTerm values match a row naming only the field. Ambiguity stops rather than picks.
    const out = apply([{ resourceName: 'Property', fieldName: 'LeaseTerm', action: 'ignore' }]);
    expect(out.errors[0]).toMatch(/matches 2 entries/i);
    expect(out.errors[0]).toContain('Months - 3');
    expect(out.errors[0]).toContain('Months - 4');
  });

  it('hands the report back untouched when any row is bad', () => {
    const before = report();
    const out = applySheetToReport(
      before,
      [
        { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' },
        { resourceName: 'Property', fieldName: 'Nowhere', action: 'ignore' }
      ],
      NOW
    );
    expect(out.report).toBe(before);
    expect(out.applied).toEqual([]);
  });

  it('reports every bad row rather than stopping at the first', () => {
    const out = apply([
      { resourceName: 'Property', fieldName: 'NotThere', action: 'ignore' },
      { resourceName: 'Property', fieldName: 'AlsoNotThere', action: 'ignore' }
    ]);
    expect(out.errors).toHaveLength(2);
  });

  it('refuses a terminal action and says where it belongs instead', () => {
    // `accept` and `ft-mapped` resolve an item into the canonical store for every organization
    // holding it. Pushing a report cannot do that, and the message says so rather than just listing
    // the allowed words.
    for (const action of ['accept', 'ft-mapped']) {
      const out = apply([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action }]);
      expect(out.errors[0]).toMatch(/canonical store is a separate operation/i);
    }
  });

  it('refuses two rows asking for different actions on one entry', () => {
    const out = apply([
      { resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' },
      { resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'remove' }
    ]);
    expect(out.errors[0]).toMatch(/two rows ask for different actions/i);
  });

  it('allows a comment-only row, and a row that asks for nothing is skipped', () => {
    const out = apply([
      { resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'just a note' },
      { resourceName: 'Property', fieldName: 'RIAR_Description' }
    ]);
    expect(out.errors).toEqual([]);
    expect(out.applied).toHaveLength(1);
  });

  it('offers exactly the three actions the report save understands', () => {
    expect(SHEET_ACTIONS).toEqual(['ignore', 'remove', 'submit-to-ft']);
  });
});

describe('a row carries the suggestion it targets', () => {
  it('puts the coordinates flat on the change, where the service reads them', () => {
    // The service builds the pool row's `mapping` from exactly these fields and derives nothing from
    // the `suggestions` array beside them. A change without them lands a row reading "No suggestion",
    // which is how two September rows ended up bare.
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'LeaseTerm',
        lookupValue: 'Months - 4',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'LeaseTerm',
        suggestedLookupValue: '3 Months',
        action: 'submit-to-ft'
      }
    ]);
    expect(out.errors).toEqual([]);
    const entry = lookupAt(out.report, 'Months - 4');
    expect(entry?.suggestedResourceName).toBe('Property');
    expect(entry?.suggestedFieldName).toBe('LeaseTerm');
    expect(entry?.suggestedLookupValue).toBe('3 Months');
    expect(entry?.flaggedForFastTrack).toBe(true);
    // The offered set survives beside the chosen one: mapping is what was picked, suggestions what was offered.
    expect((entry?.suggestions as unknown[]).length).toBeGreaterThan(0);
  });

  it('reports the targeted suggestion on the applied row', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'SoilType',
        action: 'ignore'
      }
    ]);
    expect(out.applied[0].mapping).toEqual({ suggestedResourceName: 'Property', suggestedFieldName: 'SoilType' });
  });

  it('allows a row that names only a mapping, with no action and no comment', () => {
    const out = apply([
      { resourceName: 'Property', fieldName: 'OKC_SoilType', suggestedResourceName: 'Property', suggestedFieldName: 'SoilType' }
    ]);
    expect(out.errors).toEqual([]);
    expect(out.report.fields?.[0].suggestedFieldName).toBe('SoilType');
  });
});

describe('a suggestion must be named at the same depth as its target', () => {
  it('refuses a lookup-level target with only a suggested lookup value', () => {
    // The shape of the Realtracs ignore sheet: it named `9 Months` and neither the resource nor the
    // field, so the row did not say what it wanted done at the level it was asking about.
    const out = apply([
      { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 3', suggestedLookupValue: '9 Months', action: 'ignore' }
    ]);
    expect(out.errors[0]).toMatch(/does not name Suggested Resource Name \+ Suggested Field Name/);
    expect(out.errors[0]).toMatch(/same depth/);
  });

  it('refuses a field-level target with a lookup-level suggestion', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'SoilType',
        suggestedLookupValue: 'Clay',
        action: 'ignore'
      }
    ]);
    expect(out.errors[0]).toMatch(/goes deeper than the target/);
  });

  it('accepts a matching field-level pair', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'SoilType',
        action: 'ignore'
      }
    ]);
    expect(out.errors).toEqual([]);
  });

  it('accepts a row naming no suggestion at all', () => {
    // Still allowed: an action or a comment on an element, with nothing claimed about a target.
    const out = apply([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }]);
    expect(out.errors).toEqual([]);
  });

  it('treats the legacy OData form as the same depth as a lookup value', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'LeaseTerm',
        lookupValue: 'Months - 4',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'LeaseTerm',
        suggestedLegacyODataValue: 'ThreeMonths',
        action: 'ignore'
      }
    ]);
    expect(out.errors).toEqual([]);
  });
});

describe('two rows cannot target different suggestions on one element', () => {
  it('refuses rather than picking one', () => {
    const out = apply([
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'SoilType',
        action: 'ignore'
      },
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'SoilClass',
        comment: 'or this one'
      }
    ]);
    expect(out.errors[0]).toMatch(/different suggestions on the same element/);
  });
});
