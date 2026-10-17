import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { describeSchemaErrors } = require(resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js'));

/**
 * The replication loop emits one line per page that fails JSON-schema validation. It used to read only
 * "Schema validation errors found in the <Resource> payload!" — no count, no field, no error class — so a
 * 1,770-page run produced 1,770 identical copies of a sentence that was impossible to ignore and told the
 * operator nothing.
 *
 * The fix is to make that line carry the state, NOT to print it less often. Printing per error class once
 * and then going quiet was the first attempt and it was wrong for a reason worth writing down (Josh,
 * 2026-10-16): **a page with errors that prints nothing reads as a page that passed.** Silence is not a safe
 * default when the subject is a failure. So every page with errors emits a line, and the line carries the
 * running totals and the per-class breakdown.
 *
 * Every number was already in the accumulator at the time; this only reports it. `describeSchemaErrors` is
 * the pure part — no carried state, so it is testable without driving a replication, and there is no
 * per-strategy reset to reason about.
 */

interface SchemaReport {
  readonly line: string | null;
  readonly totals: string | null;
}

/** The accumulator shape the validator actually builds: message → resources → { count, fields }. */
const errorMap = (
  totalErrors: number,
  totalWarnings: number,
  classes: Record<string, Record<string, { count: number; fields: ReadonlyArray<string> }>>
) => ({
  stats: { totalErrors, totalWarnings },
  warningsCache: {},
  payloadErrors: {},
  errorCache: Object.fromEntries(
    Object.entries(classes).map(([message, resources]) => [
      message,
      {
        resources: Object.fromEntries(
          Object.entries(resources).map(([res, { count, fields }]) => [
            res,
            { count, fields: Object.fromEntries(fields.map(f => [f, { lookups: {} }])) }
          ])
        )
      }
    ])
  )
});

/** Like `errorMap`, but each field carries a real per-value count so field ORDER can be asserted. */
const errorMapWithFieldCounts = (
  totalErrors: number,
  resourceName: string,
  message: string,
  fieldCounts: ReadonlyArray<readonly [string, number]>
) => ({
  stats: { totalErrors, totalWarnings: 0 },
  warningsCache: {},
  payloadErrors: {},
  errorCache: {
    [message]: {
      resources: {
        [resourceName]: {
          count: fieldCounts.reduce((s, [, n]) => s + n, 0),
          fields: Object.fromEntries(fieldCounts.map(([f, n]) => [f, { lookups: { v: { count: n } } }]))
        }
      }
    }
  }
});

const ADVERTISED = 'MUST be advertised in the metadata';
const NUMBER_OR_NULL = 'MUST be number or null but found string';
const INTEGER_OR_NULL = 'MUST be integer or null but found string';

const describe_ = (args: Record<string, unknown>): SchemaReport => describeSchemaErrors(args) as SchemaReport;

/** The real census shape from a live run: three classes, the largest by far being the advertised one. */
const census = errorMap(3884, 0, {
  [ADVERTISED]: { Property: { count: 2761, fields: ['City', 'CountyOrParish', 'MlsStatus', 'StreetSuffix'] } },
  [NUMBER_OR_NULL]: { Property: { count: 22, fields: ['CeilingHeight', 'MaximumContiguousSquareFeet'] } },
  [INTEGER_OR_NULL]: { Property: { count: 8, fields: ['YearRenovated'] } }
});

describe('describeSchemaErrors', () => {
  it('says nothing when the page found no errors', () => {
    const out = describe_({ errorMap: errorMap(0, 0, {}), resourceName: 'Property' });
    expect(out.line).toBeNull();
    expect(out.totals).toBeNull();
  });

  it('is safe on an absent or empty accumulator rather than throwing inside the replication loop', () => {
    expect(describe_({ errorMap: undefined, resourceName: 'Property' }).line).toBeNull();
    expect(describe_({ errorMap: {}, resourceName: 'Property' }).line).toBeNull();
    expect(describe_({ errorMap: { stats: {} }, resourceName: 'Property' }).totals).toBeNull();
  });

  describe('every page with errors emits a line', () => {
    // The load-bearing property. A page that found errors and printed nothing would read as a clean page.
    it('emits on the first page and on every page after it, with no suppression', () => {
      const first = describe_({ errorMap: census, resourceName: 'Property' });
      const second = describe_({ errorMap: census, resourceName: 'Property' });
      const tenth = describe_({ errorMap: census, resourceName: 'Property' });
      expect(first.line).not.toBeNull();
      expect(second.line).toBe(first.line);
      expect(tenth.line).toBe(first.line);
    });

    it('ignores carried announce-state, so a caller CANNOT suppress a page', () => {
      // The real guard. The two assertions above pass trivially against a suppressing implementation,
      // because a function-level call with default arguments has no history to suppress against. This one
      // hands it the exact state the old loop threaded and requires the line anyway.
      const withState = describe_({
        errorMap: census,
        resourceName: 'Property',
        announced: [ADVERTISED, NUMBER_OR_NULL, INTEGER_OR_NULL],
        lastTotalsPage: 999,
        pagesFetched: 1000
      });
      const without = describe_({ errorMap: census, resourceName: 'Property' });
      expect(withState.line).not.toBeNull();
      expect(withState.line).toBe(without.line);
    });

    it('takes no carried state, so there is nothing to reset between strategies', () => {
      // The signature is (errorMap, resourceName). An announce-set or a page cadence would make the same
      // accumulator print differently depending on history, which is what produced per-strategy resets.
      expect(describeSchemaErrors.length).toBeLessThanOrEqual(1);
      const a = describe_({ errorMap: census, resourceName: 'Property' });
      const b = describe_({ errorMap: census, resourceName: 'Property' });
      expect(a).toEqual(b);
    });
  });

  describe('the line carries the totals and the breakdown', () => {
    const { line } = describe_({ errorMap: census, resourceName: 'Property' });

    it('leads with THIS resource’s own count, and reconciles with its own breakdown', () => {
      // The defect this replaces, measured on a live run: the lead number was `stats.totalErrors`, which is
      // cumulative across EVERY resource, while the breakdown is filtered to this one. So the line printed
      // "Schema validation (Member): 42,793 errors ... 3,996 on 1 field" - a lead that cannot be reconciled
      // from the line itself, and on a resource with none of its own it printed a five-figure count with no
      // breakdown at all, which reads as catastrophe on a clean resource.
      expect(line).toContain('Schema validation (Property):');
      expect(line).toContain('2,791 errors'); // 2,761 + 22 + 8 - this resource only
      expect(line).toContain('3 types here');
      expect(line).toContain('(3,884 run total)'); // the cumulative figure, labeled as cumulative
    });

    it('names every error class with its own count and fields', () => {
      expect(line).toContain(`${ADVERTISED} 2,761 on 4 fields (City, CountyOrParish, MlsStatus, StreetSuffix)`);
      expect(line).toContain(`${NUMBER_OR_NULL} 22 on 2 fields (CeilingHeight, MaximumContiguousSquareFeet)`);
      expect(line).toContain(`${INTEGER_OR_NULL} 8 on 1 field (YearRenovated)`);
    });

    it('orders the classes largest first, so the dominant problem reads first', () => {
      const at = (m: string) => (line ?? '').indexOf(m);
      expect(at(ADVERTISED)).toBeLessThan(at(NUMBER_OR_NULL));
      expect(at(NUMBER_OR_NULL)).toBeLessThan(at(INTEGER_OR_NULL));
    });

    it('stays on ONE line, so a long run is still greppable and diffable', () => {
      expect(line).not.toContain('\n');
    });
  });

  it('exposes the totals separately, for the strict-mode throw message', () => {
    expect(describe_({ errorMap: census, resourceName: 'Property' }).totals).toBe('3,884 errors, 0 warnings, 3 distinct types');
  });

  describe('a resource with none of its own errors', () => {
    // errorCache is keyed by MESSAGE across every resource, so one message can carry several. Naming a
    // Member finding on a Property page would send an operator to the wrong resource.
    const out = describe_({
      errorMap: errorMap(5, 0, { [ADVERTISED]: { Member: { count: 5, fields: ['MemberFlags'] } } }),
      resourceName: 'Property'
    });

    it('does not borrow the other resource’s count or field names', () => {
      expect(out.line).not.toContain('MemberFlags');
      expect(out.line).not.toContain('5 errors,');
    });

    it('still prints a line, because silence is ambiguous once a run has errors somewhere', () => {
      // "validated and clean" must not look identical to "never validated". The run total is still shown,
      // so the line accounts for the resource without claiming another resource’s errors as its own.
      expect(out.line).toBe('Schema validation (Property): 0 errors, 0 types here (5 run total)');
    });

    it('keeps the run-wide totals string intact for the strict-mode throw', () => {
      expect(out.totals).toBe('5 errors, 0 warnings, 1 distinct type');
    });
  });

  it('prints nothing at all when the run has no errors anywhere, so silence means nothing is wrong', () => {
    expect(describe_({ errorMap: errorMap(0, 0, {}), resourceName: 'Property' }).line).toBeNull();
  });

  describe('the capped field list shows the LARGEST fields, not the first recorded', () => {
    // Measured on a live run: the cap hid by insertion order, and the hidden field was the biggest one.
    // `Rooms` at 12,351 was collapsed into "+1 more" while `Heating` at 104 took a visible slot - and
    // `Rooms` was both the largest contributor and the field under investigation. A cap that reliably hides
    // the dominant field is worse than no cap.
    const grid = errorMapWithFieldCounts(43563, 'Property', ADVERTISED, [
      ['City', 8000],
      ['CountyOrParish', 7999],
      ['MlsStatus', 7998],
      ['StreetSuffix', 7108],
      ['Heating', 104],
      ['Rooms', 12351]
    ]);

    it('puts the largest field first even when it was recorded last', () => {
      const { line } = describe_({ errorMap: grid, resourceName: 'Property' });
      expect(line).toContain('on 6 fields (Rooms, City, CountyOrParish, MlsStatus, StreetSuffix, +1 more)');
    });

    it('hides the SMALLEST field rather than whichever happened to be recorded sixth', () => {
      const { line } = describe_({ errorMap: grid, resourceName: 'Property' });
      expect(line).not.toContain('Heating');
    });

    it('sorts the TYPE classes too, whose fields carry a direct count and no lookups', () => {
      // The two field shapes the validator actually produces, confirmed against a live report:
      //   enum class -> field = { lookups: { value: { count } } }   (no field-level count)
      //   type class -> field = { count }                           (no lookups at all)
      // Reading only `lookups` scored every type-class field at zero, so they fell back to recorded order.
      // The earlier version of this test used `{ lookups: {} }` with no count, a shape that does not occur
      // in real data, and so asserted that the gap was intended behavior.
      const typeClass = {
        stats: { totalErrors: 100, totalWarnings: 0 },
        warningsCache: {},
        payloadErrors: {},
        errorCache: {
          [NUMBER_OR_NULL]: {
            resources: {
              Property: {
                count: 100,
                // Recorded smallest-first, so insertion order and count order disagree.
                fields: { MaximumContiguousSquareFeet: { count: 44 }, CeilingHeight: { count: 56 } }
              }
            }
          }
        }
      };
      const { line } = describe_({ errorMap: typeClass, resourceName: 'Property' });
      expect(line).toContain('(CeilingHeight, MaximumContiguousSquareFeet)');
    });

    it('still preserves recorded order when a field genuinely carries no count at all', () => {
      const noCounts = errorMap(9, 0, { [ADVERTISED]: { Property: { count: 9, fields: ['Zeta', 'Alpha', 'Mid'] } } });
      const { line } = describe_({ errorMap: noCounts, resourceName: 'Property' });
      expect(line).toContain('(Zeta, Alpha, Mid)');
    });
  });

  it('caps the field list so one class stays readable', () => {
    const fields = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'];
    const out = describe_({
      errorMap: errorMap(99, 0, { [ADVERTISED]: { Property: { count: 99, fields } } }),
      resourceName: 'Property'
    });
    expect(out.line).toContain('on 7 fields (F1, F2, F3, F4, F5, +2 more)');
    expect(out.line).not.toContain('F6');
  });

  it('omits the field clause when the accumulator recorded no field for the class', () => {
    const out = describe_({
      errorMap: errorMap(4, 0, { 'payload is not an object': { Property: { count: 4, fields: [] } } }),
      resourceName: 'Property'
    });
    expect(out.line).toContain('payload is not an object 4');
    expect(out.line).not.toContain(' on 0 ');
  });

  it('uses the singular where a count is one', () => {
    const out = describe_({
      errorMap: errorMap(1, 1, { [ADVERTISED]: { Property: { count: 1, fields: ['OneField'] } } }),
      resourceName: 'Property'
    });
    expect(out.totals).toBe('1 error, 1 warning, 1 distinct type');
    expect(out.line).toContain('on 1 field (OneField)');
  });

  it('thousands-separates every count, since these reach six figures on a real run', () => {
    const out = describe_({
      errorMap: errorMap(2255486, 0, { [ADVERTISED]: { Property: { count: 616688, fields: ['Rooms'] } } }),
      resourceName: 'Property'
    });
    expect(out.line).toContain('616,688 errors'); // this resource's own, the lead
    expect(out.line).toContain('(2,255,486 run total)'); // cumulative, labeled
    expect(out.line).toContain(`${ADVERTISED} 616,688`); // and the breakdown reconciles with the lead
  });
});
