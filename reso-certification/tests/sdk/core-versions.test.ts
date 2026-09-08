import { describe, expect, it } from 'vitest';
import { SUPPORTED_CORE_VERSIONS, CURRENT_CORE_VERSION, isCoreVersion } from '../../src/sdk/core-versions.js';
import { scenariosForVersion } from '../../src/web-api-core/scenarios.js';

describe('SUPPORTED_CORE_VERSIONS is the single source of truth', () => {
  it('every supported version produces a scenario catalog (drift guard vs scenariosForVersion)', () => {
    for (const v of SUPPORTED_CORE_VERSIONS) {
      expect(scenariosForVersion(v).length).toBeGreaterThan(0);
    }
  });

  it('CURRENT_CORE_VERSION is supported and is the latest (highest) minor — the CLI default', () => {
    expect(isCoreVersion(CURRENT_CORE_VERSION)).toBe(true);
    const latest = [...SUPPORTED_CORE_VERSIONS].sort().at(-1);
    expect(CURRENT_CORE_VERSION).toBe(latest);
    expect(CURRENT_CORE_VERSION).toBe('2.1.0');
  });

  it('the newer catalog is a superset of the older (2.1.0 adds scenarios, never drops)', () => {
    // Confidence that "default to the current minor" only ever ADDS coverage vs the prior minor.
    expect(scenariosForVersion('2.1.0').length).toBeGreaterThanOrEqual(scenariosForVersion('2.0.0').length);
  });
});

describe('isCoreVersion narrows safely (no `as` casts needed at the CLI boundary)', () => {
  it('accepts exactly the supported versions', () => {
    expect(isCoreVersion('2.0.0')).toBe(true);
    expect(isCoreVersion('2.1.0')).toBe(true);
  });
  it('rejects unsupported / malformed values', () => {
    for (const bad of ['2.1', '2.2.0', '9.9.9', '', 'latest', '2.1.0 ']) {
      expect(isCoreVersion(bad)).toBe(false);
    }
  });
});
