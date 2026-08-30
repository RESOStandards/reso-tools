import { describe, it, expect } from 'vitest';
import { allScenarios, scenariosForVersion } from '../../src/web-api-core/scenarios.js';

describe('scenario definitions', () => {
  it('has at least 51 total scenarios', () => {
    expect(allScenarios.length).toBeGreaterThanOrEqual(51);
  });

  it('all scenarios have unique tags', () => {
    const tags = allScenarios.map(s => s.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('all scenarios have names', () => {
    for (const s of allScenarios) {
      expect(s.name).toBeTruthy();
    }
  });

  it('v2.0.0 returns only 2.0.0 scenarios', () => {
    const v200 = scenariosForVersion('2.0.0');
    expect(v200.every(s => s.minVersion === '2.0.0')).toBe(true);
    expect(v200.length).toBe(48); // 45 + the 3 restored fixed-value datetime ne/lt/le tests (RCP-039 reconciliation)
  });

  it('v2.1.0 returns all scenarios', () => {
    const v210 = scenariosForVersion('2.1.0');
    expect(v210.length).toBe(allScenarios.length);
    expect(v210.length).toBeGreaterThan(45);
  });

  it('v2.1.0 includes string-enum, in-operator, lookup-resource, paging, and expand scenarios', () => {
    const v210 = scenariosForVersion('2.1.0');
    const categories = new Set(v210.map(s => s.category));
    expect(categories.has('string-enum')).toBe(true);
    expect(categories.has('in-operator')).toBe(true);
    expect(categories.has('lookup-resource')).toBe(true);
    expect(categories.has('paging')).toBe(true);
    expect(categories.has('expand')).toBe(true);
  });

  it('v2.1.0 includes string-function scenarios as OPTIONAL (kept per the workgroup, non-failing)', () => {
    const v210 = scenariosForVersion('2.1.0');
    const categories = new Set(v210.map(s => s.category));
    expect(categories.has('string-function')).toBe(true);
    for (const tag of ['filter-string-contains', 'filter-string-startswith', 'filter-string-endswith']) {
      const scenario = v210.find(s => s.tag === tag);
      expect(scenario).toBeDefined();
      expect(scenario?.optional).toBe(true);
    }
  });

  it('lookup-resource-validation scenario sorts before string-enum scenarios', () => {
    const v210 = scenariosForVersion('2.1.0');
    const lookupIdx = v210.findIndex(s => s.tag === 'lookup-resource-validation');
    const stringEnumIdx = v210.findIndex(s => s.category === 'string-enum');
    expect(lookupIdx).toBeGreaterThanOrEqual(0);
    expect(stringEnumIdx).toBeGreaterThanOrEqual(0);
    expect(lookupIdx).toBeLessThan(stringEnumIdx);
  });

  it('covers all expected categories', () => {
    const categories = new Set(allScenarios.map(s => s.category));
    expect(categories).toContain('structural');
    expect(categories).toContain('filter');
    expect(categories).toContain('orderby');
    expect(categories).toContain('enum');
    expect(categories).toContain('collection');
    expect(categories).toContain('error');
  });

  it('has 9 integer filter scenarios', () => {
    const intFilters = allScenarios.filter(s => s.category === 'filter' && 'dataType' in s && s.dataType === 'integer');
    expect(intFilters.length).toBe(9);
  });

  it('has 5 decimal filter scenarios', () => {
    const decFilters = allScenarios.filter(s => s.category === 'filter' && 'dataType' in s && s.dataType === 'decimal');
    expect(decFilters.length).toBe(5);
  });

  it('has 6 date filter scenarios', () => {
    const dateFilters = allScenarios.filter(s => s.category === 'filter' && 'dataType' in s && s.dataType === 'date');
    expect(dateFilters.length).toBe(6);
  });

  it('has 8 datetime filter scenarios', () => {
    // gt, ge, the 3 restored fixed-value ne/lt/le, plus the 3 now() variants (lt/le/ne).
    const dtFilters = allScenarios.filter(s => s.category === 'filter' && 'dataType' in s && s.dataType === 'datetime');
    expect(dtFilters.length).toBe(8);
  });
});
