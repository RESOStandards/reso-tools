/**
 * Bundles the cert-worker + reso-certification into a standalone ESM file
 * for use in the packaged Electron app.
 *
 * Worker threads inside asar can't resolve npm packages via dynamic import(),
 * so the worker and all its dependencies must be bundled into a single file.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const monoRoot = resolve(desktopRoot, '..');

const external = [
  // Node built-ins
  'node:*',
  'fs', 'path', 'http', 'https', 'url', 'crypto', 'stream', 'events',
  'zlib', 'net', 'tls', 'os', 'util', 'querystring', 'buffer', 'child_process',
  'assert', 'dns', 'string_decoder', 'timers', 'perf_hooks', 'worker_threads',
  'node:worker_threads', 'node:fs', 'node:fs/promises', 'node:path', 'node:url',
  'node:crypto', 'node:module',
];

console.log('Bundling cert-worker...');

await build({
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
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
  logLevel: 'info',
});

console.log('Cert worker bundle complete.');
