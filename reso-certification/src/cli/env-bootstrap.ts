/**
 * Side-effect module: load the run's environment file into process.env at import time.
 *
 * MUST be the first import in `cli/index.ts`. Other CLI imports (e.g. `../sdk/dd.ts`) transitively pull in
 * legacy CJS modules that destructure env vars (`RESO_SERVICES_URL`, etc.) at module load. ESM evaluates
 * imported modules' top-level code in dependency order, so by importing this file before anything that
 * touches the legacy chain, we guarantee the env is populated before those destructures run.
 *
 * One file at most is read (`env-file.ts`): the first that exists of `./credentials.env`, `./.env`, the
 * reso-certification package root's `.env` and the reso-tools monorepo root's `.env`. A variable the
 * environment already has is never overwritten. What was read, or why it could not be, is exported for the
 * CLI to report before a command runs.
 */

import { resolve } from 'node:path';
import { type EnvBootstrap, bootstrapEnv } from './env-file.js';

const certRoot = resolve(import.meta.dirname, '..', '..');
const toolsRoot = resolve(import.meta.dirname, '..', '..', '..');

export const ENV_BOOTSTRAP: EnvBootstrap = bootstrapEnv({ cwd: process.cwd(), roots: [certRoot, toolsRoot] });
