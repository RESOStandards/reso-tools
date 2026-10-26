import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { registerSecret } from './secrets.js';

/**
 * The CLI's environment files: which one is read, and how.
 *
 * One file at most is read, at startup, by `env-bootstrap.ts`. That module is the CLI's first import because
 * legacy modules read variables such as `RESO_SERVICES_URL` the moment they load, so a file read any later
 * would reach the commands that mint a token but not those modules. Everything here takes its directories as
 * arguments, so it is tested without loading the CLI: the bootstrap is the only caller that passes the real cwd.
 */

/**
 * Looked for in the working directory, in order. `credentials.env` comes first because
 * that is the name the certification site downloads. Asking somebody to rename it, or to source it in their
 * shell, before the CLI can see it is exactly the step this removes.
 */
const WORKING_DIRECTORY_FILES: ReadonlyArray<string> = ['credentials.env', '.env'];

/**
 * Keys whose VALUE is a credential rather than an address, registered for masking before anything can print
 * them. `TOKEN_URI` deliberately does not match: it is a URL, and masking it would hide the one field that says
 * which environment a run authenticates against.
 */
const SECRET_KEY = /(SECRET|PASSWORD|API_?KEY)$/i;

export interface EnvFileLoad {
  /** The file that was read. */
  readonly path: string;
  /** Names set from the file. Names only: a value from this file may be a credential. */
  readonly applied: ReadonlyArray<string>;
  /** Names the file carried that the environment already had, and so left alone. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Read one environment file into `process.env`, with Node's own parser.
 *
 * **The environment always wins.** A variable already set is never overwritten, so an export in the shell, a CI
 * secret or a value passed inline stays authoritative over a file that happens to be in the working directory.
 * **A credential is registered for masking before it is set**, so there is no moment at which it could be
 * printed unmasked.
 */
export const loadEnvFile = (path: string): EnvFileLoad => {
  const pairs = Object.entries(parseEnv(readFileSync(path, 'utf8')));
  const skipped = pairs.filter(([key]) => process.env[key] !== undefined).map(([key]) => key);
  const fresh = pairs.filter(([key]) => process.env[key] === undefined);
  for (const [key, value] of fresh) {
    if (SECRET_KEY.test(key) && value !== undefined) registerSecret(value);
    process.env[key] = value;
  }
  return { path, applied: fresh.map(([key]) => key), skipped };
};

/** The first of `candidates` that exists, or undefined. */
export const firstExisting = (candidates: ReadonlyArray<string>): string | undefined => candidates.find(path => existsSync(path));

/** Where the CLI looks, in order: the working directory, then its own package and repository. */
export const defaultEnvFiles = (dirs: { readonly cwd: string; readonly roots: ReadonlyArray<string> }): ReadonlyArray<string> => [
  ...WORKING_DIRECTORY_FILES.map(name => resolve(dirs.cwd, name)),
  ...dirs.roots.map(root => resolve(root, '.env'))
];

/** What startup read, or why it could not. The CLI reports it before a command runs. */
export interface EnvBootstrap {
  readonly load?: EnvFileLoad;
  readonly error?: string;
}

/**
 * Read the one environment file a run uses: the first of the defaults that exists.
 *
 * A file that is absent is not an error, and none at all is fine. A file that exists but cannot be read is: a
 * credentials file the CLI silently skipped would leave a run authenticating as whatever the next file says.
 * Never throws, because it runs while the CLI loads; an error is returned for the CLI to report as one.
 */
export const bootstrapEnv = (dirs: { readonly cwd: string; readonly roots: ReadonlyArray<string> }): EnvBootstrap => {
  const found = firstExisting(defaultEnvFiles(dirs));
  if (found === undefined) return {};
  try {
    return { load: loadEnvFile(found) };
  } catch (error) {
    return { error: `Could not read ${found}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
