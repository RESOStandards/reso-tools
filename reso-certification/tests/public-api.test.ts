import { describe, expect, it } from 'vitest';
import * as packageRoot from '../src/index.js';

/**
 * What a program that installs the package can import from its root. The RESO Common Format run and the fingerprint
 * were exported only inside the SDK module, so the release notes' "the SDK exports runRcfCompliance" held in this
 * repository and not for anyone installing it, RESO's cloud job included.
 */
describe('the package root', () => {
  it.each(['runComplianceTests', 'runCoreCompliance', 'runAddEditCompliance', 'runRcfCompliance', 'fingerprintRcfInput'])(
    'exports %s',
    name => {
      expect(typeof (packageRoot as Readonly<Record<string, unknown>>)[name]).toBe('function');
    }
  );
});
