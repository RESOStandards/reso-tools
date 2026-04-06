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
    expect(v200.length).toBe(45);
  });

  it('v2.1.0 returns all scenarios', () => {
    const v210 = scenariosForVersion('2.1.0');
    expect(v210.length).toBe(allScenarios.length);
    expect(v210.length).toBeGreaterThan(45);
  });

  it('v2.1.0 includes string-enum, string-function, paging, and expand scenarios', () => {
    const v210 = scenariosForVersion('2.1.0');
    const categories = new Set(v210.map(s => s.category));
    expect(categories.has('string-enum')).toBe(true);
    expect(categories.has('string-function')).toBe(true);
    expect(categories.has('paging')).toBe(true);
    expect(categories.has('expand')).toBe(true);
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

  it('has 5 datetime filter scenarios', () => {
    const dtFilters = allScenarios.filter(s => s.category === 'filter' && 'dataType' in s && s.dataType === 'datetime');
    expect(dtFilters.length).toBe(5);
  });
});
