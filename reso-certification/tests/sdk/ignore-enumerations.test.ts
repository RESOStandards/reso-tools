import { describe, expect, it } from 'vitest';
import { isEnumerationIgnored, loadValidationConfig } from '../../src/sdk/expand-schema.js';

// A minimal stand-in mirroring schema-validation-settings.json's shape: version → resource → field → flag.
const config = {
  '2.0': { Property: { MLSAreaMinor: { ignoreEnumerations: true } } },
  '2.1': {
    Property: { MLSAreaMinor: { ignoreEnumerations: true } },
    Media: { ImageSizeDescription: { ignoreEnumerations: true } },
  },
};

describe('isEnumerationIgnored', () => {
  it('normalizes the 3-part endorsement version to DD major.minor before the lookup', () => {
    expect(isEnumerationIgnored(config, '2.1.0', 'Property', 'MLSAreaMinor')).toBe(true);
    expect(isEnumerationIgnored(config, '2.0.0', 'Property', 'MLSAreaMinor')).toBe(true);
    expect(isEnumerationIgnored(config, '2.1.0', 'Media', 'ImageSizeDescription')).toBe(true);
  });

  it('is false for a field / resource / version not on the list', () => {
    expect(isEnumerationIgnored(config, '2.1.0', 'Property', 'StandardStatus')).toBe(false); // field not listed
    expect(isEnumerationIgnored(config, '2.1.0', 'Member', 'MLSAreaMinor')).toBe(false); // wrong resource
    expect(isEnumerationIgnored(config, '2.0.0', 'Media', 'ImageSizeDescription')).toBe(false); // not in 2.0
    expect(isEnumerationIgnored({}, '2.1.0', 'Property', 'MLSAreaMinor')).toBe(false); // empty config
  });

  it('reads the real committee-approved schema-validation-settings.json', async () => {
    // cwd is the reso-certification package root under vitest, so resolveSettingsPath finds the committed file.
    const real = await loadValidationConfig();
    expect(isEnumerationIgnored(real, '2.1.0', 'Property', 'MLSAreaMinor')).toBe(true);
    expect(isEnumerationIgnored(real, '2.0.0', 'Media', 'ImageSizeDescription')).toBe(true);
    expect(isEnumerationIgnored(real, '2.1.0', 'Property', 'ListPrice')).toBe(false);
  });
});
