import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { registerSecret } from './secrets.js';

/**
 * Files looked for in the working directory when `--env-file` is not given, in order.
 *
 * `credentials.env` comes first because that is the name the certification site downloads. Asking
 * somebody to rename a file, or to source it in their shell, before the CLI can see it is exactly
 * the step this module exists to remove.
 */
const DEFAULT_ENV_FILES: ReadonlyArray<string> = ['credentials.env', '.env'];

/**
 * Keys whose VALUE is a credential rather than an address.
 *
 * Matched so the value can be registered for masking before anything has a chance to print it.
 * `TOKEN_URI` deliberately does not match: it is a URL, and masking it would hide the one field
 * that says which environment a run is authenticating against.
 */
const SECRET_KEY = /(SECRET|PASSWORD|API_?KEY)$/i;

/** Strip one pair of matching quotes, and only when they wrap the whole value. */
const unquote = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ? value.slice(1, -1)
    : value;

/**
 * One `KEY=value` line, or nothing.
 *
 * Split on the FIRST `=` only, because a value can contain them - base64 pads with them, and
 * `CLIENT_SECRET` is base64.
 */
const parseLine = (line: string): readonly [string, string] | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
  const separator = withoutExport.indexOf('=');
  if (separator <= 0) return null;
  const key = withoutExport.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return [key, unquote(withoutExport.slice(separator + 1).trim())] as const;
};

/** Every `KEY=value` pair in the text, last occurrence winning. */
export const parseEnvFile = (text: string): ReadonlyMap<string, string> =>
  text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((entry): entry is readonly [string, string] => entry !== null)
    .reduce((pairs, [key, value]) => pairs.set(key, value), new Map<string, string>());

export interface EnvFileLoad {
  /** The file actually read, or null when there was none to read. */
  readonly path: string | null;
  /** Names set from the file. Names only - a value from this file may be a credential. */
  readonly applied: ReadonlyArray<string>;
  /** Names the file carried that were already present in the environment, and so left alone. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Read an environment file into `process.env`.
 *
 * **The environment always wins.** A variable already set is never overwritten, so an export in
 * the shell, a CI secret or a value passed inline stays authoritative over a file that happens to
 * be sitting in the working directory. The surprising direction would be the other one.
 *
 * An explicit `--env-file` that does not exist throws rather than falling back: somebody who named
 * a file meant that file, and silently running without it is how a run ends up authenticating
 * against an environment nobody chose. A default file that is simply absent is not an error.
 */
export const loadEnvFile = (explicitPath?: string): EnvFileLoad => {
  const candidate = explicitPath
    ? resolve(process.cwd(), explicitPath)
    : DEFAULT_ENV_FILES.map(name => resolve(process.cwd(), name)).find(path => existsSync(path));

  if (explicitPath && !existsSync(candidate as string)) {
    throw new Error(`--env-file ${explicitPath} does not exist (looked for ${candidate}).`);
  }
  if (!candidate) return { path: null, applied: [], skipped: [] };

  const pairs = parseEnvFile(readFileSync(candidate, 'utf8'));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of pairs) {
    if (process.env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    // Registered before it is set, so there is no window in which it could be printed unmasked.
    if (SECRET_KEY.test(key)) registerSecret(value);
    process.env[key] = value;
    applied.push(key);
  }

  return { path: candidate, applied, skipped };
};
