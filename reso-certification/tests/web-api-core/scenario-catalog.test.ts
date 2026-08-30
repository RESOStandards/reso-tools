import { describe, expect, it } from 'vitest';
import { allScenarios } from '../../src/web-api-core/scenarios.js';
import { describeScenario, generateScenarioCatalog, scenarioAnchor } from '../../src/web-api-core/scenario-catalog.js';

/**
 * Locks the Scenario Catalog against the runner's scenario set. This is the anti-drift guard:
 * the published spec's §3.5 `[Source]` links point at `scenario-<tag>` anchors, so every scenario
 * MUST appear in the catalog with its anchor, and the output must be stable. Add a scenario to
 * scenarios.ts and this fails until the catalog regenerates to include it.
 */
describe('Scenario Catalog generator', () => {
  const catalog = generateScenarioCatalog();

  it('emits a stable anchor + a `<tag>` entry for every scenario (no scenario left uncatalogued)', () => {
    for (const s of allScenarios) {
      expect(catalog).toContain(`id="${scenarioAnchor(s.tag)}"`);
      expect(catalog).toContain(`**\`${s.tag}\`**`);
    }
  });

  it('anchors are unique (a §3.5 link resolves to exactly one catalog row)', () => {
    const anchors = allScenarios.map(s => scenarioAnchor(s.tag));
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('describes every scenario — no blank "what it checks" (catches an un-described new category)', () => {
    for (const s of allScenarios) {
      expect(describeScenario(s).trim().length).toBeGreaterThan(0);
    }
  });

  it('is deterministic (safe to regenerate and diff against the spec)', () => {
    expect(generateScenarioCatalog()).toBe(catalog);
  });
});
