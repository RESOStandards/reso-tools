/**
 * The published `bin` must be executable.
 *
 * Named for the failure it would allow: without this, `reso-cert` dies with
 * "Permission denied" for every user who installs the package. `tsc` emits dist files as
 * 0644, `npm pack` faithfully preserves whatever mode is on disk, and nothing downstream
 * restores the bit – npm does not chmod bin targets on install. Version 0.10.7 shipped exactly
 * that way.
 *
 * It is worse than a plain failure, because `npx` treats a non-executable local bin as
 * unusable and silently falls through to the registry copy, which carries the same defect. The
 * error then names a path in the npx cache and points away from the real cause.
 *
 * The bin path is read from package.json rather than hardcoded, so renaming the entry point
 * cannot leave this test passing against a file nobody ships.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readBinEntries = (): ReadonlyArray<readonly [string, string]> => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf-8')) as {
    readonly bin?: Readonly<Record<string, string>>;
  };
  return Object.entries(manifest.bin ?? {});
};

const OWNER_EXECUTE = 0o100;

describe('published bin', () => {
  const entries = readBinEntries();

  it('declares at least one bin, so the checks below are not vacuous', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [name, relativePath] of entries) {
    const absolutePath = resolve(packageRoot, relativePath);

    it(`${name} is executable, so an installed \`${name}\` does not fail with Permission denied`, () => {
      // Existence is asserted here rather than in its own test so a missing dist produces one
      // actionable failure instead of a second ENOENT crash out of statSync.
      expect(existsSync(absolutePath), `${relativePath} is missing - run npm run build first`).toBe(true);

      const mode = statSync(absolutePath).mode;
      expect(
        mode & OWNER_EXECUTE,
        `${relativePath} is mode ${(mode & 0o777).toString(8)}; npm pack preserves it and the installed bin will not run`
      ).toBe(OWNER_EXECUTE);
    });
  }
});
