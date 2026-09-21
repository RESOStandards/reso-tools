#!/usr/bin/env node
/**
 * pack:all — build every public package and `npm pack` it into one directory.
 *
 * The tarballs are what `npm publish` would upload: `files` and `prepublishOnly`
 * apply exactly as they do on publish, so a consumer that installs them gets the
 * packaged shape, not a symlink into this checkout. The desktop and web client
 * in reso-tools-private link against them with `npm run dev:link <dir>` to test
 * un-published changes before anything is published (reso-tools #277).
 *
 * Usage: node scripts/pack-all.mjs [outDir]   (default ./.packs; PACK_DIR overrides)
 *        --no-build   skip `npm run build` (the dist folders are already current)
 *
 * Writes <outDir>/manifest.json — name, version, filename, integrity per package —
 * which dev:link reads, and prints one line per tarball.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const outArg = args.find(a => !a.startsWith('--'));
const outDir = resolve(outArg ?? process.env.PACK_DIR ?? '.packs');
const root = resolve(import.meta.dirname, '..');

/** Run a command and capture stdout (stderr passes through). */
const capture = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
/** Run a command with all output passed through. */
const passthrough = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });

if (!skipBuild) {
  console.log('Building every workspace...');
  passthrough('npm', ['run', 'build']);
}

// Start from an empty directory so a stale tarball from an earlier version can
// never be linked by mistake.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Packing every workspace into ${outDir} ...`);
const packed = JSON.parse(capture('npm', ['pack', '--workspaces', '--json', '--pack-destination', outDir]));

const manifest = {
  packedAt: new Date().toISOString(),
  source: root,
  packages: packed.map(p => ({
    name: p.name,
    version: p.version,
    filename: p.filename,
    integrity: p.integrity,
    files: p.entryCount,
    unpackedSize: p.unpackedSize,
  })),
};
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const present = new Set(readdirSync(outDir));
const missing = manifest.packages.filter(p => !present.has(p.filename));
if (missing.length > 0) {
  console.error(`npm pack reported tarballs that are not on disk: ${missing.map(p => p.filename).join(', ')}`);
  process.exit(1);
}

const width = Math.max(...manifest.packages.map(p => p.name.length));
for (const p of manifest.packages) {
  console.log(`  ${p.name.padEnd(width)}  ${p.version.padEnd(14)}  ${String(p.files).padStart(4)} files  ${(p.unpackedSize / 1e6).toFixed(1).padStart(5)} MB  ${p.filename}`);
}
console.log(`\n${manifest.packages.length} tarball(s) + manifest.json in ${outDir}`);
console.log('Next, in reso-tools-private:  npm run dev:link -- ' + outDir);
