/**
 * Side-effect-only module: load .env into process.env at import time.
 *
 * MUST be the first import in `cli/index.ts`. Other CLI imports (e.g.
 * `../sdk/dd.ts`) transitively pull in legacy CJS modules that destructure
 * env vars (`RESO_SERVICES_URL`, etc.) at module load. ESM evaluates
 * imported modules' top-level code in dependency order, so by importing
 * this file before anything that touches the legacy chain, we guarantee
 * the env is populated before those destructures run.
 *
 * Search paths, in priority order:
 *   1. The user's current working directory (project-local .env).
 *   2. The reso-certification package root.
 *   3. The reso-tools monorepo root.
 * First match wins; existing env vars always take precedence inside loadDotEnv.
 */

import { resolve } from 'node:path';
import { loadDotEnv } from './auth.js';

const certRoot = resolve(import.meta.dirname, '..', '..');
const toolsRoot = resolve(import.meta.dirname, '..', '..', '..');
loadDotEnv([process.cwd(), certRoot, toolsRoot]);
