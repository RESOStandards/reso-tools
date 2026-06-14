/**
 * Bundles the cert-worker + reso-certification into a standalone ESM file
 * for use in the packaged Electron app.
 *
 * Worker threads inside asar can't resolve npm packages via dynamic import(),
 * so the worker and all its dependencies must be bundled into a single file.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const monoRoot = resolve(desktopRoot, '..');

/**
 * The cert SDK version, read from reso-certification/package.json. Injected
 * into the bundle as `__RESO_CERT_SDK_VERSION__` so report provenance is
 * correct in the bundled cert-worker — there the runtime manifest read in
 * reports.ts can't resolve the SDK package (import.meta.url points at the
 * bundle, not the SDK). Throws if the version is missing so provenance never
 * silently degrades to 'unknown' in a release build.
 */
export const certSdkVersion = (root = monoRoot) => {
  const manifest = resolve(root, 'reso-certification', 'package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!version) {
    throw new Error(`No version in ${manifest} — cannot inject cert SDK provenance`);
  }
  return version;
};

const external = [
  // Node built-ins
  'node:*',
  'fs', 'path', 'http', 'https', 'url', 'crypto', 'stream', 'events',
  'zlib', 'net', 'tls', 'os', 'util', 'querystring', 'buffer', 'child_process',
  'assert', 'dns', 'string_decoder', 'timers', 'perf_hooks', 'worker_threads',
  'node:worker_threads', 'node:fs', 'node:fs/promises', 'node:path', 'node:url',
  'node:crypto', 'node:module',
];

/**
 * esbuild config for the cert-worker bundle. Exported so the provenance
 * injection can be asserted without running a full build.
 */
export const bundleOptions = () => ({
  entryPoints: [resolve(desktopRoot, 'src', 'cert-worker-entry.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: resolve(desktopRoot, 'dist', 'cert-worker-bundle.mjs'),
  external,
  nodePaths: [
    resolve(monoRoot, 'node_modules'),
    resolve(desktopRoot, 'node_modules'),
  ],
  alias: {
    '@reso-standards/reso-certification': resolve(monoRoot, 'reso-certification', 'dist', 'index.js'),
  },
  // Inject the cert SDK version so report provenance survives bundling — the
  // runtime manifest read in reports.ts can't resolve the SDK from the bundle.
  define: {
    __RESO_CERT_SDK_VERSION__: JSON.stringify(certSdkVersion()),
  },
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
  logLevel: 'info',
});

// Run the build only when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(`Bundling cert-worker (provenance ${certSdkVersion()})...`);
  await build(bundleOptions());
  console.log('Cert worker bundle complete.');
}
