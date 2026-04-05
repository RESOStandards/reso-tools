/**
 * Bundles the server entry point + all server code into a single ESM file
 * for use in the packaged Electron app.
 *
 * Native modules and unused DB drivers are externalized:
 *   - better-sqlite3  (native addon — copied separately)
 *   - pg, mongodb      (not used in desktop/SQLite mode)
 *   - swagger-ui-dist  (static assets served at runtime — copied separately)
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const monoRoot = resolve(desktopRoot, '..'); // monorepo root (reso-tools/)
const outDir = resolve(desktopRoot, 'dist', 'server-bundle');

// External packages — not bundled, resolved at runtime from node_modules alongside the bundle
const external = [
  'better-sqlite3',
  'pg',
  'mongodb',
  'swagger-ui-dist',
  // Node built-ins
  'node:*',
  'fs', 'path', 'http', 'https', 'url', 'crypto', 'stream', 'events',
  'zlib', 'net', 'tls', 'os', 'util', 'querystring', 'buffer', 'child_process',
  'assert', 'dns', 'string_decoder', 'timers', 'perf_hooks', 'worker_threads',
];

console.log('Bundling server entry point...');

await build({
  entryPoints: [resolve(desktopRoot, 'src', 'server-entry.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: resolve(outDir, 'server-entry.mjs'),
  external,
  // Resolve @reso-standards/* file: deps from the monorepo node_modules
  nodePaths: [resolve(monoRoot, 'node_modules')],
  banner: {
    // esbuild ESM output needs createRequire for any CJS interop
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
  logLevel: 'info',
});

// Copy external packages that ARE needed at runtime to a node_modules dir alongside the bundle
const bundleNodeModules = resolve(outDir, 'node_modules');
mkdirSync(bundleNodeModules, { recursive: true });

/** Candidate locations where runtime dependencies may be installed. */
const nodeModulesDirs = [
  resolve(monoRoot, 'reso-reference-server', 'node_modules'),
  resolve(monoRoot, 'node_modules'),
];

/** Copy a package from the first location where it exists to the bundle's node_modules. */
const copyPackage = (name) => {
  const dest = resolve(bundleNodeModules, name);
  for (const dir of nodeModulesDirs) {
    const src = resolve(dir, name);
    if (existsSync(src)) {
      console.log(`  Copying ${name} from ${dir}...`);
      cpSync(src, dest, { recursive: true });
      return;
    }
  }
  console.warn(`  WARNING: ${name} not found in any node_modules`);
};

// better-sqlite3 + its native dependencies
console.log('Copying runtime dependencies...');
copyPackage('better-sqlite3');
copyPackage('bindings');
copyPackage('file-uri-to-path');
copyPackage('prebuild-install');

// swagger-ui-dist (static assets served at runtime by swagger-ui-express, which is bundled)
copyPackage('swagger-ui-dist');

// Stub packages for DB drivers not used in desktop/SQLite mode.
// ESM resolution requires these to exist even if the code path is never reached.
const createStub = (name) => {
  const dir = resolve(bundleNodeModules, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js', type: 'commonjs' }));
  writeFileSync(resolve(dir, 'index.js'), 'module.exports = {};');
  console.log(`  Stubbed ${name} (not used in SQLite mode)`);
};
createStub('pg');
createStub('mongodb');

console.log('Server bundle complete.');
