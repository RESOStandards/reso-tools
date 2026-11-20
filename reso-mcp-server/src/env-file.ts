/**
 * `--credentials <path>`: read the server's credentials from a file the user keeps, before anything reads the
 * environment.
 *
 * Run with `npx`, the server has no source directory of its own to keep a `.env` in. The flag is not called
 * `--env-file`: Node claims that name anywhere on the command line, after the script path too, and handles it itself
 * before the server starts (measured on Node 24: a missing file exits 9 with Node's own message). Without this, the only way to give the server a
 * credential would be the MCP client's `env` block, which keeps the secret in plain text in every client's
 * configuration. With it, the secret lives in one file outside any client configuration, and every client points
 * at that file.
 *
 * The file is read with Node's `process.loadEnvFile` (Node 21.7 and later; this package requires 22), so no
 * dependency is added. A variable already set in the environment is kept: the file fills in, it never overrides.
 * A file that cannot be read stops the server with a message that names the path and never its contents.
 */

/** The flag that names the file. */
export const ENV_FILE_FLAG = '--credentials';

/** The path given with `--credentials <path>` or `--credentials=<path>`, or undefined when the flag is absent. */
export const envFilePathFrom = (argv: ReadonlyArray<string>): string | undefined => {
  const joined = argv.find(arg => arg.startsWith(`${ENV_FILE_FLAG}=`));
  if (joined !== undefined) {
    const value = joined.slice(ENV_FILE_FLAG.length + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  const index = argv.indexOf(ENV_FILE_FLAG);
  const next = index === -1 ? undefined : argv[index + 1];
  return next !== undefined && !next.startsWith('--') && next.trim().length > 0 ? next.trim() : undefined;
};

/** What loading the file came to: nothing asked, loaded, or a failure to report. */
export type EnvFileResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly path: string }
  | { readonly kind: 'failed'; readonly path: string; readonly reason: string };

/** Whether the flag was given with no path after it, which is a mistake to report rather than ignore. */
const flagWithoutPath = (argv: ReadonlyArray<string>): boolean => argv.some(arg => arg === ENV_FILE_FLAG || arg === `${ENV_FILE_FLAG}=`);

/**
 * Load the file the arguments name. `load` is Node's `process.loadEnvFile` unless a test passes another.
 * The reason on failure is the error's code (ENOENT, EACCES, ...), never its message, which can quote the file.
 */
export const loadEnvFileFrom = (
  argv: ReadonlyArray<string>,
  load: (path: string) => void = path => process.loadEnvFile(path)
): EnvFileResult => {
  const path = envFilePathFrom(argv);
  if (path === undefined) {
    return flagWithoutPath(argv) ? { kind: 'failed', path: '', reason: `${ENV_FILE_FLAG} needs a path` } : { kind: 'none' };
  }
  try {
    load(path);
    return { kind: 'loaded', path };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unreadable';
    return { kind: 'failed', path, reason: code };
  }
};

/** The line written to stderr for a failure. stdout carries the MCP protocol, so nothing else may go there. */
export const envFileFailureMessage = (result: Extract<EnvFileResult, { kind: 'failed' }>): string =>
  result.path === ''
    ? `reso-mcp: ${result.reason}. Example: reso-mcp ${ENV_FILE_FLAG} ~/.config/reso/mcp.env`
    : `reso-mcp: could not read the environment file ${result.path} (${result.reason}). Nothing was started.`;
