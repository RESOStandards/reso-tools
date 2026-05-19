#!/usr/bin/env node
/**
 * Bootstrap file: dependencies of the package at cwd.
 *
 * Called from each subpackage's `preinstall` hook so a fresh
 * `cd <pkg> && npm install` works on a clean clone without first
 * having to run the top-level bootstrap. Walks the file: dep tree
 * from cwd in topological order and builds any whose `dist/` is
 * missing.
 *
 * Idempotent: subsequent installs skip already-built packages.
 * Force-rebuild after source changes still uses `npm run
 * bootstrap:force` from the repo root.
 *
 * Defensive: failures don't throw — the parent `npm install` is
 * allowed to continue with whatever state the file: deps are in,
 * so a corrupt or partial bootstrap surfaces as a real error from
 * the consumer's build rather than a cryptic preinstall failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const visited = new Set();
const CALLER = resolve(process.cwd());

const readPkg = (dir) => {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
};

const fileDeps = (pkg) => {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return Object.entries(all)
    .filter(([, v]) => String(v).startsWith('file:'))
    .map(([name, v]) => ({ name, path: String(v).slice('file:'.length) }));
};

const isBuilt = (dir, pkg) => {
  // Packages without a build script are inherently "built" — the
  // source IS the published shape (e.g. JS files at the root, no
  // tsc output expected).
  if (!pkg.scripts?.build) return true;
  return existsSync(join(dir, 'dist'));
};

const bootstrap = (dir) => {
  const abs = resolve(dir);
  if (visited.has(abs)) return;
  visited.add(abs);

  const pkg = readPkg(abs);
  if (!pkg) return;

  // Recurse into file: deps first (topological order — leaves built
  // before consumers).
  for (const dep of fileDeps(pkg)) {
    bootstrap(resolve(abs, dep.path));
  }

  // Don't build the caller — npm is about to do that through the
  // normal install flow. We only ensure its file: deps are ready.
  if (abs === CALLER) return;
  if (isBuilt(abs, pkg)) return;

  console.log(`[bootstrap-deps] Building ${pkg.name ?? abs}…`);
  try {
    // --ignore-scripts so the dep's own preinstall doesn't recurse
    // again (we're already walking the tree here). The dep's build
    // script is invoked explicitly below.
    execSync('npm install --ignore-scripts', { cwd: abs, stdio: 'inherit' });
    execSync('npm run build', { cwd: abs, stdio: 'inherit' });
  } catch (err) {
    console.error(`[bootstrap-deps] Failed to build ${pkg.name ?? abs}: ${err.message}`);
    // Swallow — let the caller's install attempt continue. Either
    // it works (cache, partial dist already there) or it fails with
    // a clearer error from the actual consumer.
  }
};

bootstrap(CALLER);
