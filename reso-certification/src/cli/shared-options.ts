/**
 * Shared Commander option builders for the `reso-cert` CLI.
 *
 * Rationale: the *subject* of each command (the payload, the RCF data, the
 * metadata file) keeps a semantic, self-documenting flag — `--metadata`,
 * `--payload`, `--input` — because those disambiguate multi-input commands and
 * say what they are. The *universal* flags — the server URL, the OAuth2 auth
 * cluster, the output directory — are standardized here so every command
 * declares them identically (same flags, same base wording, same alias) and
 * they can't drift. An optional `context` suffix keeps a command-specific hint
 * (e.g. a `--from-server`-scoped auth block) without diverging the flag names.
 */

import type { Command } from 'commander';

const suffix = (context?: string): string => (context ? ` ${context}` : '');

/**
 * The OAuth2 / bearer auth cluster, shared by every command that authenticates
 * to a live server. `context` appends a scope hint to each description (e.g.
 * `'for the --from-server endpoint'`) — the flag names and base wording never
 * change, only the hint.
 */
export const addAuthOptions = (cmd: Command, context?: string): Command =>
  cmd
    .option('--auth-token <token>', `Pre-fetched bearer token${suffix(context)}`)
    .option('--client-id <id>', `OAuth2 client ID${suffix(context)} (with --client-secret and --token-url)`)
    .option('--client-secret <secret>', `OAuth2 client secret${suffix(context)}`)
    .option('--token-url <url>', `OAuth2 token endpoint URL${suffix(context)}`);

/**
 * The canonical `-u, --url` server-root option. Required-ness varies by command
 * (some servers are mandatory, some are `--from-server`-conditional) so it is a
 * parameter; the `-u` alias and the base wording do not vary. `context` adds a
 * command-specific hint (e.g. `'(no resource name or query)'`).
 */
export const addServerUrlOption = (
  cmd: Command,
  opts: { readonly required?: boolean; readonly context?: string } = {},
): Command => {
  const flags = '-u, --url <url>';
  const description = `OData service root URL${suffix(opts.context)}`;
  return opts.required ? cmd.requiredOption(flags, description) : cmd.option(flags, description);
};

/**
 * The compliance-report output bundle: verbosity, console/json format, and the
 * report directory. Used by the endorsement/compliance commands.
 */
export const addOutputOptions = (cmd: Command): Command =>
  cmd
    .option('--verbose', 'Detailed line-by-line output')
    .option('--output <format>', 'Output format: console or json', 'console')
    .option('--output-dir <path>', 'Directory for compliance reports');

/**
 * The artifact `--output-dir` — defaults to the current directory, `"-"` for
 * stdout where a command supports it. Distinct from {@link addOutputOptions}:
 * the report-generating steps (schema, metadata, rcf, variations) write a
 * single artifact and do not take `--verbose`/`--output`.
 */
export const addReportDirOption = (
  cmd: Command,
  description = 'Directory for the report (created if missing); "-" for stdout',
): Command => cmd.option('--output-dir <path>', description, '.');
