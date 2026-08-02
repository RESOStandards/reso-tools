#!/usr/bin/env node

/**
 * Unified CLI entry point for RESO certification compliance testing tools.
 *
 * Subcommands:
 *   add-edit       — RCP-010 Add/Edit endorsement testing
 *   entity-event   — RCP-027 EntityEvent change tracking testing
 *   core           — Web API Core 2.0.0/2.1.0 compliance testing
 *
 * Exit codes: 0 = all scenarios passed, 1 = one or more failed, 2 = runtime error.
 */

// IMPORTANT: env-bootstrap MUST be the very first import. It calls
// loadDotEnv() as an import-time side effect so that subsequent imports
// (notably anything that transitively touches src/legacy/*) see env vars
// like RESO_SERVICES_URL populated when they destructure process.env.
import './env-bootstrap.js';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { synthesizeResourcesFromFields } from '../metadata/index.js';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { startMockServer, stopMockServer } from '../add-edit/mock/server.js';
import { startMockEntityEventServer, stopMockEntityEventServer } from '../entity-event/mock/server.js';
import { loadConfigFile, configEntryToAddEdit, configEntryToEntityEvent } from '../sdk/config.js';
import type { AddEditConfig, EntityEventConfig, CoreConfig, DDConfig, PipelineResult } from '../sdk/types.js';
import { resolveCliAuth, mintOAuth2ClientCredentialsToken } from './auth.js';
import { computeVariationsViaService, updateVariationsViaService, parseVariationsCsv } from '../variations/index.js';
import { validateSchemaPayload, generateSchemaFromReport, loadSettings } from './schema-command.js';
import { runMetadataStep } from './metadata-command.js';
import type { ODataVersion } from '../xsd/validate-csdl.js';
import { runReplicate, REPLICATION_STRATEGY_VALUES } from './replicate-command.js';
import { resolveAuthToken } from '../test-runner/auth.js';
import { CURRENT_DD_VERSION, CERTIFIABLE_DD_VERSIONS, isCertifiableDDVersion, normalizeDDVersion } from '../sdk/dd-versions.js';
import { resolveRenderMode, runWithProgress, runConfigEntries } from './render.js';

// ── Legacy CJS bridge — lets us call the frozen v3.0.0 findVariations ──

const createRequire = (await import('node:module')).createRequire;
const requireLegacy = createRequire(import.meta.url);

interface LegacyVariationsOptions {
  readonly pathToMetadataReportJson: string;
  readonly fuzziness?: number;
  readonly version?: string;
  readonly useSuggestions?: boolean;
  readonly fromCli?: boolean;
  readonly bearerToken?: string;
}

interface LegacyVariationsModule {
  readonly findVariations: (opts: LegacyVariationsOptions) => Promise<unknown>;
}

const isLegacyVariationsModule = (m: unknown): m is LegacyVariationsModule =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as Record<string, unknown>).findVariations === 'function';

const legacyVariationsRaw: unknown = requireLegacy(
  resolve(import.meta.dirname, '../legacy/lib/variations/index.js')
);
if (!isLegacyVariationsModule(legacyVariationsRaw)) {
  throw new Error('Failed to load legacy variations module — findVariations export missing.');
}
const { findVariations: legacyFindVariations } = legacyVariationsRaw;


/** Default port for mock OData servers when started via --mock. */
const DEFAULT_MOCK_PORT = 8800;

/** Loads bundled sample-metadata.xml as a fallback for --mock without --metadata. */
const loadDefaultMetadata = async (): Promise<string> => {
  const defaultPath = resolve(import.meta.dirname, '../../sample-metadata.xml');
  return readFile(defaultPath, 'utf-8');
};

/** Format pipeline results as JSON. */
const formatResultJson = (results: ReadonlyArray<PipelineResult>): string =>
  JSON.stringify(results.length === 1 ? results[0] : results, null, 2);

/** Determine exit code from pipeline results. */
const resolveExitCode = (results: ReadonlyArray<PipelineResult>): number =>
  results.some(r => r.status === 'failed') ? 1 : 0;

// ── Program ──

const program = new Command();

program.name('reso-cert').description('RESO certification compliance testing tools').version('0.5.0');

// ── Shared auth options ──

const addAuthOptions = (cmd: Command): Command =>
  cmd
    .option('--auth-token <token>', 'Pre-fetched bearer token')
    .option('--client-id <id>', 'OAuth2 client ID')
    .option('--client-secret <secret>', 'OAuth2 client secret')
    .option('--token-url <url>', 'OAuth2 token endpoint URL');

// ── Shared output options ──

const addOutputOptions = (cmd: Command): Command =>
  cmd
    .option('--verbose', 'Detailed line-by-line output')
    .option('--output <format>', 'Output format: console or json', 'console')
    .option('--output-dir <path>', 'Directory for compliance reports');

// ── Add/Edit Subcommand ──

const addEditCmd = program
  .command('add-edit')
  .description('RCP-010 Add/Edit endorsement compliance testing')
  .option('--url <url>', 'Server base URL')
  .option('--config <path>', 'Path to config file (mutually exclusive with --url)')
  .option('--resource <name>', 'OData resource name (e.g., Property)', 'Property')
  .option('--payloads <dir>', 'Path to directory containing payload JSON files')
  .option('--metadata <path>', 'Path to local XML metadata file')
  .option('--mock', 'Start a mock OData server')
  .option('--spec-version <version>', 'Specification version for report', '2.0.0');

addAuthOptions(addEditCmd);
addOutputOptions(addEditCmd);

addEditCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    resource: string;
    payloads?: string;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    metadata?: string;
    mock?: boolean;
    verbose?: boolean;
    output: string;
    outputDir?: string;
    specVersion: string;
  }) => {
    let mockServer: Awaited<ReturnType<typeof startMockServer>> | null = null;

    try {
      // Validate mutually exclusive options
      if (opts.url && opts.config) {
        throw new Error('--url and --config are mutually exclusive. Use one or the other.');
      }
      if (!opts.url && !opts.config && !opts.mock) {
        throw new Error('Provide --url, --config, or --mock.');
      }

      const renderMode = resolveRenderMode(opts);

      // Start mock server if requested
      if (opts.mock) {
        const metadataXml = opts.metadata
          ? await readFile(resolve(opts.metadata), 'utf-8')
          : await loadDefaultMetadata();
        const mock = await startMockServer({ metadataXml, resource: opts.resource, port: DEFAULT_MOCK_PORT });
        mockServer = mock;
        if (renderMode !== 'silent') console.log(`Mock server started at ${mock.url}`);
      }

      let results: ReadonlyArray<PipelineResult>;

      if (opts.config) {
        // Config file mode
        const configFile = await loadConfigFile(resolve(opts.config));
        const authFlags = { authToken: opts.authToken, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl };

        const entries = configFile.configs.map(entry => {
          const baseConfig = configEntryToAddEdit(entry, configFile.providerUoi);
          const auth = resolveCliAuth(authFlags, baseConfig.server.auth);

          const config: AddEditConfig = {
            ...baseConfig,
            server: { ...baseConfig.server, auth },
            ...(entry.payloads ? { payloads: entry.payloads } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {}),
          };

          return {
            config,
            label: entry.description ?? `${entry.recipientUoi}-${entry.providerUsi}`,
          };
        });

        results = await runConfigEntries(entries, renderMode);
      } else {
        // Direct mode
        const serverUrl = mockServer?.url ?? opts.url!;
        const auth = resolveCliAuth({
          authToken: opts.authToken ?? (opts.mock ? 'mock-token' : undefined),
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          tokenUrl: opts.tokenUrl,
        });

        const config: AddEditConfig = {
          endorsement: 'add-edit',
          server: { url: serverUrl, auth },
          resource: opts.resource,
          payloadsDir: opts.payloads ? resolve(opts.payloads) : undefined,
          metadataPath: opts.metadata ? resolve(opts.metadata) : undefined,
          specVersion: opts.specVersion,
          options: {
            skipHealthCheck: opts.mock,
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {}),
          },
        };

        const result = await runWithProgress(config, 'Add/Edit Compliance', renderMode);
        results = [result];
      }

      // JSON output
      if (opts.output === 'json') {
        console.log(formatResultJson(results));
      }

      process.exitCode = resolveExitCode(results);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    } finally {
      if (mockServer) {
        await stopMockServer(mockServer.server);
      }
    }
  },
);

// ── EntityEvent Subcommand ──

const entityEventCmd = program
  .command('entity-event')
  .description('RCP-027 EntityEvent change tracking compliance testing')
  .option('--url <url>', 'Service root URL')
  .option('--config <path>', 'Path to config file (mutually exclusive with --url)')
  .option('--mode <mode>', 'Testing mode: observe or full', 'observe')
  .option('--writable-resource <name>', 'Canary resource for full mode', 'Property')
  .option('--payloads-dir <dir>', 'Payloads directory for full mode canary writes')
  .option('--max-events <n>', 'Max EntityEvent records to validate', '1000')
  .option('--batch-size <n>', 'Keys per batch fetch request', '100')
  .option('--poll-interval <ms>', 'Time between incremental sync checks (ms)', '5000')
  .option('--poll-timeout <ms>', 'Max time to wait for new events (ms)', '30000')
  .option('--metadata <path>', 'Path to local XML metadata file')
  .option('--mock', 'Start a mock OData server');

addAuthOptions(entityEventCmd);
addOutputOptions(entityEventCmd);

entityEventCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    mode: string;
    writableResource: string;
    payloadsDir?: string;
    maxEvents: string;
    batchSize: string;
    pollInterval: string;
    pollTimeout: string;
    metadata?: string;
    mock?: boolean;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    let mockServer: Awaited<ReturnType<typeof startMockEntityEventServer>> | null = null;

    try {
      // Validate options
      if (opts.url && opts.config) {
        throw new Error('--url and --config are mutually exclusive. Use one or the other.');
      }
      if (!opts.url && !opts.config && !opts.mock) {
        throw new Error('Provide --url, --config, or --mock.');
      }

      const mode = opts.mode as 'observe' | 'full';
      if (mode !== 'observe' && mode !== 'full') {
        throw new Error(`Invalid mode "${opts.mode}". Must be "observe" or "full".`);
      }

      const renderMode = resolveRenderMode(opts);

      // Start mock server if requested
      if (opts.mock) {
        const metadataXml = opts.metadata
          ? await readFile(resolve(opts.metadata), 'utf-8')
          : await loadDefaultMetadata();
        const mock = await startMockEntityEventServer({
          metadataXml,
          canaryResource: opts.writableResource,
          port: DEFAULT_MOCK_PORT,
        });
        mockServer = mock;
        if (renderMode !== 'silent') console.log(`Mock EntityEvent server started at ${mock.url}`);
      }

      let results: ReadonlyArray<PipelineResult>;

      if (opts.config) {
        // Config file mode
        const configFile = await loadConfigFile(resolve(opts.config));
        const authFlags = { authToken: opts.authToken, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl };

        const entries = configFile.configs.map(entry => {
          const baseConfig = configEntryToEntityEvent(entry, configFile.providerUoi);
          const auth = resolveCliAuth(authFlags, baseConfig.server.auth);

          const config: EntityEventConfig = {
            ...baseConfig,
            server: { ...baseConfig.server, auth },
            mode: entry.mode ?? mode,
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {}),
          };

          return {
            config,
            label: entry.description ?? `${entry.recipientUoi}-${entry.providerUsi}`,
          };
        });

        results = await runConfigEntries(entries, renderMode);
      } else {
        // Direct mode
        const serverUrl = mockServer?.url ?? opts.url!;
        const auth = resolveCliAuth({
          authToken: opts.authToken ?? (opts.mock ? 'mock-token' : undefined),
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          tokenUrl: opts.tokenUrl,
        });

        const config: EntityEventConfig = {
          endorsement: 'entity-event',
          server: { url: serverUrl, auth },
          mode,
          writableResource: opts.writableResource,
          payloadsDir: opts.payloadsDir ? resolve(opts.payloadsDir) : undefined,
          maxEvents: Number(opts.maxEvents),
          batchSize: Number(opts.batchSize),
          pollInterval: Number(opts.pollInterval),
          pollTimeout: Number(opts.pollTimeout),
          options: {
            skipHealthCheck: opts.mock,
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {}),
          },
        };

        const result = await runWithProgress(config, 'EntityEvent Compliance', renderMode);
        results = [result];
      }

      // JSON output
      if (opts.output === 'json') {
        console.log(formatResultJson(results));
      }

      process.exitCode = resolveExitCode(results);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    } finally {
      if (mockServer) {
        await stopMockEntityEventServer(mockServer.server);
      }
    }
  },
);

// ── Web API Core Subcommand ──

const coreCmd = program
  .command('core')
  .description('Web API Core 2.0.0/2.1.0 compliance testing')
  .requiredOption('--url <url>', 'Server base URL')
  .option('--resources <list>', 'Comma-separated resource names (default: well-known list)')
  .option('--version <version>', 'Spec version: 2.0.0 or 2.1.0', '2.0.0')
  .option('--enum-mode <mode>', 'Enum mode: auto, string, collections, or isflags (default: auto-detect)', 'auto')
  .option('--full-coverage', 'Fail if any data type category has no coverage across all resources');

addAuthOptions(coreCmd);
addOutputOptions(coreCmd);

coreCmd.action(
  async (opts: {
    url: string;
    resources?: string;
    version: string;
    enumMode: string;
    fullCoverage?: boolean;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    try {
      const specVersion = opts.version as '2.0.0' | '2.1.0';
      if (specVersion !== '2.0.0' && specVersion !== '2.1.0') {
        throw new Error(`Invalid version "${opts.version}". Must be "2.0.0" or "2.1.0".`);
      }

      const enumMode = opts.enumMode as 'auto' | 'isflags' | 'collections' | 'string';
      if (!['auto', 'isflags', 'collections', 'string'].includes(enumMode)) {
        throw new Error(`Invalid enum mode "${opts.enumMode}". Must be "auto", "string", "collections", or "isflags".`);
      }

      const renderMode = resolveRenderMode(opts);
      const auth = resolveCliAuth({
        authToken: opts.authToken,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        tokenUrl: opts.tokenUrl,
      });

      const resources = opts.resources?.split(',').map(r => r.trim());

      const config: CoreConfig = {
        endorsement: 'core',
        server: { url: opts.url, auth },
        version: specVersion,
        enumMode,
        fullCoverage: opts.fullCoverage,
        resources,
        options: {
          ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {}),
        },
      };

      const result = await runWithProgress(config, `Web API Core ${specVersion}`, renderMode);

      if (opts.output === 'json') {
        console.log(formatResultJson([result]));
      }

      process.exitCode = resolveExitCode([result]);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  },
);

// ── Data Dictionary Subcommand ──

const ddCmd = program
  .command('dd')
  .description('Data Dictionary compliance testing')
  .requiredOption('--url <url>', 'Server base URL')
  .option('--dd-version <version>', `DD version (${CERTIFIABLE_DD_VERSIONS.join(' or ')})`, CURRENT_DD_VERSION)
  .option('--limit <n>', 'Max records to replicate per resource', '100000')
  .option('--strict', 'Strict mode: fail on variations and enforce JSON schema validation')
  .option('--batch-expand', 'Batch all expansions per resource into a single $expand request');

addAuthOptions(ddCmd);
addOutputOptions(ddCmd);

ddCmd.action(
  async (opts: {
    url: string;
    ddVersion: string;
    limit: string;
    strict?: boolean;
    batchExpand?: boolean;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    try {
      const ddVersion = normalizeDDVersion(opts.ddVersion);
      if (!isCertifiableDDVersion(ddVersion)) {
        throw new Error(`Invalid version "${opts.ddVersion}". RESO certification requires DD ${CERTIFIABLE_DD_VERSIONS.join(' or ')}.`);
      }

      const renderMode = resolveRenderMode(opts);
      const auth = resolveCliAuth({
        authToken: opts.authToken,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        tokenUrl: opts.tokenUrl,
      });

      const config: DDConfig = {
        endorsement: 'dd',
        fromCli: true,
        server: { url: opts.url, auth },
        version: ddVersion,
        limit: Number(opts.limit),
        strictMode: opts.strict,
        batchExpand: opts.batchExpand,
        options: {
          ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {}),
        },
      };

      const result = await runWithProgress(config, `Data Dictionary ${ddVersion}`, renderMode);

      if (opts.output === 'json') {
        console.log(formatResultJson([result]));
      }

      process.exitCode = resolveExitCode([result]);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  },
);

// ── Find Variations Subcommand ──
//
// Mirrors `findVariations` from reso-certification-utils. Runs the frozen
// v3.0.0 variations detection in `src/legacy/lib/variations/` against a
// metadata-report.json. By default the cloud variations service is called
// to fetch human-provided suggestions in addition to algorithmic ones;
// pass --disable-variations-service-check to skip that call and use only
// the local algorithmic suggestions.

const DEFAULT_FUZZINESS = 0.25;
const DEFAULT_DD_VERSION = '2.0';

program
  .command('find-variations')
  .description('Find DD variations in a metadata report (frozen v3.0.0 detection)')
  .requiredOption('-p, --metadata <path>', 'Path to metadata-report JSON file')
  .option(
    '-f, --fuzziness <float>',
    `Fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`,
    String(DEFAULT_FUZZINESS)
  )
  .option(
    '-v, --version <version>',
    `Data Dictionary version (default ${DEFAULT_DD_VERSION})`,
    DEFAULT_DD_VERSION
  )
  .option(
    '--disable-variations-service-check',
    'Skip the cloud variations service call (use algorithmic suggestions only)'
  )
  .action(
    async (opts: {
      metadata: string;
      fuzziness: string;
      version: string;
      disableVariationsServiceCheck?: boolean;
    }) => {
      try {
        const fuzziness = Number.parseFloat(opts.fuzziness);
        if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) {
          throw new Error(`--fuzziness must be a number in [0, 1], got '${opts.fuzziness}'`);
        }

        // Mint a fresh OAuth2 bearer token via client_credentials when the
        // .env carries TOKEN_URI + CLIENT_ID + CLIENT_SECRET. This avoids
        // operators having to maintain a long-lived static token. If the
        // mint fails or env vars are missing, fall through to whatever
        // findVariations does on its own (its fetchProviderToken path).
        const bearerToken = opts.disableVariationsServiceCheck
          ? undefined
          : await mintOAuth2ClientCredentialsToken();

        await legacyFindVariations({
          pathToMetadataReportJson: resolve(opts.metadata),
          fuzziness,
          version: opts.version,
          useSuggestions: !opts.disableVariationsServiceCheck,
          fromCli: true,
          ...(bearerToken ? { bearerToken } : {}),
        });
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    }
  );

// ── Compute Variations Subcommand ──
//
// Standalone variations check against the cloud /compute service for any
// metadata-report.json — no full cert run. The matcher + the canonical /
// in-review blend run server-side; this sends the report and prints the
// variations. CLI auth: an OAuth2 client_credentials token from .env
// (TOKEN_URI / CLIENT_ID / CLIENT_SECRET); if absent, the service falls back
// to minting from CERT_AUTH_API_* creds, else it reports how to authenticate.

program
  .command('compute-variations')
  .description('Compute DD variations for a metadata report via the cloud Variations Service')
  .requiredOption('-p, --metadata <path>', 'Path to metadata-report JSON file')
  .option('-v, --version <version>', `Data Dictionary version (default ${DEFAULT_DD_VERSION})`, DEFAULT_DD_VERSION)
  .option('-f, --fuzziness <float>', `Fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`, String(DEFAULT_FUZZINESS))
  .option('-o, --output <path>', 'Write the variations report here (default: stdout)')
  .action(async (opts: { metadata: string; version: string; fuzziness: string; output?: string }) => {
    try {
      const fuzziness = Number.parseFloat(opts.fuzziness);
      if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) {
        throw new Error(`--fuzziness must be a number in [0, 1], got '${opts.fuzziness}'`);
      }

      const metadataReportJson = JSON.parse(await readFile(resolve(opts.metadata), 'utf-8')) as unknown;
      const bearerToken = await mintOAuth2ClientCredentialsToken();

      const report = await computeVariationsViaService({
        metadataReportJson,
        version: opts.version,
        fuzziness,
        fromCli: true,
        ...(bearerToken ? { bearerToken } : {}),
      });

      const out = JSON.stringify(report, null, 2);
      if (opts.output) {
        await writeFile(resolve(opts.output), out);
        console.log(`Variations report written to ${resolve(opts.output)}`);
      } else {
        console.log(out);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  });

// ── Update Variations Subcommand (Admin) ──
//
// Submit human-reviewed variation suggestions from a CSV to the v2 admin
// endpoint (POST /v2/certification/variations). Auth: an OAuth2 client_credentials
// token from .env (TOKEN_URI / CLIENT_ID / CLIENT_SECRET); the FT_ADMIN_SECRET
// env var is sent as the x-ft-admin-secret admin gate. Review flags
// (--admin-review XOR --fast-track, --overwrite) apply to the whole submission.

program
  .command('update-variations')
  .description('Submit reviewed variation suggestions from a CSV to the cloud Variations Service (admin)')
  .requiredOption('-s, --suggestions <path>', 'Path to the variations suggestions CSV file')
  .option('--admin-review', 'Flag the whole submission as admin-review')
  .option('--fast-track', 'Flag the whole submission as fast-track (mutually exclusive with --admin-review)')
  .option('--overwrite', 'Allow overwriting existing canonical entries')
  .option('--chunk-size <n>', 'Suggestions per request (default 1000)')
  .action(
    async (opts: {
      suggestions: string;
      adminReview?: boolean;
      fastTrack?: boolean;
      overwrite?: boolean;
      chunkSize?: string;
    }) => {
      try {
        const chunkSize = opts.chunkSize === undefined ? undefined : Number.parseInt(opts.chunkSize, 10);
        if (chunkSize !== undefined && (!Number.isInteger(chunkSize) || chunkSize <= 0)) {
          throw new Error(`--chunk-size must be a positive integer, got '${opts.chunkSize}'`);
        }

        const csv = await readFile(resolve(opts.suggestions), 'utf-8');
        const { items, recognizedColumns, skippedColumns } = parseVariationsCsv(csv);
        if (skippedColumns.length) {
          console.error(`Ignoring unrecognized columns: ${skippedColumns.join(', ')}`);
        }
        console.log(`Parsed ${items.length} suggestion(s) from columns: ${recognizedColumns.join(', ')}.`);

        if ((opts.adminReview || opts.fastTrack) && !process.env.FT_ADMIN_SECRET) {
          console.error(
            'Warning: admin-review / fast-track submissions need FT_ADMIN_SECRET in your .env to land; the service may reject them otherwise.',
          );
        }

        const bearerToken = await mintOAuth2ClientCredentialsToken();
        const result = await updateVariationsViaService({
          items,
          fromCli: true,
          adminReview: opts.adminReview,
          fastTrack: opts.fastTrack,
          overwrite: opts.overwrite,
          ...(bearerToken ? { bearerToken } : {}),
          ...(process.env.FT_ADMIN_SECRET ? { adminSecret: process.env.FT_ADMIN_SECRET } : {}),
          ...(chunkSize ? { chunkSize } : {}),
        });

        console.log(`Submitted ${result.submitted} suggestion(s) in ${result.chunks} chunk(s).`);
        if (Object.keys(result.stats).length) {
          console.log('Stats:');
          Object.entries(result.stats).forEach(([key, value]) => console.log(`  • ${key}: ${value}`));
        }
        if (result.permissionDenied || result.validationFailed || result.corrections) {
          console.error(
            `Not everything landed as submitted — permission-denied: ${result.permissionDenied}, ` +
              `validation-failed: ${result.validationFailed}, corrections: ${result.corrections}. ` +
              'Review before assuming the run was clean.',
          );
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    },
  );

// ── Metadata Report subcommand group ──
//
// Utilities for working with metadata reports outside of a full
// certification run. Today this is just the `adapt` subcommand,
// which fills in the top-level resources[] block on DD 2.0/2.1
// reports so they can be loaded by tools that expect a DD 2.2-shaped
// report (notably the Reference Server).

const metadataReportCmd = program
  .command('metadata-report')
  .description('Utilities for working with metadata report JSON files');

metadataReportCmd
  .command('adapt')
  .description(
    'Synthesize the top-level resources[] block on a DD 2.0/2.1 metadata report so it can be loaded by tools that expect a DD 2.2-shaped report. Idempotent — DD 2.2+ reports pass through unchanged.'
  )
  .requiredOption('--in <path>', 'Input metadata report JSON file')
  .requiredOption('--out <path>', 'Output path for the adapted report')
  .option('--pretty', 'Pretty-print the output JSON (2-space indent)')
  .action(async (opts: { in: string; out: string; pretty?: boolean }) => {
    try {
      const inPath = resolve(opts.in);
      const outPath = resolve(opts.out);

      const raw = await readFile(inPath, 'utf-8');
      const parsed = JSON.parse(raw) as MetadataReport;
      const adapted = synthesizeResourcesFromFields(parsed);

      const output = opts.pretty
        ? JSON.stringify(adapted, null, 2)
        : JSON.stringify(adapted);

      await writeFile(outPath, output, 'utf-8');

      const wasNoOp = adapted === parsed;
      const resourceCount = adapted.resources.length;
      const verb = wasNoOp ? 'passed through' : 'adapted';
      console.error(
        `${verb} ${inPath} → ${outPath} (${resourceCount} resources${wasNoOp ? ', already populated' : ', synthesized'})`
      );
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  });

// ── Schema Subcommand (per-step util: generate a JSON Schema / validate a payload against it) ──

/** Read raw text from a file path, or from stdin when the path is "-". */
const readTextInput = async (path: string): Promise<string> => {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }
  return readFile(resolve(path), 'utf-8');
};

/** Read a JSON value from a file path, or from stdin when the path is "-". */
const readJsonInput = async (path: string): Promise<unknown> => JSON.parse(await readTextInput(path));

/** Write a JSON artifact to stdout when outputDir is "-", else to <outputDir>/<filename> (created if missing). */
const writeArtifact = async (outputDir: string, filename: string, data: unknown): Promise<string> => {
  const json = JSON.stringify(data, null, 2);
  if (outputDir === '-') {
    process.stdout.write(`${json}\n`);
    return '(stdout)';
  }
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, filename);
  await writeFile(file, json);
  return file;
};

const schemaCmd = program.command('schema').description('Data Dictionary / RESO Common Format JSON Schema tools');

schemaCmd
  .command('validate')
  .description("Validate a payload against a metadata report's JSON Schema")
  .requiredOption('-m, --metadata <file>', 'Metadata report JSON (metadata-report.json), or "-" for stdin')
  .requiredOption('-p, --payload <file>', 'Payload JSON — an OData collection { value: [...] } or a single record, or "-" for stdin')
  .option('-v, --version <version>', 'DD version for the schema context (e.g. 2.0)')
  .option('-r, --resource <name>', 'Resource name (else inferred from the payload @odata.context)')
  .option('-s, --settings <file>', 'schema-validation-settings.json (else ./ then the pre-baked copy)')
  .option('-a, --additional-properties', 'Allow fields not present in the metadata (default: reject them)')
  .option('--output-dir <path>', 'Directory for the report (created if missing); "-" for stdout', '.')
  .action(async (opts: { metadata: string; payload: string; version?: string; resource?: string; settings?: string; additionalProperties?: boolean; outputDir: string }) => {
    try {
      const validationConfig = await loadSettings(opts.settings);
      const metadataReportJson = await readJsonInput(opts.metadata);
      const jsonPayload = await readJsonInput(opts.payload);
      const { totalErrors, report } = await validateSchemaPayload({
        metadataReportJson,
        jsonPayload,
        resourceName: opts.resource,
        version: opts.version,
        validationConfig,
        additionalProperties: opts.additionalProperties,
      });
      const dest = await writeArtifact(opts.outputDir, 'schema-validation-report.json', report);
      process.stderr.write(
        totalErrors === 0
          ? `PASS — 0 schema validation errors (report: ${dest})\n`
          : `FAIL — ${totalErrors} schema validation error(s) (report: ${dest})\n`
      );
      process.exitCode = totalErrors > 0 ? 1 : 0;
    } catch (err) {
      process.stderr.write(`schema validate: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

schemaCmd
  .command('generate')
  .description('Generate a JSON Schema from a metadata report')
  .requiredOption('-m, --metadata <file>', 'Metadata report JSON, or "-" for stdin')
  .option('-a, --additional-properties', 'Allow fields not present in the metadata')
  .option('--output-dir <path>', 'Directory for the schema (created if missing); "-" for stdout', '.')
  .action(async (opts: { metadata: string; additionalProperties?: boolean; outputDir: string }) => {
    try {
      const metadataReportJson = await readJsonInput(opts.metadata);
      const schema = await generateSchemaFromReport({ metadataReportJson, additionalProperties: opts.additionalProperties });
      const dest = await writeArtifact(opts.outputDir, 'schema.json', schema);
      process.stderr.write(`Schema generated (${dest})\n`);
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`schema generate: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

// ── Metadata Subcommand (per-step util: validate OData CSDL + convert it to a RESO Format metadata report) ──
// The first cert step, and the one that gates the rest: the metadata defines the OData entities and structure,
// so if it is invalid nothing downstream (schema, variations, sampling) is meaningful. Exit code carries the
// verdict (0 valid / 1 invalid / 2 IO); the report goes to the artifact, the human summary to stderr.

program
  .command('metadata')
  .description('Metadata step — validate OData CSDL/EDMX (XSD + semantic) and convert it to a RESO Format metadata report')
  .requiredOption('-m, --metadata <path>', 'Path to the CSDL/EDMX XML metadata file, or "-" for stdin')
  .option('-v, --version <ddVersion>', 'DD version stamped into the generated report', '2.0')
  .option('--odata-version <version>', 'OData version override for validation (4.0 | 4.01); auto-detected when omitted')
  .option('--output-dir <path>', 'Directory for metadata-report.json (created if missing); "-" for stdout', '.')
  .option('--no-report', 'Validate only; do not generate the metadata report')
  .action(async (opts: { metadata: string; version: string; odataVersion?: string; outputDir: string; report: boolean }) => {
    try {
      const metadataXml = await readTextInput(opts.metadata);
      const result = await runMetadataStep({
        metadataXml,
        ddVersion: opts.version,
        odataVersion: opts.odataVersion as ODataVersion | undefined,
        emitReport: opts.report,
      });
      process.stderr.write(`metadata: ${result.summary}\n`);
      for (const err of result.errors) process.stderr.write(`  - ${err}\n`);
      if (opts.report && result.report) {
        const dest = await writeArtifact(opts.outputDir, 'metadata-report.json', result.report);
        const { resources, fields, lookups } = result.report;
        process.stderr.write(
          `metadata: report → ${dest} (${resources.length} resources, ${fields.length.toLocaleString()} fields, ${lookups.length.toLocaleString()} lookups)\n`,
        );
      }
      process.exitCode = result.passed ? 0 : 1;
    } catch (err) {
      process.stderr.write(`metadata: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

// ── Replicate Subcommand (per-step util: pull data from a live endpoint using a replication strategy) ──
// Wraps the legacy replication engine. Four strategies (TopAndSkip / TimestampAsc / TimestampDesc / NextLink);
// single-resource (--resource) or report-driven (--metadata) scope; writes a data-availability report (and,
// with --save-results, the raw pages) under --output-dir. Auth is pre-resolved to a bearer token here (the
// engine's own OAuth path hard-exits on failure), and the run uses throwOnError so a failure is our exit code.

program
  .command('replicate')
  .description('Replicate data from a resource (or a whole metadata report) using an OData replication strategy')
  .requiredOption('-u, --url <uri>', 'OData service root URI (no resource name or query)')
  .requiredOption('-s, --strategy <strategy>', `Replication strategy: ${REPLICATION_STRATEGY_VALUES.join(' | ')}`)
  .option('-r, --resource <name>', 'Resource to replicate (single-resource mode)')
  .option('-m, --metadata <path>', 'Metadata report JSON — replicate every resource in it (report-driven mode)')
  .option('-x, --expansions <list>', 'Comma-separated expansions, e.g. Media,OpenHouse (single-resource mode)')
  .option('-f, --filter <expr>', 'OData $filter expression')
  .option('-t, --top <n>', 'OData $top page size')
  .option('--orderby <expr>', 'OData $orderby expression')
  .option('--max-page-size <n>', 'odata.maxpagesize preference (NextLink strategy)')
  .option('-l, --limit <n>', 'Stop after this many total records')
  .option('--output-dir <dir>', 'Directory for the report and any saved pages (created if missing)', '.')
  .option('-v, --version <ddVersion>', 'Data Dictionary version', '2.0')
  .option('--save-results', 'Also write every raw response page to disk')
  .option('--json-schema-validation', 'Validate each payload against a schema generated from the metadata')
  .option('--strict', 'Fail on schema-validation errors')
  .option('--originating-system-name <v>', 'Append OriginatingSystemName eq <v> to every query')
  .option('--originating-system-id <v>', 'Append OriginatingSystemID eq <v> to every query')
  .option('--auth-token <token>', 'Bearer token for authorization')
  .option('--client-id <id>', 'OAuth2 client_id (with --client-secret and --token-url)')
  .option('--client-secret <secret>', 'OAuth2 client_secret')
  .option('--token-url <url>', 'OAuth2 token endpoint URL')
  .action(
    async (opts: {
      url: string;
      strategy: string;
      resource?: string;
      metadata?: string;
      expansions?: string;
      filter?: string;
      top?: string;
      orderby?: string;
      maxPageSize?: string;
      limit?: string;
      outputDir: string;
      version: string;
      saveResults?: boolean;
      jsonSchemaValidation?: boolean;
      strict?: boolean;
      originatingSystemName?: string;
      originatingSystemId?: string;
      authToken?: string;
      clientId?: string;
      clientSecret?: string;
      tokenUrl?: string;
    }) => {
      const toInt = (v?: string): number | undefined => (v == null ? undefined : Number.parseInt(v, 10));
      try {
        const auth = resolveCliAuth({
          authToken: opts.authToken,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          tokenUrl: opts.tokenUrl,
        });
        const bearerToken = await resolveAuthToken(auth);
        const result = await runReplicate({
          serviceRootUri: opts.url,
          strategy: opts.strategy,
          bearerToken,
          resourceName: opts.resource,
          expansions: opts.expansions,
          metadataReportPath: opts.metadata ? resolve(opts.metadata) : undefined,
          filter: opts.filter,
          top: toInt(opts.top),
          orderby: opts.orderby,
          maxPageSize: toInt(opts.maxPageSize),
          limit: toInt(opts.limit),
          outputPath: opts.outputDir,
          version: opts.version,
          shouldGenerateReports: !!opts.metadata,
          jsonSchemaValidation: opts.jsonSchemaValidation || opts.strict,
          strictMode: opts.strict,
          shouldSaveResults: opts.saveResults,
          originatingSystemName: opts.originatingSystemName,
          originatingSystemId: opts.originatingSystemId,
          onProgress: (info: Record<string, unknown>) => {
            const n = Number(info.totalRecordsFetched ?? 0);
            process.stderr.write(`replicate ${opts.strategy}: ${n.toLocaleString()} records\r`);
          },
        });
        process.stderr.write(
          `\nreplicate: ${result.strategy} complete — ${result.stats.totalRecordsFetched.toLocaleString()} records, ` +
            `${result.stats.totalRequests.toLocaleString()} requests → ${result.outputDir}\n`,
        );
        process.exitCode = 0;
      } catch (err) {
        process.stderr.write(`\nreplicate: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      }
    },
  );

program.parse();
