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

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { startMockServer, stopMockServer } from '../add-edit/mock/server.js';
import { startMockEntityEventServer, stopMockEntityEventServer } from '../entity-event/mock/server.js';
import { loadConfigFile, configEntryToAddEdit, configEntryToEntityEvent, configEntryToCore } from '../sdk/config.js';
import type { AddEditConfig, EntityEventConfig, CoreConfig, DDConfig, PipelineResult } from '../sdk/types.js';
import { loadDotEnv, resolveCliAuth } from './auth.js';
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

/** Determine exit code from pipeline results. */
const resolveExitCode = (results: ReadonlyArray<PipelineResult>): number =>
  results.some(r => r.status === 'failed') ? 1 : 0;

// ── Load .env early ──

loadDotEnv();

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
  .description('Data Dictionary 1.7/2.0 compliance testing')
  .requiredOption('--url <url>', 'Server base URL')
  .option('--dd-version <version>', 'DD version: 1.7 or 2.0', '2.0')
  .option('--limit <n>', 'Max records to replicate per resource', '100000')
  .option('--strict', 'Strict mode: fail on variations and enforce JSON schema validation');

addAuthOptions(ddCmd);
addOutputOptions(ddCmd);

ddCmd.action(
  async (opts: {
    url: string;
    ddVersion: string;
    limit: string;
    strict?: boolean;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    try {
      const ddVersion = opts.ddVersion as '1.7' | '2.0';
      if (ddVersion !== '1.7' && ddVersion !== '2.0') {
        throw new Error(`Invalid version "${opts.ddVersion}". Must be "1.7" or "2.0".`);
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
        server: { url: opts.url, auth },
        version: ddVersion,
        limit: Number(opts.limit),
        strictMode: opts.strict,
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

program.parse();
