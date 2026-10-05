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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { Command } from 'commander';
import { startMockServer, stopMockServer } from '../add-edit/mock/server.js';
import { startMockEntityEventServer, stopMockEntityEventServer } from '../entity-event/mock/server.js';
import { synthesizeResourcesFromFields } from '../metadata/index.js';
import { lockHolderOf } from '../sdk/common.js';
import { configEntryToAddEdit, configEntryToCore, configEntryToDD, configEntryToEntityEvent, loadConfigFile } from '../sdk/config.js';
import { CURRENT_CORE_VERSION, SUPPORTED_CORE_VERSIONS, isCoreVersion } from '../sdk/core-versions.js';
import { CERTIFIABLE_DD_VERSIONS, CURRENT_DD_VERSION, isCertifiableDDVersion, normalizeDDVersion } from '../sdk/dd-versions.js';
import { fetchMetadataReportFromServer } from '../sdk/metadata-source.js';
import type { AddEditConfig, CoreConfig, DDConfig, EntityEventConfig, PipelineResult } from '../sdk/types.js';
import { resolveAuthToken } from '../test-runner/auth.js';
import {
  DEFAULT_DD_VERSION,
  DEFAULT_FUZZINESS,
  type EndorsementReviewStatus,
  VARIATIONS_REPORT_FILENAME,
  type VariationReviewElementType,
  type VariationsServiceReport,
  computeVariationsViaService,
  findVariations,
  listEndorsementsByReviewStatusViaService,
  listMyEndorsementsViaService,
  listVariationReviewItemsViaService,
  parseDecisionsCsv,
  parseVariationsCsv,
  updateVariationsViaService
} from '../variations/index.js';
import { submitVariationsReportViaService } from '../variations/submit.js';
import type { ODataVersion } from '../xsd/validate-csdl.js';
import { mintOAuth2ClientCredentialsToken, resolveCliAuth } from './auth.js';
import { formatPlan, planDecisionPush } from './decisions-command.js';
import { runMetadataStep } from './metadata-command.js';
import { resolveRcfExitCode, runRcf } from './rcf-command.js';
import { resolveRenderMode, runConfigEntries, runWithProgress } from './render.js';
import { REPLICATION_STRATEGY_VALUES, runReplicate } from './replicate-command.js';
import { generateSchemaFromReport, loadSettings, validateSchemaPayload } from './schema-command.js';
import { addAuthOptions, addOutputOptions } from './shared-options.js';
import {
  duplicateVariationKeys,
  formatEndorsementStatusTable,
  formatProvenance,
  formatReviewItemsTable
} from './variations-review-command.js';

/** The CLI's own version, from package.json — the single source, so `reso-cert -V` never drifts from the
 *  published version (dist mirrors src under `tsc`, so `../../package.json` resolves in both dev and dist). */
const { version: CLI_VERSION } = createRequire(import.meta.url)('../../package.json') as { readonly version: string };

/** A run's label: the three identifiers, each named.
 *
 *  The terse form was `${entry.recipientUoi}-${entry.providerUsi}`, which is a two-token dash
 *  string -- exactly like the output path's `{providerUoi}-{providerUsi}` segment, but holding
 *  DIFFERENT fields in the OPPOSITE order. Reading one as the other is an easy mistake and was
 *  made during the investigation that produced this. Naming each value removes the ambiguity.
 *
 *  A missing identifier shows as `<name>` rather than being omitted, so the line always has the
 *  same three slots and a gap is visible as a gap. That matches what the output path does, so a
 *  log line and a directory name can be read against each other. */
const runLabel = (entry: { readonly providerUsi?: string; readonly recipientUoi?: string }, providerUoi: string | undefined): string => {
  const show = (value: string | undefined, name: string): string => (value?.trim() ? value : `<${name}>`);
  return [
    `ProviderUoi: ${show(providerUoi, 'providerUoi')}`,
    `ProviderUsi: ${show(entry.providerUsi, 'providerUsi')}`,
    `RecipientUoi: ${show(entry.recipientUoi, 'recipientUoi')}`
  ].join(', ');
};

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

// `-V` / `--version` (Commander's default flags) report the CLI's own version. Per-command spec versions use
// their own explicit flags (`core --spec-version`, `dd --dd-version`) so they never collide with this.
program.name('reso-cert').description('RESO certification compliance testing tools').version(CLI_VERSION);

// ── Shared option builders live in ./shared-options.ts ──
// addAuthOptions (OAuth2/bearer cluster) and addOutputOptions (compliance-report
// output bundle) are imported above, alongside addServerUrlOption / addReportDirOption
// for standardizing the universal flags across commands.

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
        const metadataXml = opts.metadata ? await readFile(resolve(opts.metadata), 'utf-8') : await loadDefaultMetadata();
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
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return {
            config,
            label: entry.description ?? runLabel(entry, configFile.providerUoi)
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
          tokenUrl: opts.tokenUrl
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
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {})
          }
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
  }
);

// ── EntityEvent Subcommand ──

const entityEventCmd = program
  .command('entity-event')
  .description('RCP-027 EntityEvent change tracking compliance testing')
  .option('--url <url>', 'Service root URL')
  .option('--config <path>', 'Path to config file (mutually exclusive with --url)')
  .option('--mode <mode>', "Testing mode: observe or full (default: observe, or the config entry's entityEventOptions.mode)")
  .option('--writable-resource <name>', 'Canary resource for full mode', 'Property')
  .option('--payloads-dir <dir>', 'Payloads directory for full mode canary writes')
  .option('--max-events <n>', 'Max EntityEvent records to validate (default: 1000)')
  .option('--batch-size <n>', 'Keys per batch fetch request (default: 100)')
  .option('--poll-interval <ms>', 'Time between incremental sync checks (ms) (default: 5000)')
  .option('--poll-timeout <ms>', 'Max time to wait for new events (ms) (default: 30000)')
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

      // Flags apply only when given: a config entry's entityEventOptions block is the next source, then the defaults.
      const mode = opts.mode as 'observe' | 'full' | undefined;
      if (mode !== undefined && mode !== 'observe' && mode !== 'full') {
        throw new Error(`Invalid mode "${opts.mode}". Must be "observe" or "full".`);
      }
      const numFlag = (v: string | undefined, fallback: number): number => (v !== undefined ? Number(v) : fallback);

      const renderMode = resolveRenderMode(opts);

      // Start mock server if requested
      if (opts.mock) {
        const metadataXml = opts.metadata ? await readFile(resolve(opts.metadata), 'utf-8') : await loadDefaultMetadata();
        const mock = await startMockEntityEventServer({
          metadataXml,
          canaryResource: opts.writableResource,
          port: DEFAULT_MOCK_PORT
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
            mode: mode ?? baseConfig.mode ?? 'observe',
            maxEvents: numFlag(opts.maxEvents, baseConfig.maxEvents ?? 1000),
            batchSize: numFlag(opts.batchSize, baseConfig.batchSize ?? 100),
            pollInterval: numFlag(opts.pollInterval, baseConfig.pollInterval ?? 5000),
            pollTimeout: numFlag(opts.pollTimeout, baseConfig.pollTimeout ?? 30000),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return {
            config,
            label: entry.description ?? runLabel(entry, configFile.providerUoi)
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
          tokenUrl: opts.tokenUrl
        });

        const config: EntityEventConfig = {
          endorsement: 'entity-event',
          server: { url: serverUrl, auth },
          mode: mode ?? 'observe',
          writableResource: opts.writableResource,
          payloadsDir: opts.payloadsDir ? resolve(opts.payloadsDir) : undefined,
          maxEvents: numFlag(opts.maxEvents, 1000),
          batchSize: numFlag(opts.batchSize, 100),
          pollInterval: numFlag(opts.pollInterval, 5000),
          pollTimeout: numFlag(opts.pollTimeout, 30000),
          options: {
            skipHealthCheck: opts.mock,
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {})
          }
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
  }
);

// ── Web API Core Subcommand ──

const coreCmd = program
  .command('core')
  .description('Web API Core 2.0.0/2.1.0 compliance testing')
  .option('--url <url>', 'Server base URL (mutually exclusive with --config)')
  .option('--config <path>', 'Path to a config file — runs every entry (mutually exclusive with --url)')
  .option('--resources <list>', 'Comma-separated resource names (default: well-known list)')
  // `--spec-version` (not `--version`, which is reserved for the program's own `-V`). Defaults to the current
  // minor, so a plain `reso-cert core --url …` certifies the latest Core without the caller passing a version.
  .option('--spec-version <version>', `Web API Core spec version: ${SUPPORTED_CORE_VERSIONS.join(' or ')}`, CURRENT_CORE_VERSION)
  .option(
    '--enum-mode <mode>',
    "Enum mode: auto, string, collections, or isflags (default: the config entry's coreOptions.enumMode, else auto-detect)"
  )
  .option('--full-coverage', 'Fail if any data type category has no coverage across all resources')
  .option('--originating-system-name <v>', 'Scope resource queries to OriginatingSystemName eq <v> (multi-tenant providers)')
  .option('--originating-system-id <v>', 'Scope resource queries to OriginatingSystemID eq <v> (used when no name; OSN takes precedence)')
  .option(
    '--prefer-fields <list>',
    'Comma-separated field-selection preferences, Resource.Field or bare Field (e.g. Office.FeedTypes). Re-orders ' +
      'the ranked candidates; auto-selection decides everything else. Overrides coreOptions.preferFields from a config.'
  );

addAuthOptions(coreCmd);
addOutputOptions(coreCmd);

coreCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    resources?: string;
    specVersion: string;
    enumMode?: string;
    fullCoverage?: boolean;
    originatingSystemName?: string;
    originatingSystemId?: string;
    preferFields?: string;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    try {
      if (opts.url && opts.config) {
        throw new Error('--url and --config are mutually exclusive. Use one or the other.');
      }
      if (!opts.url && !opts.config) {
        throw new Error('Provide --url or --config.');
      }

      if (!isCoreVersion(opts.specVersion)) {
        throw new Error(`Invalid --spec-version "${opts.specVersion}". Must be one of: ${SUPPORTED_CORE_VERSIONS.join(', ')}.`);
      }
      const specVersion = opts.specVersion;

      // Flags apply only when given: a config entry's coreOptions block is the next source, then auto-detect.
      const enumModeFlag = opts.enumMode as 'auto' | 'isflags' | 'collections' | 'string' | undefined;
      // A preference list from the flag replaces the config's rather than merging: an override the operator
      // typed should be exactly what runs, with no invisible union from the file.
      const preferFieldsFlag: ReadonlyArray<string> | undefined =
        typeof opts.preferFields === 'string' && opts.preferFields.trim().length > 0
          ? opts.preferFields
              .split(',')
              .map((v: string) => v.trim())
              .filter((v: string) => v.length > 0)
          : undefined;
      if (enumModeFlag !== undefined && !['auto', 'isflags', 'collections', 'string'].includes(enumModeFlag)) {
        throw new Error(`Invalid enum mode "${opts.enumMode}". Must be "auto", "string", "collections", or "isflags".`);
      }

      const renderMode = resolveRenderMode(opts);
      const resources = opts.resources?.split(',').map(r => r.trim());

      let results: ReadonlyArray<PipelineResult>;

      if (opts.config) {
        // Config-file mode — run every entry. The entry supplies server/auth/version/OSN (reso-certification-utils
        // format); CLI flags apply run-level knobs (resources / enum-mode / coverage) and can override auth/OSN.
        const configFile = await loadConfigFile(resolve(opts.config));
        const authFlags = { authToken: opts.authToken, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl };

        const entries = configFile.configs.map(entry => {
          const baseConfig = configEntryToCore(entry, configFile.providerUoi);
          const auth = resolveCliAuth(authFlags, baseConfig.server.auth);

          const config: CoreConfig = {
            ...baseConfig,
            server: { ...baseConfig.server, auth },
            enumMode: enumModeFlag ?? baseConfig.enumMode ?? 'auto',
            ...((resources ?? baseConfig.resources) ? { resources: resources ?? baseConfig.resources } : {}),
            ...(opts.fullCoverage || baseConfig.fullCoverage ? { fullCoverage: true } : {}),
            ...(opts.originatingSystemName ? { originatingSystemName: opts.originatingSystemName } : {}),
            ...(opts.originatingSystemId ? { originatingSystemId: opts.originatingSystemId } : {}),
            ...((preferFieldsFlag ?? baseConfig.preferFields) ? { preferFields: preferFieldsFlag ?? baseConfig.preferFields } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return { config, label: entry.description ?? runLabel(entry, configFile.providerUoi) };
        });

        results = await runConfigEntries(entries, renderMode);
      } else {
        const auth = resolveCliAuth({
          authToken: opts.authToken,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          tokenUrl: opts.tokenUrl
        });

        const config: CoreConfig = {
          endorsement: 'core',
          server: { url: opts.url!, auth },
          version: specVersion,
          enumMode: enumModeFlag ?? 'auto',
          fullCoverage: opts.fullCoverage,
          resources,
          ...(opts.originatingSystemName ? { originatingSystemName: opts.originatingSystemName } : {}),
          ...(opts.originatingSystemId ? { originatingSystemId: opts.originatingSystemId } : {}),
          ...(preferFieldsFlag ? { preferFields: preferFieldsFlag } : {}),
          options: {
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {})
          }
        };

        const result = await runWithProgress(config, `Web API Core ${specVersion}`, renderMode);
        results = [result];
      }

      if (opts.output === 'json') {
        console.log(formatResultJson(results));
      }

      process.exitCode = resolveExitCode(results);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
);

// ── Data Dictionary Subcommand ──

const ddCmd = program
  .command('dd')
  .description('Data Dictionary compliance testing')
  .option('--url <url>', 'Server base URL (mutually exclusive with --config)')
  .option('--config <path>', 'Path to a config file — runs every entry (mutually exclusive with --url)')
  // No Commander default here on purpose. With one, the action cannot tell `--dd-version 2.1` from
  // nothing supplied, and config mode needs that distinction to let an explicit flag win.
  .option('--dd-version <version>', `DD version (${CERTIFIABLE_DD_VERSIONS.join(' or ')}; default ${CURRENT_DD_VERSION})`)
  .option('--limit <n>', "Max records to replicate per resource (default: the config entry's ddOptions.limit, else 100000)")
  .option('--strict', 'Strict mode: fail on variations and enforce JSON schema validation')
  .option('--batch-expand', 'Batch all expansions per resource into a single $expand request')
  .option('--originating-system-name <v>', 'Append OriginatingSystemName eq <v> to every replication query (multi-tenant providers)')
  .option(
    '--originating-system-id <v>',
    'Append OriginatingSystemID eq <v> to every replication query (used when no name; OSN takes precedence)'
  );

addAuthOptions(ddCmd);
addOutputOptions(ddCmd);

ddCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    ddVersion?: string;
    limit: string;
    strict?: boolean;
    batchExpand?: boolean;
    originatingSystemName?: string;
    originatingSystemId?: string;
    authToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    verbose?: boolean;
    output: string;
    outputDir?: string;
  }) => {
    try {
      if (opts.url && opts.config) {
        throw new Error('--url and --config are mutually exclusive. Use one or the other.');
      }
      if (!opts.url && !opts.config) {
        throw new Error('Provide --url or --config.');
      }

      const ddVersion = normalizeDDVersion(opts.ddVersion ?? CURRENT_DD_VERSION);

      // The variations step authenticates to the Variations Service with the tools .env
      // OAuth2 client credentials (TOKEN_URI / CLIENT_ID / CLIENT_SECRET), as find-variations
      // does — so a config-driven run computes against the environment those credentials
      // belong to. When they are absent the service wrapper falls back to the CERT_AUTH_API_*
      // provider-token mint, unchanged.
      const servicesAuthToken = await mintOAuth2ClientCredentialsToken();
      if (!isCertifiableDDVersion(ddVersion)) {
        throw new Error(`Invalid version "${opts.ddVersion}". RESO certification requires DD ${CERTIFIABLE_DD_VERSIONS.join(' or ')}.`);
      }

      const renderMode = resolveRenderMode(opts);

      let results: ReadonlyArray<PipelineResult>;

      if (opts.config) {
        // Config-file mode — run every entry. The entry supplies server/auth/version/OSN (reso-certification-utils
        // format); CLI flags apply run-level knobs (limit / strict / batch-expand) and can override auth/OSN.
        //
        // The entry's version wins UNLESS --dd-version was explicitly supplied, in which case the flag does.
        // Certifying one config against two Dictionary versions to compare them is an ordinary thing to want,
        // and the flag used to be accepted and discarded here -- the only evidence being the version in the
        // output path.
        const configFile = await loadConfigFile(resolve(opts.config));
        const authFlags = { authToken: opts.authToken, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl };

        const entries = configFile.configs.map(entry => {
          const baseConfig = configEntryToDD(entry, configFile.providerUoi);
          const auth = resolveCliAuth(authFlags, baseConfig.server.auth);

          const config: DDConfig = {
            ...baseConfig,
            ...(opts.ddVersion ? { version: ddVersion } : {}),
            fromCli: true,
            ...(servicesAuthToken ? { servicesAuthToken } : {}),
            server: { ...baseConfig.server, auth },
            limit: opts.limit !== undefined ? Number(opts.limit) : (baseConfig.limit ?? 100000),
            ...(opts.strict ? { strictMode: true } : {}),
            ...(opts.batchExpand ? { batchExpand: true } : {}),
            ...(opts.originatingSystemName ? { originatingSystemName: opts.originatingSystemName } : {}),
            ...(opts.originatingSystemId ? { originatingSystemId: opts.originatingSystemId } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return { config, label: entry.description ?? runLabel(entry, configFile.providerUoi) };
        });

        results = await runConfigEntries(entries, renderMode);
      } else {
        const auth = resolveCliAuth({
          authToken: opts.authToken,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          tokenUrl: opts.tokenUrl
        });

        const config: DDConfig = {
          endorsement: 'dd',
          fromCli: true,
          ...(servicesAuthToken ? { servicesAuthToken } : {}),
          server: { url: opts.url!, auth },
          version: ddVersion,
          limit: opts.limit !== undefined ? Number(opts.limit) : 100000,
          strictMode: opts.strict,
          batchExpand: opts.batchExpand,
          ...(opts.originatingSystemName ? { originatingSystemName: opts.originatingSystemName } : {}),
          ...(opts.originatingSystemId ? { originatingSystemId: opts.originatingSystemId } : {}),
          options: {
            ...(opts.outputDir ? { outputDir: resolve(opts.outputDir) } : {})
          }
        };

        const result = await runWithProgress(config, `Data Dictionary ${ddVersion}`, renderMode);
        results = [result];
      }

      if (opts.output === 'json') {
        console.log(formatResultJson(results));
      }

      process.exitCode = resolveExitCode(results);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
);

// ── Update Variations Subcommand (Admin) ──
//
// Submit human-reviewed variation suggestions from a CSV to the v2 admin
// endpoint (POST /v2/certification/variations). Auth: an OAuth2 client_credentials
// token from .env. Review flags (--admin-review XOR --fast-track, --overwrite)
// apply to the whole submission.

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

        const bearerToken = await mintOAuth2ClientCredentialsToken();
        const result = await updateVariationsViaService({
          items,
          fromCli: true,
          adminReview: opts.adminReview,
          fastTrack: opts.fastTrack,
          overwrite: opts.overwrite,
          ...(bearerToken ? { bearerToken } : {}),
          ...(process.env.FT_ADMIN_SECRET ? { adminSecret: process.env.FT_ADMIN_SECRET } : {}),
          ...(chunkSize ? { chunkSize } : {})
        });

        console.log(`Submitted ${result.submitted} suggestion(s) in ${result.chunks} chunk(s).`);
        if (Object.keys(result.stats).length) {
          console.log('Stats:');
          for (const [key, value] of Object.entries(result.stats)) console.log(`  • ${key}: ${value}`);
        }
        if (result.overwriteRequired) {
          console.error(
            `${result.overwriteRequired} of your values would overwrite existing values. If you meant to do this, pass the --overwrite flag.`
          );
        }
        if (result.permissionDenied || result.validationFailed || result.corrections) {
          console.error(
            `Not everything landed as submitted. permission-denied: ${result.permissionDenied}, validation-failed: ${result.validationFailed}, corrections: ${result.corrections}. Review before assuming the run was clean.`
          );
          for (const [reason, count] of Object.entries(result.permissionDeniedReasons)) {
            console.error(`  refused (${count}): ${reason}`);
          }
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    }
  );

// ── Variations review (read side) ──
//
// The items in review and the caller's submission status, read from the same
// routes the web client's review page uses. Provider tokens see their own rows;
// an admin token sees the org-wide pool. Read-only: nothing here writes to the
// pool or the canonical store. Auth as update-variations: an OAuth2
// client_credentials token from .env (TOKEN_URI / CLIENT_ID / CLIENT_SECRET),
// falling back to the CERT_AUTH_API_* provider-token mint.

const REVIEW_ELEMENT_TYPES: ReadonlyArray<VariationReviewElementType> = ['resource', 'field', 'lookup'];

program
  .command('list-variation-reviews')
  .description('List the variations in review (your own as a provider, the whole pool as an admin) — read-only')
  .option('--status <status>', 'Filter by pool status: pending, ft-submitted or resolved')
  .option('--element-type <type>', 'Filter by element type: resource, field or lookup')
  .option('--provenance', 'Show every submission under each item instead of the summary table')
  .option('--page-size <n>', 'Items per request to the service; every page is fetched regardless')
  .option('--json', 'Print the items exactly as the service returned them')
  .action(async (opts: { status?: string; elementType?: string; provenance?: boolean; pageSize?: string; json?: boolean }) => {
    try {
      if (opts.elementType !== undefined && !REVIEW_ELEMENT_TYPES.includes(opts.elementType as VariationReviewElementType)) {
        throw new Error(`--element-type must be one of: ${REVIEW_ELEMENT_TYPES.join(', ')}`);
      }
      const pageSize = opts.pageSize === undefined ? undefined : Number.parseInt(opts.pageSize, 10);
      if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
        throw new Error(`--page-size must be a positive integer, got '${opts.pageSize}'`);
      }
      const bearerToken = await mintOAuth2ClientCredentialsToken();
      const items = await listVariationReviewItemsViaService({
        fromCli: true,
        ...(bearerToken ? { bearerToken } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.elementType ? { elementType: opts.elementType as VariationReviewElementType } : {}),
        ...(pageSize ? { limit: pageSize } : {})
      });
      const duplicates = duplicateVariationKeys(items);
      if (duplicates.length > 0) {
        console.error(
          `Warning: the service returned ${duplicates.length} item(s) more than once across pages, with their provenance split ` +
            `(${duplicates.join(', ')}). Rows are shown as served; a larger --page-size, or none, avoids the split.`
        );
      }
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      console.log(opts.provenance ? formatProvenance(items) : formatReviewItemsTable(items));
      console.error(`${items.length} item(s) in review${opts.status ? ` with status ${opts.status}` : ''}.`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  });

const ENDORSEMENT_REVIEW_STATUSES: ReadonlyArray<EndorsementReviewStatus> = ['none', 'in-review', 'resolved'];

program
  .command('variations-review-status')
  .description('Show where each of your variations submissions stands (lifecycle and review status) — read-only')
  .option(
    '--review-status <status>',
    "Admin: list every provider's submissions with this review status (none, in-review or resolved) instead of your own"
  )
  .option('--json', 'Print the rows exactly as the service returned them')
  .action(async (opts: { reviewStatus?: string; json?: boolean }) => {
    try {
      if (opts.reviewStatus !== undefined && !ENDORSEMENT_REVIEW_STATUSES.includes(opts.reviewStatus as EndorsementReviewStatus)) {
        throw new Error(`--review-status must be one of: ${ENDORSEMENT_REVIEW_STATUSES.join(', ')}`);
      }
      const bearerToken = await mintOAuth2ClientCredentialsToken();
      const auth = { fromCli: true, ...(bearerToken ? { bearerToken } : {}) };
      const mine = opts.reviewStatus ? undefined : await listMyEndorsementsViaService(auth);
      const rows = mine
        ? mine.endorsements
        : await listEndorsementsByReviewStatusViaService({ ...auth, reviewStatus: opts.reviewStatus as EndorsementReviewStatus });
      console.log(opts.json ? JSON.stringify(rows, null, 2) : formatEndorsementStatusTable(rows, opts.reviewStatus, mine?.providerUoi));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  });

// ── Metadata Report subcommand group ──
//
// Utilities for working with metadata reports outside of a full
// certification run. Today this is just the `adapt` subcommand,
// which fills in the top-level resources[] block on DD 2.0/2.1
// reports so they can be loaded by tools that expect a DD 2.2-shaped
// report (notably the Reference Server).

const metadataReportCmd = program.command('metadata-report').description('Utilities for working with metadata report JSON files');

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

      const output = opts.pretty ? JSON.stringify(adapted, null, 2) : JSON.stringify(adapted);

      await writeFile(outPath, output, 'utf-8');

      const wasNoOp = adapted === parsed;
      const resourceCount = adapted.resources.length;
      const verb = wasNoOp ? 'passed through' : 'adapted';
      console.error(`${verb} ${inPath} → ${outPath} (${resourceCount} resources${wasNoOp ? ', already populated' : ', synthesized'})`);
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
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <version>', 'DD version for the schema context', CURRENT_DD_VERSION)
  .option(
    '-r, --resource <name>',
    'Resource name when the payload carries no @reso.context (a present context names the resource); default Property'
  )
  .option('-s, --settings <file>', 'schema-validation-settings.json (else ./ then the pre-baked copy)')
  .option('-a, --additional-properties', 'Allow fields not present in the metadata (default: reject them)')
  .option('--output-dir <path>', 'Directory for the report (created if missing); "-" for stdout', '.')
  .action(
    async (opts: {
      metadata: string;
      payload: string;
      ddVersion?: string;
      resource?: string;
      settings?: string;
      additionalProperties?: boolean;
      outputDir: string;
    }) => {
      try {
        const validationConfig = await loadSettings(opts.settings);
        const metadataReportJson = await readJsonInput(opts.metadata);
        const jsonPayload = await readJsonInput(opts.payload);
        const { totalErrors, report } = await validateSchemaPayload({
          metadataReportJson,
          jsonPayload,
          resourceName: opts.resource,
          version: opts.ddVersion, // normalized to the Data Dictionary form inside validateSchemaPayload
          validationConfig,
          additionalProperties: opts.additionalProperties
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
    }
  );

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
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <ddVersion>', 'DD version stamped into the generated report', CURRENT_DD_VERSION)
  .option('--odata-version <version>', 'OData version override for validation (4.0 | 4.01); auto-detected when omitted')
  .option('--output-dir <path>', 'Directory for metadata-report.json (created if missing); "-" for stdout', '.')
  .option('--no-report', 'Validate only; do not generate the metadata report')
  .action(async (opts: { metadata: string; ddVersion: string; odataVersion?: string; outputDir: string; report: boolean }) => {
    try {
      const metadataXml = await readTextInput(opts.metadata);
      const result = await runMetadataStep({
        metadataXml,
        ddVersion: opts.ddVersion,
        odataVersion: opts.odataVersion as ODataVersion | undefined,
        emitReport: opts.report
      });
      process.stderr.write(`metadata: ${result.summary}\n`);
      for (const err of result.errors) process.stderr.write(`  - ${err}\n`);
      if (opts.report && result.report) {
        const dest = await writeArtifact(opts.outputDir, 'metadata-report.json', result.report);
        const { resources, fields, lookups } = result.report;
        process.stderr.write(
          `metadata: report → ${dest} (${resources.length} resources, ${fields.length.toLocaleString()} fields, ${lookups.length.toLocaleString()} lookups)\n`
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
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <ddVersion>', 'Data Dictionary version', CURRENT_DD_VERSION)
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
      ddVersion: string;
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
          tokenUrl: opts.tokenUrl
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
          version: opts.ddVersion,
          shouldGenerateReports: !!opts.metadata,
          jsonSchemaValidation: opts.jsonSchemaValidation || opts.strict,
          strictMode: opts.strict,
          shouldSaveResults: opts.saveResults,
          originatingSystemName: opts.originatingSystemName,
          originatingSystemId: opts.originatingSystemId,
          onProgress: (info: Record<string, unknown>) => {
            const n = Number(info.totalRecordsFetched ?? 0);
            process.stderr.write(`replicate ${opts.strategy}: ${n.toLocaleString()} records\r`);
          }
        });
        process.stderr.write(
          `\nreplicate: ${result.strategy} complete — ${result.stats.totalRecordsFetched.toLocaleString()} records, ` +
            `${result.stats.totalRequests.toLocaleString()} requests → ${result.outputDir}\n`
        );
        process.exitCode = 0;
      } catch (err) {
        process.stderr.write(`\nreplicate: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      }
    }
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
  const counts = Object.entries(report.variations ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0] as const);
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
  // `--dd-version`, matching the `dd` command.
  //
  // NOT `-v, --version`, which this command used to declare and which COULD NEVER FIRE. The program
  // registers its own version flag (`program.version(CLI_VERSION)` above), and that one wins: a
  // subcommand `--version` printed the package version and exited 0, so the command never ran and
  // nothing said so. Five commands carried that dead option. Removing it breaks nothing, because
  // nothing could ever have depended on it.
  .option('--dd-version <version>', 'Data Dictionary version', DEFAULT_DD_VERSION)
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
      ddVersion: string;
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
        const version = opts.ddVersion;

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
                tokenUrl: opts.tokenUrl
              })
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
            ...(computeToken ? { bearerToken: computeToken } : {})
          });
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const report = await findVariations({
            metadataReportJson,
            version,
            fuzziness,
            fromCli: true,
            outputPath: resolve(opts.outputDir),
            ...(computeToken ? { bearerToken: computeToken } : {})
          });
          const { total, detail } = summarizeVariations(report);
          process.stderr.write(
            total > 0
              ? `find-variations: ${total} variation(s) [${detail}] → ${resolve(opts.outputDir, VARIATIONS_REPORT_FILENAME)}\n`
              : 'find-variations: no variations found\n'
          );
        }
        process.exitCode = 0;
      } catch (err) {
        process.stderr.write(`find-variations: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      }
    }
  );

// ── RCF Subcommand (per-step util: RESO Common Format certification) ──
// RCF providers deliver data, not a schema — a .json/.zip/directory of payloads or records. This
// streams the input, optionally schema-validates it against the DD (--strict), reverse-infers a
// DD-2.0 metadata report + a data-availability report, and runs the variations service on the
// inferred report — the same two artifacts as a DD 2.0 run, plus the variations report.

program
  .command('rcf')
  .description('RESO Common Format — infer a DD-2.0 metadata report from RCF data and run variations')
  .requiredOption('-i, --input <path>', 'RCF input: a .json file, a .zip, or a directory of payloads/records')
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <ver>', `DD version; the payload's @reso.context wins when present, else ${CURRENT_DD_VERSION}`)
  .option('-f, --fuzziness <float>', `Variations fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`, String(DEFAULT_FUZZINESS))
  .option('--output-dir <path>', 'Directory for the reports (created if missing)', '.')
  .option(
    '--schema-validate',
    'Schema-validate each payload against the DD before inferring (RCF is taken as-is: local fields and values are accepted; a DD field must have the right type; length, precision and scale beyond the DD are warnings)'
  )
  .option(
    '-a, --additional-properties',
    'Accepted for compatibility: extension is always allowed on RCF (local fields and values), so this flag has no effect here'
  )
  .option('--strict', 'Fail fast on the first schema-validation error (with --schema-validate)')
  .option('--no-variations', 'Skip the variations service call (infer + reports only)')
  .action(
    async (opts: {
      input: string;
      ddVersion?: string;
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
          version: opts.ddVersion,
          fuzziness,
          additionalProperties: opts.additionalProperties,
          strict: opts.strict,
          schemaValidate: opts.schemaValidate,
          generatedOn: new Date().toISOString(),
          runVariations: opts.variations,
          ...(bearerToken ? { bearerToken } : {})
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
          `rcf: DD${result.version} — ${s.totalRecords.toLocaleString()} records → ${s.resources} resources, ${s.fields.toLocaleString()} fields, ${s.lookups.toLocaleString()} lookups${opts.schemaValidate ? `; ${s.schemaErrors} schema error(s)` : ''}${s.variationsTotal !== undefined ? `; ${s.variationsTotal} variation(s)` : ''} → ${dir}\n`
        );
        if (result.variationsError) {
          process.stderr.write(`rcf: variations skipped — ${result.variationsError} (reports still written)\n`);
        }
        if (s.totalRecords === 0) {
          process.stderr.write(`rcf: no certifiable records were ingested from ${resolve(opts.input)} — nothing to certify\n`);
        }
        if (s.invalidContextFiles > 0) {
          process.stderr.write(
            `rcf: ${s.invalidContextFiles} file(s) carry an unreadable @reso.context (${s.invalidContextRecords} record(s) not certified)${
              opts.schemaValidate
                ? ' — counted among the schema errors above\n'
                : ' — run with --schema-validate to have them reported as schema errors\n'
            }`
          );
        }
        // Zero-record (empty/unreadable) submissions and degraded variations runs must not read as a clean pass.
        process.exitCode = resolveRcfExitCode(result);
      } catch (err) {
        const schemaFailure = (err as { schemaFailure?: boolean }).schemaFailure === true;
        process.stderr.write(`rcf: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = schemaFailure ? 1 : 2;
      }
    }
  );

// ── Submit a variations report (write side) ──
//
// Pushing a report IS starting a review: the same request writes the review rows,
// so there is no separate "start" call. A CLI run produces a COMPLETE report, so
// this is always a full replace of whatever is on record -- the destructive shape
// the service's lock gate guards.
//
// CONSENT IS A FLAG, NOT A MODE. There is no TTY branch here and no prompt: the
// command behaves identically whether a person or an agent runs it, following the
// convention `update-variations` already set -- do the safe thing, report what
// would have been destructive, and name the flag. A command that did different
// things depending on where it ran is how automation quietly performs the act a
// human would have been warned about.
//
// A LOCK IS NOT OVERRIDABLE. `--overwrite` covers a pending review with no lock
// and nothing more. A lock means somebody is actively working, and one a
// stateless call could clear would not be a lock.

program
  .command('submit-variations-report')
  .description('Submit a variations report from a DD run to the Variations Service — starts or refreshes a review')
  .requiredOption('-r, --report <path>', 'Path to the variations-report.json a DD run produced')
  .option('--overwrite', 'Proceed over an existing pending review (never over a lock)')
  .option('--dry-run', 'Report what would be submitted and send nothing')
  .option('--json', 'Print the result as JSON')
  .action(async (opts: { report: string; overwrite?: boolean; dryRun?: boolean; json?: boolean }) => {
    try {
      // The Variations Service takes an OAuth2 client-credentials token minted from the tools .env
      // (TOKEN_URI / CLIENT_ID / CLIENT_SECRET), exactly as update-variations and the review commands
      // do. `mintProviderToken` in the SDK reads the CERT_AUTH_API_* variables instead, which this
      // .env does not carry -- so the CLI mints here and passes the token down rather than letting
      // the SDK fall back to a mechanism that is not configured.
      //
      // Skipped entirely for a dry run, which contacts nothing and so should not demand credentials.
      const bearerToken = opts.dryRun ? undefined : await mintOAuth2ClientCredentialsToken();

      const result = await submitVariationsReportViaService({
        reportPath: opts.report,
        fromCli: true,
        ...(bearerToken ? { bearerToken } : {}),
        ...(opts.overwrite ? { overwrite: true } : {}),
        ...(opts.dryRun ? { dryRun: true } : {})
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const where = `${result.providerUoi} / ${result.providerUsi} → ${result.recipientUoi}, DD ${result.version}`;

      if (result.dryRun) {
        console.log('Dry run — nothing was sent.');
        console.log(`  Would submit ${result.changeCount} change(s) for ${where}.`);
        console.log('  This is a FULL replace: it replaces the review rows currently on record for this report.');
        console.log('  Re-run without --dry-run to submit.');
        return;
      }

      console.log(`Submitted ${result.changeCount} change(s) for ${where}.`);
      if (result.variationsReportId) {
        // The handle. A stateless run has nothing else to quote in a support request.
        console.log(`  Report id: ${result.variationsReportId}`);
      }
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      console.error(error instanceof Error ? error.message : String(error));

      // A lock is somebody else working, not a fault. Separate exit code so a
      // script can tell "come back later" from "this is broken".
      if (code === 'LOCKED') {
        const lock = lockHolderOf(error);
        if (lock) {
          console.error(`  Held by: ${lock.displayName} <${lock.email}>`);
          console.error(`  Until:   ${lock.expiresAt}`);
        }
        console.error('  No flag overrides a lock. --overwrite covers a pending review with no lock.');
        process.exitCode = 3;
        return;
      }

      process.exitCode = 2;
    }
  });

// ── Mark a variations report and push it (write side) ──
//
// The same thing the review UI's Submit does. Josh, 2026-10-04: "client passes the variations report
// and comments and the backend should do everything from there", and it "should make the same output
// as if a user is on the UI".
//
// SO THIS IS ONE REQUEST. Marking an item is a field on its change, not a separate call. A sheet row
// sets `ignore`, `remove` or `flaggedForFastTrack` on the entry it names and optionally appends a
// comment; the service derives the pool row's `requestedAction` from those flags, derives
// `editorInfo` from the auth context, writes the rows and notifies. Nothing identifying is sent,
// because nothing identifying is knowable here: the caller's identity is columns on the token row,
// read by the Lambda authorizer.
//
// THE REPORT GOES AS THE RUN PRODUCED IT. A Data Dictionary run writes five level buckets --
// resources, fields, lookups, expansions, complexTypes -- and the service flattens them. An earlier
// version of this command demanded a flat `changes` array and rejected the real artifact as "the
// wrong file", which was a false accusation of a correct input.
//
// PUSHING IS A FULL REPLACE of the review rows this report owns, which is why a sheet with one bad
// row pushes nothing at all.

program
  .command('submit-variation-decisions')
  .description('Mark a variations report from a sheet of actions and comments, and submit it for review')
  .requiredOption('-r, --report <path>', 'Path to the variations-report.json a DD run produced')
  .requiredOption('-d, --decisions <path>', 'Path to the sheet (Resource Name, Field Name, Lookup Value, Action, Comment)')
  .option('--dry-run', 'Show what would be marked and send nothing')
  .option('--json', 'Print the marked report instead of submitting it')
  .action(async (opts: { report: string; decisions: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const report = JSON.parse(await readFile(resolve(opts.report), 'utf-8')) as Record<string, unknown>;
      const { items, recognizedColumns, skippedColumns } = parseDecisionsCsv(await readFile(resolve(opts.decisions), 'utf-8'));
      if (skippedColumns.length) {
        console.error(`Ignoring unrecognized columns: ${skippedColumns.join(', ')}`);
      }

      const plan = planDecisionPush({ report: report as never, rows: items, now: new Date().toISOString() });
      console.log(`Parsed ${items.length} row(s) from columns: ${recognizedColumns.join(', ')}.`);
      console.log(`The report carries ${plan.entryCount} variation(s).`);

      if (plan.errors.length > 0) {
        // Nothing is pushed. The push replaces this report's review rows, so landing a destructive
        // replace that carries only part of what the operator meant is worse than landing nothing.
        console.error(`The sheet has ${plan.errors.length} unusable row(s). Nothing was sent.`);
        for (const error of plan.errors) console.error(`  • ${error}`);
        process.exitCode = 2;
        return;
      }

      if (!plan.changed) {
        console.log('Nothing to do: no row asked for an action or carried a comment.');
        return;
      }

      console.log(`Marking ${plan.applied.length} variation(s):`);
      console.log(formatPlan(plan));

      if (opts.json) {
        console.log(JSON.stringify(plan.report, null, 2));
        return;
      }

      if (opts.dryRun) {
        console.log('Dry run — nothing was sent.');
        console.log('  Submitting is a FULL replace: it replaces the review rows currently on record for this report.');
        console.log('  Re-run without --dry-run to submit.');
        return;
      }

      const bearerToken = await mintOAuth2ClientCredentialsToken();
      const result = await submitVariationsReportViaService({
        report: plan.report as Record<string, unknown>,
        fromCli: true,
        ...(bearerToken ? { bearerToken } : {})
      });

      console.log(`Submitted for ${result.providerUoi} / ${result.providerUsi} → ${result.recipientUoi}, DD ${result.version}.`);
      if (result.variationsReportId) {
        console.log(`  Report id: ${result.variationsReportId}`);
      }
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      console.error(error instanceof Error ? error.message : String(error));

      if (code === 'LOCKED') {
        const lock = lockHolderOf(error);
        if (lock) {
          console.error(`  Held by: ${lock.displayName} <${lock.email}>`);
          console.error(`  Until:   ${lock.expiresAt}`);
        }
        process.exitCode = 3;
        return;
      }

      process.exitCode = 2;
    }
  });

program.parse();
