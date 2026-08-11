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
import {
  computeVariationsViaService,
  updateVariationsViaService,
  parseVariationsCsv,
  findVariations,
  DEFAULT_FUZZINESS,
  DEFAULT_DD_VERSION,
  VARIATIONS_REPORT_FILENAME,
  type VariationsServiceReport,
} from '../variations/index.js';
import { validateSchemaPayload, generateSchemaFromReport, loadSettings } from './schema-command.js';
import { runMetadataStep } from './metadata-command.js';
import { fetchMetadataReportFromServer } from '../sdk/metadata-source.js';
import { runRcf } from './rcf-command.js';
import type { ODataVersion } from '../xsd/validate-csdl.js';
import { runReplicate, REPLICATION_STRATEGY_VALUES } from './replicate-command.js';
import { resolveAuthToken } from '../test-runner/auth.js';
import { CURRENT_DD_VERSION, CERTIFIABLE_DD_VERSIONS, isCertifiableDDVersion, normalizeDDVersion } from '../sdk/dd-versions.js';
import { resolveRenderMode, runWithProgress, runConfigEntries } from './render.js';

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

/** Determine exit code from pipeline results. A run cut short by its total-timeout budget
 *  is `incomplete` — not a clean pass, so it exits non-zero (like a failure) rather than
 *  letting a truncated run read as success; the report distinguishes incomplete from failed. */
const resolveExitCode = (results: ReadonlyArray<PipelineResult>): number =>
  results.some(r => r.status === 'failed' || r.status === 'incomplete') ? 1 : 0;

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

// ── Find Variations Subcommand (per-step util: DD variations review via the v2 Variations Service) ──
//
// The cert variations step: compute a metadata report's DD variations through the v2 Variations
// Service (`/compute`) and emit the canonical data-dictionary-variations.json. The metadata source
// is either a local report (--metadata, or "-" for stdin) or a live endpoint (--from-server --url,
// whose $metadata is fetched + serialized in memory). `--output-dir -` prints the raw report to
// stdout instead of writing the artifact. computeVariationsViaService is the engine; this command
// is the cert wrapper around it (source resolution + canonical artifact + run summary).
//
// Two independent auth contexts: the provider-endpoint auth flags (--auth-token / --client-id …)
// authenticate the --from-server $metadata fetch, while the /compute call authenticates to the
// RESO Variations Service with .env service credentials (minted inside the service when omitted).

/** Count non-empty variation categories in a service report, for the run summary. */
const summarizeVariations = (report: VariationsServiceReport): { total: number; detail: string } => {
  const counts = Object.entries(report.variations ?? {}).map(
    ([key, value]) => [key, Array.isArray(value) ? value.length : 0] as const,
  );
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const detail = counts
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${key}: ${n}`)
    .join(', ');
  return { total, detail };
};

program
  .command('find-variations')
  .description('DD variations review for a metadata report via the v2 Variations Service')
  .option('-m, --metadata <file>', 'Metadata report JSON (metadata-report.json), or "-" for stdin')
  .option('--from-server', 'Fetch metadata from a live OData endpoint instead of a file (requires --url)')
  .option('-u, --url <url>', 'OData service root URL (with --from-server)')
  .option('-f, --fuzziness <float>', `Fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`, String(DEFAULT_FUZZINESS))
  .option('-v, --version <version>', `Data Dictionary version (default ${DEFAULT_DD_VERSION})`, DEFAULT_DD_VERSION)
  .option('--output-dir <path>', 'Directory for data-dictionary-variations.json (created if missing); "-" for stdout', '.')
  .option('--auth-token <token>', 'Bearer token for the --from-server endpoint')
  .option('--client-id <id>', 'OAuth2 client_id for the --from-server endpoint (with --client-secret and --token-url)')
  .option('--client-secret <secret>', 'OAuth2 client_secret for the --from-server endpoint')
  .option('--token-url <url>', 'OAuth2 token endpoint URL for the --from-server endpoint')
  .action(
    async (opts: {
      metadata?: string;
      fromServer?: boolean;
      url?: string;
      fuzziness: string;
      version: string;
      outputDir: string;
      authToken?: string;
      clientId?: string;
      clientSecret?: string;
      tokenUrl?: string;
    }) => {
      try {
        // Exactly one metadata source.
        if (opts.fromServer && opts.metadata) {
          throw new Error('--metadata and --from-server are mutually exclusive. Choose one metadata source.');
        }
        if (!opts.fromServer && !opts.metadata) {
          throw new Error('Provide a metadata source: --metadata <file> (or "-" for stdin), or --from-server --url <url>.');
        }

        const fuzziness = Number.parseFloat(opts.fuzziness);
        if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) {
          throw new Error(`--fuzziness must be a number in [0, 1], got '${opts.fuzziness}'`);
        }
        const { version } = opts;

        // Resolve the metadata report to an in-memory object. --from-server fetches the endpoint's
        // $metadata (authenticated with the provider-endpoint auth flags) and serializes it;
        // --metadata reads a local report (or stdin). No temporary file is written either way.
        const resolveMetadataReport = async (): Promise<unknown> => {
          if (opts.fromServer) {
            const url = opts.url;
            if (!url) throw new Error('--from-server requires --url <url> (the OData service root).');
            const bearerToken = await resolveAuthToken(
              resolveCliAuth({
                authToken: opts.authToken,
                clientId: opts.clientId,
                clientSecret: opts.clientSecret,
                tokenUrl: opts.tokenUrl,
              }),
            );
            return fetchMetadataReportFromServer({ url, bearerToken, version });
          }
          const metadataPath = opts.metadata;
          if (!metadataPath) {
            throw new Error('Provide a metadata source: --metadata <file> (or "-" for stdin), or --from-server --url <url>.');
          }
          return readJsonInput(metadataPath);
        };
        const metadataReportJson = await resolveMetadataReport();

        // The /compute token authenticates to the RESO Variations Service; minted from .env service
        // credentials. When absent, the service mints its own (CERT_AUTH_API_*) or reports how to auth.
        const computeToken = await mintOAuth2ClientCredentialsToken();

        if (opts.outputDir === '-') {
          // Raw report to stdout — no canonical artifact written.
          const report = await computeVariationsViaService({
            metadataReportJson,
            version,
            fuzziness,
            fromCli: true,
            ...(computeToken ? { bearerToken: computeToken } : {}),
          });
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const report = await findVariations({
            metadataReportJson,
            version,
            fuzziness,
            fromCli: true,
            outputPath: resolve(opts.outputDir),
            ...(computeToken ? { bearerToken: computeToken } : {}),
          });
          const { total, detail } = summarizeVariations(report);
          process.stderr.write(
            total > 0
              ? `find-variations: ${total} variation(s) [${detail}] → ${resolve(opts.outputDir, VARIATIONS_REPORT_FILENAME)}\n`
              : 'find-variations: no variations found\n',
          );
        }
        process.exitCode = 0;
      } catch (err) {
        process.stderr.write(`find-variations: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      }
    },
  );

// ── RCF Subcommand (per-step util: RESO Common Format certification) ──
// RCF providers deliver data, not a schema — a .json/.zip/directory of payloads or records. This
// streams the input, optionally schema-validates it against the DD (strict / -a), reverse-infers a
// DD-2.0 metadata report + a data-availability report, and runs the variations service on the
// inferred report — the same two artifacts as a DD 2.0 run, plus the variations report.

program
  .command('rcf')
  .description('RESO Common Format — infer a DD-2.0 metadata report from RCF data and run variations')
  .requiredOption('-i, --input <path>', 'RCF input: a .json file, a .zip, or a directory of payloads/records')
  .option('-v, --version <ver>', 'DD version (default: from the payload @reso.context, else 2.0)')
  .option('-f, --fuzziness <float>', `Variations fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`, String(DEFAULT_FUZZINESS))
  .option('--output-dir <path>', 'Directory for the reports (created if missing)', '.')
  .option('--schema-validate', 'Schema-validate each payload against the DD before inferring')
  .option('-a, --additional-properties', 'Allow fields not in the DD (extensions) during schema validation')
  .option('--strict', 'Fail fast on the first schema-validation error (with --schema-validate)')
  .option('--no-variations', 'Skip the variations service call (infer + reports only)')
  .action(
    async (opts: {
      input: string;
      version?: string;
      fuzziness: string;
      outputDir: string;
      schemaValidate?: boolean;
      additionalProperties?: boolean;
      strict?: boolean;
      variations: boolean;
    }) => {
      try {
        const fuzziness = Number.parseFloat(opts.fuzziness);
        if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) {
          throw new Error(`--fuzziness must be a number in [0, 1], got '${opts.fuzziness}'`);
        }
        // The /compute token for the variations service (from .env; the service mints its own if absent).
        const bearerToken = opts.variations ? await mintOAuth2ClientCredentialsToken() : undefined;

        const result = await runRcf({
          input: resolve(opts.input),
          version: opts.version,
          fuzziness,
          additionalProperties: opts.additionalProperties,
          strict: opts.strict,
          schemaValidate: opts.schemaValidate,
          generatedOn: new Date().toISOString(),
          runVariations: opts.variations,
          ...(bearerToken ? { bearerToken } : {}),
        });

        const dir = resolve(opts.outputDir);
        await mkdir(dir, { recursive: true });
        await writeFile(resolve(dir, 'metadata-report.json'), JSON.stringify(result.metadataReport, null, 2));
        await writeFile(resolve(dir, 'data-availability-report.json'), JSON.stringify(result.dataAvailabilityReport, null, 2));
        if (result.variations) {
          await writeFile(resolve(dir, VARIATIONS_REPORT_FILENAME), JSON.stringify(result.variations, null, 2));
        }

        const s = result.stats;
        process.stderr.write(
          `rcf: DD${result.version} — ${s.totalRecords.toLocaleString()} records → ${s.resources} resources, ` +
            `${s.fields.toLocaleString()} fields, ${s.lookups.toLocaleString()} lookups` +
            (opts.schemaValidate ? `; ${s.schemaErrors} schema error(s)` : '') +
            (s.variationsTotal !== undefined ? `; ${s.variationsTotal} variation(s)` : '') +
            ` → ${dir}\n`,
        );
        if (result.variationsError) {
          process.stderr.write(`rcf: variations skipped — ${result.variationsError} (reports still written)\n`);
        }
        // Non-zero when variations was requested but degraded, so a partial run never reads as clean success.
        process.exitCode = s.schemaErrors > 0 ? 1 : result.variationsError ? 2 : 0;
      } catch (err) {
        const schemaFailure = (err as { schemaFailure?: boolean }).schemaFailure === true;
        process.stderr.write(`rcf: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = schemaFailure ? 1 : 2;
      }
    },
  );

program.parse();
