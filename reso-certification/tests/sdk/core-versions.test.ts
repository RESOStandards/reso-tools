import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_CORE_VERSIONS,
  CURRENT_CORE_VERSION,
  isCoreVersion,
  coerceCoreVersion,
  coreVersionGte,
  isCore21OrLater,
} from '../../src/sdk/core-versions.js';
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

describe('coerceCoreVersion normalizes any config-supplied shape to a canonical CoreVersion', () => {
  it('maps the two-part DD shape to the three-part Core literal (the config-mode bug)', () => {
    // Config sources hand the Core version over as "2.1"; the gates compare against the literal "2.1.0".
    // A bare `as` cast let "2.1" through and silently disabled every 2.1.0-gated branch. This is the fix.
    expect(coerceCoreVersion('2.1')).toBe('2.1.0');
    expect(coerceCoreVersion('2.0')).toBe('2.0.0');
  });

  it('is idempotent on already-canonical input', () => {
    expect(coerceCoreVersion('2.1.0')).toBe('2.1.0');
    expect(coerceCoreVersion('2.0.0')).toBe('2.0.0');
  });

  it('falls back to CURRENT_CORE_VERSION (the current minor) for absent / unrecognizable input', () => {
    // An unrecognized-because-newer version certifies under the strictest known profile, never the oldest
    // baseline (that would be a false-PASS skipping every 2.1.0 gate). "9.9" (above the supported set) and
    // garbage both clamp UP to the current minor rather than down to 2.0.0.
    expect(coerceCoreVersion(undefined)).toBe(CURRENT_CORE_VERSION);
    expect(coerceCoreVersion('')).toBe(CURRENT_CORE_VERSION);
    expect(coerceCoreVersion('banana')).toBe(CURRENT_CORE_VERSION);
    expect(coerceCoreVersion('9.9')).toBe(CURRENT_CORE_VERSION);
    expect(CURRENT_CORE_VERSION).toBe('2.1.0');
  });

  it('ALWAYS produces a value that passes isCoreVersion (the cast can no longer lie)', () => {
    for (const input of ['2.1', '2.0', '2.1.0', '2.0.0', '2.1.5', '', 'garbage', undefined]) {
      expect(isCoreVersion(coerceCoreVersion(input))).toBe(true);
    }
  });
});

describe('coreVersionGte compares numerically and tolerates two- or three-part shapes', () => {
  it('treats "2.1" and "2.1.0" as equal (shape-tolerant)', () => {
    expect(coreVersionGte('2.1', '2.1.0')).toBe(true);
    expect(coreVersionGte('2.1.0', '2.1')).toBe(true);
  });
  it('orders versions numerically, not lexically', () => {
    expect(coreVersionGte('2.1.0', '2.0.0')).toBe(true);
    expect(coreVersionGte('2.0.0', '2.1.0')).toBe(false);
    expect(coreVersionGte('2.2.0', '2.1.0')).toBe(true); // future line clears the 2.1.0 bar
    expect(coreVersionGte('2.10.0', '2.9.0')).toBe(true); // numeric, not string ("2.10" > "2.9")
  });
});

describe('isCore21OrLater is the single 2.1.0 boundary predicate', () => {
  it('is true for 2.1.0 and later — INCLUDING the two-part "2.1" a config supplies', () => {
    // The regression that would have caught the bug: a "2.1" config must ENABLE the 2.1.0 gates
    // (the $expand validator among them), not disable them.
    expect(isCore21OrLater(coerceCoreVersion('2.1'))).toBe(true);
    expect(isCore21OrLater('2.1')).toBe(true);
    expect(isCore21OrLater('2.1.0')).toBe(true);
    expect(isCore21OrLater('2.2.0')).toBe(true);
  });
  it('is false for the 2.0.0 baseline (both shapes)', () => {
    expect(isCore21OrLater('2.0.0')).toBe(false);
    expect(isCore21OrLater('2.0')).toBe(false);
  });
});
