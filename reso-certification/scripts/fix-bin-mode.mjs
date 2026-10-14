/**
 * Make the built CLI executable.
 *
 * Why this exists, because it is an unusual step in a build and it cost a maintainer's attention
 * twice before being written down:
 *
 *   - `tsc` emits a NEWLY created file as 0644, and leaves the mode alone when it overwrites an
 *     existing one. So the bit is missing only after a fresh `dist/`, which is why this went
 *     unnoticed from 0.10.2 to 0.10.7: any developer whose copy already had the bit kept it.
 *   - npm DOES restore the bit on install, via its `bin-links` step. Anyone installing from the
 *     registry was never affected, verified by installing a tarball with the bit cleared and
 *     finding the installed target at 0755.
 *   - What breaks without it is local development only: nothing chmods after a bare `npm run
 *     build`, so the workspace bin link points at a non-executable file and both
 *     `./dist/cli/index.js` and `npx reso-cert` answer `Permission denied` inside the repository.
 *
 * The bin path is read from package.json rather than hardcoded, so renaming the entry point cannot
 * leave this silently chmodding a file that no longer exists.
 */
import { chmodSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const targets = Object.values(pkg.bin ?? {});

if (targets.length === 0) {
  console.error('fix-bin-mode: package.json declares no bin targets; nothing to do.');
  process.exit(0);
}

for (const rel of targets) {
  const file = resolve(root, rel);
  let mode;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    console.error(`fix-bin-mode: ${rel} does not exist. Did the build run?`);
    process.exit(1);
  }
  if ((mode & 0o111) !== 0) continue; // already executable: the usual case, stay quiet
  chmodSync(file, 0o755);
  // Printed only when the mode actually changed, so a normal rebuild is silent and the one case
  // that used to confuse people announces itself.
  console.log(`fix-bin-mode: ${rel} was ${mode.toString(8)}, set to 755 so \`npx reso-cert\` works in this repo (tsc emits 0644 on a fresh file).`);
}
