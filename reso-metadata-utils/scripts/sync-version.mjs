#!/usr/bin/env node
/**
 * Sync src/version.ts from package.json so the package can stamp its
 * version on outbound requests (User-Agent) without dynamically
 * importing package.json at runtime — that path doesn't work cleanly
 * across Node, Electron, and browser bundles. Generated file is
 * checked in so direct `import` from source works without a build.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', 'package.json');
const outPath = join(here, '..', 'src', 'version.ts');

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));

const contents = `// Auto-generated from package.json by scripts/sync-version.mjs.
// Do not edit by hand — run \`npm run build\` (or \`node scripts/sync-version.mjs\`)
// to regenerate after bumping the package version.

export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(outPath, contents, 'utf8');
console.log(`reso-metadata-utils: synced src/version.ts to ${version}`);
