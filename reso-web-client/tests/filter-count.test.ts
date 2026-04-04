import { describe, it, expect } from 'vitest';
import { parseFilter, type FilterExpression } from '@reso-standards/odata-expression-parser';

/** Count top-level filter conditions from a parsed AST. */
const countConditions = (expr: FilterExpression): number => {
  if (expr.type === 'logical' && expr.operator === 'and') {
    return countConditions(expr.left) + countConditions(expr.right);
  }
  return 1;
};

/** Try to count filter conditions from a filter string. Returns 0 on parse error. */
const getFilterCount = (filterString: string): number => {
  if (!filterString.trim()) return 0;
  try {
    return countConditions(parseFilter(filterString));
  } catch {
    return 0;
  }
};

describe('getFilterCount', () => {
  it('returns 0 for empty string', () => {
    expect(getFilterCount('')).toBe(0);
    expect(getFilterCount('   ')).toBe(0);
  });

  it('counts a single condition', () => {
    expect(getFilterCount("City eq 'Denver'")).toBe(1);
  });

  it('counts two AND conditions', () => {
    expect(getFilterCount("City eq 'Denver' and ListPrice gt 200000")).toBe(2);
  });

  it('counts three AND conditions', () => {
    expect(getFilterCount("City eq 'Denver' and ListPrice gt 200000 and BedroomsTotal ge 3")).toBe(3);
  });

  it('counts an OR group as one condition', () => {
    expect(getFilterCount("City eq 'Denver' or City eq 'Boulder'")).toBe(1);
  });

  it('counts AND with nested OR as two conditions', () => {
    expect(getFilterCount("(City eq 'Denver' or City eq 'Boulder') and ListPrice gt 200000")).toBe(2);
  });

  it('counts contains function as one condition', () => {
    expect(getFilterCount("contains(City,'Den')")).toBe(1);
  });

  it('counts mixed function and comparison', () => {
    expect(getFilterCount("contains(City,'Den') and ListPrice gt 200000")).toBe(2);
  });

  it('counts not expression as one condition', () => {
    expect(getFilterCount("not contains(City,'Den')")).toBe(1);
  });

  it('returns 0 for invalid filter expression', () => {
    expect(getFilterCount('this is not valid odata')).toBe(0);
  });

  it('returns 0 for partial expression', () => {
    expect(getFilterCount("City eq")).toBe(0);
  });

  it('counts collection lambda as one condition', () => {
    expect(getFilterCount("DevelopmentStatus/any(x:x eq 'Proposed')")).toBe(1);
  });

  it('counts collection lambda with AND', () => {
    expect(getFilterCount("DevelopmentStatus/any(x:x eq 'Proposed') and ListPrice gt 100000")).toBe(2);
  });

  it('counts ge comparison for dates', () => {
    expect(getFilterCount("ModificationTimestamp ge 2026-01-01T00:00:00Z")).toBe(1);
  });

  it('counts date with AND', () => {
    expect(getFilterCount("ModificationTimestamp ge 2026-01-01T00:00:00Z and StandardStatus eq 'Active'")).toBe(2);
  });

  // Complex real-world filters
  it('counts deeply nested ANDs (4 conditions)', () => {
    expect(getFilterCount(
      "City eq 'Denver' and ListPrice gt 200000 and BedroomsTotal ge 3 and StandardStatus eq 'Active'"
    )).toBe(4);
  });

  it('counts mixed AND/OR with parentheses as 3 conditions', () => {
    expect(getFilterCount(
      "(City eq 'Denver' or City eq 'Boulder') and ListPrice gt 200000 and StandardStatus eq 'Active'"
    )).toBe(3);
  });

  it('counts multiple collection lambdas with AND', () => {
    expect(getFilterCount(
      "PoolFeatures/any(x:x eq 'Heated') and Fencing/any(x:x eq 'Back Yard') and ListPrice gt 100000"
    )).toBe(3);
  });

  it('counts in operator as one condition', () => {
    expect(getFilterCount("StandardStatus in ('Active','Pending')")).toBe(1);
  });

  it('counts in operator with AND', () => {
    expect(getFilterCount("StandardStatus in ('Active','Pending') and City eq 'Denver'")).toBe(2);
  });

  it('counts parenthesized single condition as one', () => {
    expect(getFilterCount("(City eq 'Denver')")).toBe(1);
  });

  it('counts price range (ge and le on same field) as two conditions', () => {
    expect(getFilterCount("ListPrice ge 100000 and ListPrice le 500000")).toBe(2);
  });

  // Bad filters — should all return 0
  it('returns 0 for unclosed string literal', () => {
    expect(getFilterCount("City eq 'Denver")).toBe(0);
  });

  it('returns 0 for missing operator', () => {
    expect(getFilterCount("City 'Denver'")).toBe(0);
  });

  it('returns 0 for trailing and', () => {
    expect(getFilterCount("City eq 'Denver' and")).toBe(0);
  });

  it('returns 0 for double operator', () => {
    expect(getFilterCount("City eq eq 'Denver'")).toBe(0);
  });

  it('returns 0 for unmatched parentheses', () => {
    expect(getFilterCount("(City eq 'Denver'")).toBe(0);
  });
});
