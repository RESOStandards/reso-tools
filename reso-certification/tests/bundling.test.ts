/**
 * The engine has to survive being bundled. The RESO desktop app bundles it, with esbuild, into one worker file, and a
 * bundler can only include a module it can see: a static import, or a `require` of a package by name. A file loaded
 * through a path computed at run time, such as `createRequire(import.meta.url)(resolve(here, '../etl/index.cjs'))`,
 * is left out, and in the bundle the path points beside the bundle, where there is nothing. The engine then fails as
 * soon as the module loads (engine 0.12.0 to 0.12.3, through `sdk/rcf.js` and `cli/rcf-command.js`), or when the call
 * runs.
 *
 * So no TypeScript module may pass anything but a string literal to a `createRequire` function, and that literal must
 * name a package, not a path. The carried CommonJS under `src/legacy` and `src/etl` is bundled through its own static
 * `require` calls and is not checked here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const CARRIED = ['legacy', 'etl'];

const typeScriptFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return dir === SRC && CARRIED.includes(entry.name) ? [] : typeScriptFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });

/** The names bound to `createRequire(...)` in a file, such as `requireCjs`. */
const requireNames = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/const\s+(\w+)\s*=\s*createRequire\(/g)].map(match => match[1] ?? '').filter(Boolean);

/** Each call of a `createRequire` function whose argument is not a package name in quotes. */
const computedLoads = (file: string): ReadonlyArray<string> => {
  const source = readFileSync(file, 'utf8');
  return requireNames(source).flatMap(name =>
    [...source.matchAll(new RegExp(`\\b${name}\\(([^)]*)\\)`, 'g'))]
      .map(match => (match[1] ?? '').trim())
      .filter(argument => !/^(['"])(@[\w.-]+\/)?[\w.-]+(\/[\w.-]+)*\1$/.test(argument) || /^['"]\.{1,2}\//.test(argument))
      .map(argument => `${relative(SRC, file)}: ${name}(${argument})`)
  );
};

describe('bundling', () => {
  it('loads every file by a static import or a package name, so a bundler can include it', () => {
    expect(typeScriptFiles(SRC).flatMap(computedLoads)).toEqual([]);
  });
});
