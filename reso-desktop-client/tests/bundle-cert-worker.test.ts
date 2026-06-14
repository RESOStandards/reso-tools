import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { certSdkVersion, bundleOptions } from '../scripts/bundle-cert-worker.mjs';

// Provenance regression guard. The cert-worker is esbuild-bundled, so once
// reports.ts is inlined, `import.meta.url` points at the bundle and the runtime
// manifest read resolves to the wrong package (or none) — silently stamping
// reports with softwareVersion "unknown". The bundle must therefore inject the
// cert SDK version at build time. These tests fail if that injection is dropped.
const certManifestVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../reso-certification/package.json', import.meta.url)), 'utf8'),
).version as string;

describe('cert-worker bundle provenance injection', () => {
  it('certSdkVersion reads the cert SDK version from its manifest', () => {
    expect(certSdkVersion()).toBe(certManifestVersion);
  });

  it('bundle define injects __RESO_CERT_SDK_VERSION__ so provenance survives bundling', () => {
    const { define } = bundleOptions();
    expect(define?.__RESO_CERT_SDK_VERSION__).toBe(JSON.stringify(certManifestVersion));
  });
});
