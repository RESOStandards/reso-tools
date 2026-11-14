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

// IMPORTANT: env-bootstrap MUST be the very first import. It reads the run's
// environment file as an import-time side effect so that subsequent imports
// (notably anything that transitively touches src/legacy/*) see env vars
// like RESO_SERVICES_URL populated when they destructure process.env.
import { ENV_BOOTSTRAP } from './env-bootstrap.js';

import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { Command } from 'commander';
import { startMockServer, stopMockServer } from '../add-edit/mock/server.js';
import { ADD_EDIT_ACTIONS, ADD_EDIT_FORMATS } from '../add-edit/plan.js';
import { type CloudRunConfig, whyNoCloudRunBeforeRun } from '../cloud/local-run.js';
import { listCloudRunStatus, reserveCloudRun } from '../cloud/runs.js';
import { startCloudRun } from '../cloud/start.js';
import { cliCredentialsTokenProvider } from '../cloud/update-tokens.js';
import { subscribeToCloudUpdates } from '../cloud/updates.js';
import { startMockEntityEventServer, stopMockEntityEventServer } from '../entity-event/mock/server.js';
import { synthesizeResourcesFromFields } from '../metadata/index.js';
import { CURRENT_ADD_EDIT_VERSION, SUPPORTED_ADD_EDIT_VERSIONS, isAddEditVersion } from '../sdk/add-edit-versions.js';
import { lockHolderOf, resolveCloudUpdatesUrl } from '../sdk/common.js';
import {
  configEntryToAddEdit,
  configEntryToCore,
  configEntryToDD,
  configEntryToEntityEvent,
  isGeneratedLocalUoi,
  loadConfigFile
} from '../sdk/config.js';
import { CERTIFIABLE_CORE_VERSIONS, CURRENT_CORE_VERSION, SUPPORTED_CORE_VERSIONS, isCoreVersion } from '../sdk/core-versions.js';
import {
  CERTIFIABLE_DD_VERSIONS,
  CURRENT_DD_VERSION,
  TESTABLE_DD_VERSIONS,
  isTestableDDVersion,
  normalizeDDVersion
} from '../sdk/dd-versions.js';
import { fetchMetadataReportFromServer } from '../sdk/metadata-source.js';
import { rcfRunOutcome, runRcfCompliance } from '../sdk/rcf.js';
import { normalizeReportFieldTypes } from '../sdk/report-field-types.js';
import { withSoftwareVersion } from '../sdk/reports.js';
import type { AddEditConfig, CoreConfig, DDConfig, EntityEventConfig, PipelineResult, RcfConfig } from '../sdk/types.js';
import { resolveAuthToken } from '../test-runner/auth.js';
import { applyVariationDecisionsViaService } from '../variations/apply.js';
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
import { addEditSelectionOf } from './add-edit-options.js';
import { compareExitCode, renderComparisonText, runCompare } from './analytics-command.js';
import { formatApplyItems, summarizeApplyPlan } from './apply-command.js';
import { type ArchiveReportResult, archiveExitCode, runArchiveReport } from './archive-report-command.js';
import { askExitCode, renderAnswer, runAsk, withoutRepeats } from './ask-command.js';
import { mintOAuth2ClientCredentialsToken, resolveCliAuth } from './auth.js';
import { resolveCertApiAuthorization, resolveCertApiOrigin } from './cert-api-credential.js';
import {
  type CloudOfferIo,
  type RanEntry,
  cloudRunPrerequisite,
  cloudTargetLabel,
  ddFlagsRefusedBeforeRun,
  entriesRefusedBeforeRun,
  formatRunStatusTable,
  offerCloudRuns,
  planCloudRuns
} from './cloud-command.js';
import { STATUS_READ_LIMIT, cloudWatchPrerequisite, runCloudWatch } from './cloud-watch.js';
import { formatPlan, planDecisionPush } from './decisions-command.js';
import { overrideRenameNotice, removedPreferFields } from './deprecations.js';
import { runMetadataStep } from './metadata-command.js';
import {
  RCF_DEFAULT_DD_VERSION,
  SUBMITTABLE_REPORT_FILENAME,
  readRcfReportIdentity,
  resolveRcfExitCode,
  submittableVariationsReport
} from './rcf-command.js';
import { resolveRenderMode, resultsOf, runConfigEntries, runWithProgress, stoppedOf } from './render.js';
import { REPLICATION_STRATEGY_VALUES, runReplicate } from './replicate-command.js';
import { readLedger, runRestore } from './restore-command.js';
import { findStoredRuns, runRunRestore } from './restore-runs.js';
import { formatResultJson } from './result-json.js';
import { generateSchemaFromReport, loadSettings, validateSchemaPayload } from './schema-command.js';
import { maskSecrets } from './secrets.js';
import { addAuthOptions, addOutputOptions } from './shared-options.js';
import {
  duplicateVariationKeys,
  formatEndorsementStatusTable,
  formatProvenance,
  formatReviewItemsCsv,
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

/** Determine exit code from pipeline results. A run cut short by its total-timeout budget
 *  is `incomplete` — not a clean pass, so it exits non-zero (like a failure) rather than
 *  letting a truncated run read as success; the report distinguishes incomplete from failed.
 *  A config entry that stopped before producing a result is a runtime error (2), ahead of any
 *  verdict: its run was never counted, so a config whose every run crashed exited 0. */
const resolveExitCode = (results: ReadonlyArray<PipelineResult>, stopped = 0): number => {
  if (stopped > 0) return 2;
  return results.some(r => r.status === 'failed' || r.status === 'incomplete') ? 1 : 0;
};

// ── Program ──

const program = new Command();

// `-V` / `--version` (Commander's default flags) report the CLI's own version. Per-command spec versions use
// their own explicit flags (`core --spec-version`, `dd --dd-version`) so they never collide with this.
program.name('reso-cert').description('RESO certification compliance testing tools').version(CLI_VERSION);

/**
 * What startup read, reported before any action runs. A file that exists but could not be read stops the
 * command here, before anything authenticates.
 *
 * Reported by NAME only. The file's whole purpose is to carry a credential, and a report of what it loaded
 * by value would undo the masking the loader registered.
 */
program.hook('preAction', () => {
  if (ENV_BOOTSTRAP.error !== undefined) {
    // Stopped outright, with the CLI's runtime-error code: nothing has run yet, and nothing should.
    console.error('Error:', ENV_BOOTSTRAP.error);
    process.exit(2);
  }
  const loaded = ENV_BOOTSTRAP.load;
  if (loaded === undefined) return;
  const applied = loaded.applied.length > 0 ? loaded.applied.join(', ') : 'nothing new';
  const alreadySet = loaded.skipped.length > 0 ? `; already set, left alone: ${loaded.skipped.join(', ')}` : '';
  console.error(`Read ${loaded.path} (${applied}${alreadySet})`);
});

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
  .option(
    '--payloads <dir>',
    'Directory holding the payloads for the actions tested: create-succeeds.json, create-fails.json, update-succeeds.json, update-fails.json, delete-succeeds.json, delete-fails.json'
  )
  .option(
    '--actions <list>',
    `The actions to test, comma-separated: ${ADD_EDIT_ACTIONS.join(', ')} (required, here or in the configuration)`
  )
  .option('--create-formats <list>', `The create responses to test, comma-separated: ${ADD_EDIT_FORMATS.join(', ')} (required with create)`)
  .option('--update-formats <list>', `The update responses to test, comma-separated: ${ADD_EDIT_FORMATS.join(', ')} (required with update)`)
  .option(
    '--auto-payloads',
    'Write the payloads instead of reading them, for a server such as the reference server or the mock: Property only'
  )
  .option('--metadata <path>', 'Path to local XML metadata file')
  .option('--mock', 'Start a mock OData server. Its payloads are written for it unless --payloads gives them')
  .option(
    '--spec-version <version>',
    `Web API Add/Edit spec version: ${SUPPORTED_ADD_EDIT_VERSIONS.join(' or ')}`,
    CURRENT_ADD_EDIT_VERSION
  )
  .option(
    '--start-cloud-run',
    "At the end, start a certification run in RESO's cloud for the entries that passed and can be certified, with the " +
      'payloads they used. Needs --config. Without it, nothing is started'
  );

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
    actions?: string;
    createFormats?: string;
    updateFormats?: string;
    autoPayloads?: boolean;
    startCloudRun?: boolean;
  }) => {
    let mockServer: Awaited<ReturnType<typeof startMockServer>> | null = null;

    try {
      // Validate mutually exclusive options
      if (opts.url && opts.config) {
        throw new Error('--url and --config are mutually exclusive. Use one or the other.');
      }
      if (!opts.url && !opts.config && !opts.mock) {
        throw new Error('Provide --url, --config or --mock.');
      }
      if (opts.payloads && opts.autoPayloads) {
        throw new Error('--payloads and --auto-payloads are two ways of giving the payloads. Use one.');
      }
      const cloudRefusal = startCloudRunRefusal(opts);
      if (cloudRefusal !== undefined) throw new Error(cloudRefusal);
      // The cloud tests the provider's own payloads, so a run with written ones could not start one.
      if (opts.startCloudRun && (opts.autoPayloads || opts.mock)) {
        throw new Error('--start-cloud-run tests the payloads you give, so it does not go with --auto-payloads or --mock.');
      }
      // The suite is the 2.0.0 one whatever the label says, so another label would describe a test that did not run.
      if (!isAddEditVersion(opts.specVersion)) {
        throw new Error(`Invalid --spec-version "${opts.specVersion}". Web API Add/Edit is ${SUPPORTED_ADD_EDIT_VERSIONS.join(' or ')}.`);
      }
      // What to test, checked before anything starts, by the same rules the run applies.
      const selection = addEditSelectionOf(opts);

      const renderMode = resolveRenderMode(opts);

      // Start mock server if requested
      if (opts.mock) {
        const metadataXml = opts.metadata ? await readFile(resolve(opts.metadata), 'utf-8') : await loadDefaultMetadata();
        const mock = await startMockServer({ metadataXml, resource: opts.resource, port: DEFAULT_MOCK_PORT });
        mockServer = mock;
        if (renderMode !== 'silent') console.log(`Mock server started at ${mock.url}`);
      }

      let results: ReadonlyArray<PipelineResult>;
      let stopped = 0;
      let ranForCloud: RanForCloud | undefined;

      if (opts.config) {
        // Config file mode
        const configFile = await loadConfigFile(resolve(opts.config));
        const uoiRefusal = startCloudRunRefusal(opts, configFile.providerUoi);
        if (uoiRefusal !== undefined) throw new Error(uoiRefusal);
        const authFlags = { authToken: opts.authToken, clientId: opts.clientId, clientSecret: opts.clientSecret, tokenUrl: opts.tokenUrl };

        const entries = configFile.configs.map(entry => {
          const baseConfig = configEntryToAddEdit(entry, configFile.providerUoi);
          const auth = resolveCliAuth(authFlags, baseConfig.server.auth);

          // A flag given on the command line applies to every entry.
          const config: AddEditConfig = {
            ...baseConfig,
            server: { ...baseConfig.server, auth },
            ...selection,
            ...(opts.autoPayloads ? { autoPayloads: true } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return {
            config,
            label: entry.description ?? runLabel(entry, configFile.providerUoi)
          };
        });

        const entryRefusal = startCloudRunEntryRefusal(opts, entries);
        if (entryRefusal !== undefined) throw new Error(entryRefusal);

        const outcomes = await runConfigEntries(entries, renderMode);
        results = resultsOf(outcomes);
        stopped = stoppedOf(outcomes).length;
        ranForCloud = {
          providerUoi: configFile.providerUoi,
          ...(configFile.concurrency === undefined ? {} : { concurrency: configFile.concurrency }),
          ran: entries.map((entry, index) => ({ label: entry.label, config: entry.config, outcome: outcomes[index] }))
        };
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
          // A mock has no provider to give payloads, so it gets written ones unless --payloads gives them.
          ...(opts.autoPayloads || (opts.mock && !opts.payloads) ? { autoPayloads: true } : {}),
          ...selection,
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

      process.exitCode = resolveExitCode(results, stopped);

      if (ranForCloud !== undefined) {
        await offerAtEnd({ ...ranForCloud, endorsementLabel: 'Add/Edit' }, ranForCloud.ran, opts);
      }
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
  .option('--mock', 'Start a mock OData server')
  .option(
    '--start-cloud-run',
    "At the end, start a certification run in RESO's cloud for the entries that passed and can be certified. " +
      'Needs --config. Without it, nothing is started'
  );

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
    startCloudRun?: boolean;
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
        throw new Error('Provide --url, --config or --mock.');
      }
      const cloudRefusal = startCloudRunRefusal(opts);
      if (cloudRefusal !== undefined) throw new Error(cloudRefusal);
      if (opts.startCloudRun && opts.mock) {
        throw new Error('--start-cloud-run certifies your server, so it does not go with --mock.');
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
      let stopped = 0;
      let ranForCloud: RanForCloud | undefined;

      if (opts.config) {
        // Config file mode
        const configFile = await loadConfigFile(resolve(opts.config));
        const uoiRefusal = startCloudRunRefusal(opts, configFile.providerUoi);
        if (uoiRefusal !== undefined) throw new Error(uoiRefusal);
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

        const entryRefusal = startCloudRunEntryRefusal(opts, entries);
        if (entryRefusal !== undefined) throw new Error(entryRefusal);

        const outcomes = await runConfigEntries(entries, renderMode);
        results = resultsOf(outcomes);
        stopped = stoppedOf(outcomes).length;
        ranForCloud = {
          providerUoi: configFile.providerUoi,
          ...(configFile.concurrency === undefined ? {} : { concurrency: configFile.concurrency }),
          ran: entries.map((entry, index) => ({ label: entry.label, config: entry.config, outcome: outcomes[index] }))
        };
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

      process.exitCode = resolveExitCode(results, stopped);

      if (ranForCloud !== undefined) {
        await offerAtEnd({ ...ranForCloud, endorsementLabel: 'EntityEvent' }, ranForCloud.ran, opts);
      }
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

// ── Cloud runs: the CLI's side of the choice at the end of a local run ──

/**
 * The CLI's side of the cloud-run choice, for every endorsement. It reports on stderr, so stdout stays the run's
 * own output, and sends with the variations commands' auth, minted once and only if something is sent. The start
 * itself is `startCloudRun`, the path the desktop shares.
 */
const cliCloudOfferIo = (): CloudOfferIo => {
  const held: { token?: Promise<string | undefined> } = {};
  const token = (): Promise<string | undefined> => {
    held.token ??= mintOAuth2ClientCredentialsToken();
    return held.token;
  };
  const auth = async (): Promise<{ readonly fromCli: true; readonly bearerToken?: string }> => {
    const bearerToken = await token();
    return { fromCli: true, ...(bearerToken ? { bearerToken } : {}) };
  };
  return {
    say: text => console.error(maskSecrets(text)),
    reserve: async input => reserveCloudRun({ ...(await auth()), ...input }),
    start: async input => {
      const servicesAuthToken = await token();
      return startCloudRun({ ...input, fromCli: true, ...(servicesAuthToken ? { servicesAuthToken } : {}) });
    }
  };
};

/** What `--start-cloud-run` refuses before any run, so a long run is not wasted. `undefined` when it may go on. */
const startCloudRunRefusal = (
  opts: { readonly startCloudRun?: boolean; readonly config?: string },
  providerUoi?: string
): string | undefined => {
  if (!opts.startCloudRun) return undefined;
  // A cloud run is addressed to the provider, system and recipient a config file names, and `--url` names none of them.
  if (!opts.config) return '--start-cloud-run needs --config, which names the provider, system and recipient a cloud run is addressed to.';
  if (providerUoi !== undefined && isGeneratedLocalUoi(providerUoi)) {
    return '--start-cloud-run needs the config file to name its providerUoi, the organization a cloud run certifies.';
  }
  // A pass can be sent only with the service's address and credentials. Nothing is sent before the run passes.
  return cloudRunPrerequisite(process.env);
};

/**
 * What `--start-cloud-run` refuses once the config file is read and before any entry runs: an entry a cloud run could
 * never start from, because it is not addressed or asks for a run that cannot be certified or sent. The flags were
 * checked by the command; this reads what the file set. `undefined` when every entry may go on.
 */
const startCloudRunEntryRefusal = (
  opts: { readonly startCloudRun?: boolean },
  entries: ReadonlyArray<{ readonly label: string; readonly config: CloudRunConfig }>
): string | undefined => (opts.startCloudRun ? entriesRefusedBeforeRun(entries) : undefined);

/** Each entry of a config-file run as it ran, for the cloud-run choice at the end. */
interface RanForCloud {
  readonly providerUoi: string;
  readonly concurrency?: number;
  readonly ran: ReadonlyArray<RanEntry>;
}

/** The choice at the end of a config-file run, for any endorsement. A failed start is a runtime error. */
const offerAtEnd = async (
  offer: { readonly providerUoi: string; readonly concurrency?: number; readonly endorsementLabel: string },
  ran: ReadonlyArray<RanEntry>,
  mode: { readonly startCloudRun?: boolean; readonly output?: string }
): Promise<void> => {
  const plan = planCloudRuns(ran);
  const offered = await offerCloudRuns(
    offer,
    plan,
    { startCloudRun: mode.startCloudRun === true, json: mode.output === 'json' },
    cliCloudOfferIo()
  );
  // The local runs may have passed, but what was asked for did not happen: a runtime error.
  if (offered === 'failed') process.exitCode = 2;
};

// ── Web API Core Subcommand ──

const coreCmd = program
  .command('core')
  .description('Web API Core 2.0.0/2.1.0 compliance testing')
  .option('--url <url>', 'Server base URL (mutually exclusive with --config)')
  .option('--config <path>', 'Path to a config file – runs every entry (mutually exclusive with --url)')
  .option('--resources <list>', 'Comma-separated resource names (default: every Data Dictionary resource the server declares)')
  // `--spec-version` (not `--version`, which is reserved for the program's own `-V`). Defaults to the current
  // minor, so a plain `reso-cert core --url …` certifies the latest Core without the caller passing a version.
  .option(
    '--spec-version <version>',
    `Web API Core spec version: ${SUPPORTED_CORE_VERSIONS.join(' or ')}. Certification is on ${CERTIFIABLE_CORE_VERSIONS.join(' or ')}, the latest minor; an older one runs as a retest`,
    CURRENT_CORE_VERSION
  )
  .option(
    '--enum-mode <mode>',
    "Enum mode: auto, string, collections or isflags (default: the config entry's coreOptions.enumMode, else auto-detect)"
  )
  .option(
    '--full-coverage',
    'Fail if any data type is met on no resource tested, the strict mode for Core 2.0.0 parity. Without it, every type the server declares must still be met and pass, and a type it never declares is not required'
  )
  .option(
    '--save-payloads <dir>',
    'Write every request and response to <dir>, one JSON file each. Off unless given. Contains provider data; credentials are never written'
  )
  .option('--originating-system-name <v>', 'Scope resource queries to OriginatingSystemName eq <v> (multi-tenant providers)')
  .option('--originating-system-id <v>', 'Scope resource queries to OriginatingSystemID eq <v> (used when no name; OSN takes precedence)')
  .option(
    '--field-overrides <list>',
    'Comma-separated Resource.Field (e.g., Office.FeedTypes). The named field REPLACES automatic selection for ' +
      'its data type: it is the field tested, there is no fallback behind it, and a failure on it is a failure. ' +
      'Sparse – every slot you do not name still auto-selects. Replaces coreOptions.fieldOverrides from a config.'
  )
  // Removed in 0.11.1, declared only so the old spelling gets an explanation instead of "unknown option".
  // Its value is never read, so nothing downstream depends on the old name.
  .option('--prefer-fields <list>', 'Removed – use --field-overrides (see the message it prints).')
  .option(
    '--start-cloud-run',
    "At the end, start a certification run in RESO's cloud for the entries that passed and can be certified. " +
      'Needs --config. Without it, nothing is started'
  );

addAuthOptions(coreCmd);
addOutputOptions(coreCmd);
coreCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    resources?: string;
    startCloudRun?: boolean;
    specVersion: string;
    enumMode?: string;
    fullCoverage?: boolean;
    originatingSystemName?: string;
    originatingSystemId?: string;
    fieldOverrides?: string;
    /** Removed in 0.11.1 — read only to explain the change, never forwarded. */
    preferFields?: string;
    savePayloads?: string;
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
      const cloudRefusal = startCloudRunRefusal(opts);
      if (cloudRefusal !== undefined) throw new Error(cloudRefusal);

      if (!isCoreVersion(opts.specVersion)) {
        throw new Error(`Invalid --spec-version "${opts.specVersion}". Must be one of: ${SUPPORTED_CORE_VERSIONS.join(', ')}.`);
      }
      const specVersion = opts.specVersion;

      // Flags apply only when given: a config entry's coreOptions block is the next source, then auto-detect.
      const enumModeFlag = opts.enumMode as 'auto' | 'isflags' | 'collections' | 'string' | undefined;
      // `--prefer-fields` was the 0.11.0 spelling and it re-ordered candidates instead of replacing them. The
      // value is deliberately NOT forwarded: silently rerouting it would give the old flag the new, binding
      // behavior, which is a different thing from what its user asked for. Say what changed and let them retype.
      if (typeof opts.preferFields === 'string' && opts.preferFields.trim().length > 0) {
        console.error(overrideRenameNotice('--prefer-fields', '--field-overrides', [opts.preferFields]));
      }
      // An override list from the flag replaces the config's rather than merging: what the operator typed
      // should be exactly what runs, with no invisible union from the file.
      const fieldOverridesFlag: ReadonlyArray<string> | undefined =
        typeof opts.fieldOverrides === 'string' && opts.fieldOverrides.trim().length > 0
          ? opts.fieldOverrides
              .split(',')
              .map((v: string) => v.trim())
              .filter((v: string) => v.length > 0)
          : undefined;
      if (enumModeFlag !== undefined && !['auto', 'isflags', 'collections', 'string'].includes(enumModeFlag)) {
        throw new Error(`Invalid enum mode "${opts.enumMode}". Must be "auto", "string", "collections" or "isflags".`);
      }

      const renderMode = resolveRenderMode(opts);
      const resources = opts.resources?.split(',').map(r => r.trim());

      let results: ReadonlyArray<PipelineResult>;
      let stopped = 0;
      // Each entry as it ran, for the cloud-run choice at the end. Config-file mode only.
      let ranForCloud: RanForCloud | undefined;

      if (opts.config) {
        // Config-file mode — run every entry. The entry supplies server/auth/version/OSN (reso-certification-utils
        // format); CLI flags apply run-level knobs (resources / enum-mode / coverage) and can override auth/OSN.
        const configFile = await loadConfigFile(resolve(opts.config));
        const uoiRefusal = startCloudRunRefusal(opts, configFile.providerUoi);
        if (uoiRefusal !== undefined) throw new Error(uoiRefusal);
        // A config still carrying the removed key gets the same explanation the flag gets. Its value is not
        // forwarded: rerouting it would hand the old key the new binding behavior, which is not what its
        // author asked for. Deduplicated across entries so a multi-recipient config says it once.
        const removedInConfig = [...new Set(configFile.configs.flatMap(entry => removedPreferFields(entry.coreOptions)))];
        if (removedInConfig.length > 0) {
          console.error(overrideRenameNotice('coreOptions.preferFields', 'coreOptions.fieldOverrides', removedInConfig));
        }
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
            ...((fieldOverridesFlag ?? baseConfig.fieldOverrides)
              ? { fieldOverrides: fieldOverridesFlag ?? baseConfig.fieldOverrides }
              : {}),
            // Resolved here so every entry of a multi-entry config writes under one known directory
            // rather than wherever each happened to be invoked from.
            ...(opts.savePayloads ? { savePayloadsDir: resolve(opts.savePayloads) } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return { config, label: entry.description ?? runLabel(entry, configFile.providerUoi) };
        });

        const entryRefusal = startCloudRunEntryRefusal(opts, entries);
        if (entryRefusal !== undefined) throw new Error(entryRefusal);

        const outcomes = await runConfigEntries(entries, renderMode);
        results = resultsOf(outcomes);
        stopped = stoppedOf(outcomes).length;
        ranForCloud = {
          providerUoi: configFile.providerUoi,
          ...(configFile.concurrency === undefined ? {} : { concurrency: configFile.concurrency }),
          ran: entries.map((entry, index) => ({ label: entry.label, config: entry.config, outcome: outcomes[index] }))
        };
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
          ...(fieldOverridesFlag ? { fieldOverrides: fieldOverridesFlag } : {}),
          ...(opts.savePayloads ? { savePayloadsDir: resolve(opts.savePayloads) } : {}),
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

      process.exitCode = resolveExitCode(results, stopped);

      if (ranForCloud !== undefined) {
        await offerAtEnd({ ...ranForCloud, endorsementLabel: 'Web API Core' }, ranForCloud.ran, opts);
      }
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
  .option('--config <path>', 'Path to a config file – runs every entry (mutually exclusive with --url)')
  // No Commander default here on purpose. With one, the action cannot tell `--dd-version 2.1` from
  // nothing supplied, and config mode needs that distinction to let an explicit flag win.
  .option(
    '--dd-version <version>',
    `DD version (${TESTABLE_DD_VERSIONS.join(' or ')}; default ${CURRENT_DD_VERSION}). Certification is on ${CERTIFIABLE_DD_VERSIONS.join(' or ')}, the latest minor; an older one runs as a retest`
  )
  .option(
    '--limit <n>',
    'Max records to replicate per resource. Certification samples up to 100000; a higher limit is a larger sample and certifies. ' +
      'A limit below 100000 is for local testing: the run is NOT eligible for certification and starts no cloud run ' +
      "(default: the config entry's ddOptions.limit, else 100000)"
  )
  // Strict is the default, so `--strict` is a no-op kept for compatibility and `--no-strict` is the
  // real switch. BOTH are declared rather than `--no-strict` alone: declaring only the negation makes
  // Commander default `opts.strict` to true, which would destroy the same absent-vs-explicit
  // distinction the --dd-version comment above protects, and config mode needs it to let a flag win.
  // With both declared, opts.strict is undefined / true / false — verified against commander 12.
  .option('--strict', 'Fail the run on JSON schema validation errors (the default)')
  .option(
    '--no-strict',
    'Record schema validation errors without failing on them, so a long run surveys everything to fix. The run is NOT eligible for certification'
  )
  .option('--skip-variations', 'Do not check variations. The step is reported as skipped and the run is NOT eligible for certification')
  .option('--batch-expand', 'Batch all expansions per resource into a single $expand request')
  .option('--originating-system-name <v>', 'Append OriginatingSystemName eq <v> to every replication query (multi-tenant providers)')
  .option(
    '--originating-system-id <v>',
    'Append OriginatingSystemID eq <v> to every replication query (used when no name; OSN takes precedence)'
  )
  .option(
    '--start-cloud-run',
    "At the end, start a certification run in RESO's cloud for the entries that passed and can be certified. " +
      'Needs --config. Without it, nothing is started'
  );

addAuthOptions(ddCmd);
addOutputOptions(ddCmd);

ddCmd.action(
  async (opts: {
    url?: string;
    config?: string;
    ddVersion?: string;
    limit?: string;
    strict?: boolean;
    skipVariations?: boolean;
    batchExpand?: boolean;
    originatingSystemName?: string;
    originatingSystemId?: string;
    startCloudRun?: boolean;
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
      const cloudRefusal = startCloudRunRefusal(opts);
      if (cloudRefusal !== undefined) throw new Error(cloudRefusal);
      // A run that is not strict, skips variations or samples with --limit cannot be certified, so it could not
      // start a cloud run. Refused from the flags before the config file is read.
      const flagRefusal = opts.startCloudRun ? ddFlagsRefusedBeforeRun(opts) : undefined;
      if (flagRefusal !== undefined) throw new Error(flagRefusal);

      const ddVersion = normalizeDDVersion(opts.ddVersion ?? CURRENT_DD_VERSION);

      // The variations step authenticates to the Variations Service with the tools .env
      // OAuth2 client credentials (TOKEN_URI / CLIENT_ID / CLIENT_SECRET), as find-variations
      // does — so a config-driven run computes against the environment those credentials
      // belong to. When they are absent the service wrapper falls back to the CERT_AUTH_API_*
      // provider-token mint, unchanged.
      const servicesAuthToken = await mintOAuth2ClientCredentialsToken();
      if (!isTestableDDVersion(ddVersion)) {
        throw new Error(
          `Invalid version "${opts.ddVersion}". This command runs DD ${TESTABLE_DD_VERSIONS.join(' or ')}, and certification is on ${CERTIFIABLE_DD_VERSIONS.join(' or ')}.`
        );
      }

      const renderMode = resolveRenderMode(opts);

      let results: ReadonlyArray<PipelineResult>;
      let stopped = 0;
      let ranForCloud: RanForCloud | undefined;

      if (opts.config) {
        // Config-file mode — run every entry. The entry supplies server/auth/version/OSN (reso-certification-utils
        // format); CLI flags apply run-level knobs (limit / strict / batch-expand) and can override auth/OSN.
        //
        // The entry's version wins UNLESS --dd-version was explicitly supplied, in which case the flag does.
        // Certifying one config against two Dictionary versions to compare them is an ordinary thing to want,
        // and the flag used to be accepted and discarded here -- the only evidence being the version in the
        // output path.
        const configFile = await loadConfigFile(resolve(opts.config));
        const uoiRefusal = startCloudRunRefusal(opts, configFile.providerUoi);
        if (uoiRefusal !== undefined) throw new Error(uoiRefusal);
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
            // Only set when the flag was passed; the entry's own ddOptions.limit stands otherwise, and with
            // neither the SDK applies its default (100000). A limit below the default is a sample for local
            // testing, so the SDK tells one that was set from the default by its presence: filling the default in
            // here made every entry carry a limit, which the verdict and the cloud path judge (dd-sample-limit.ts).
            ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
            // Tested against undefined, not for truthiness: `--no-strict` sets this to `false`, which a
            // truthiness test drops, so the flag would be accepted on the command line and then
            // silently ignored in config mode. Absent still means absent, letting the config entry's
            // own ddOptions.strictMode stand, and the SDK default (strict) apply when it has none.
            ...(opts.strict !== undefined ? { strictMode: opts.strict } : {}),
            // Only set when the flag was passed, so an untouched run never carries the field and
            // the default (run the check) stands.
            ...(opts.skipVariations ? { runVariations: false } : {}),
            ...(opts.batchExpand ? { batchExpand: true } : {}),
            ...(opts.originatingSystemName ? { originatingSystemName: opts.originatingSystemName } : {}),
            ...(opts.originatingSystemId ? { originatingSystemId: opts.originatingSystemId } : {}),
            ...(opts.outputDir ? { options: { ...baseConfig.options, outputDir: resolve(opts.outputDir) } } : {})
          };

          return { config, label: entry.description ?? runLabel(entry, configFile.providerUoi) };
        });

        const entryRefusal = startCloudRunEntryRefusal(opts, entries);
        if (entryRefusal !== undefined) throw new Error(entryRefusal);

        const outcomes = await runConfigEntries(entries, renderMode);
        results = resultsOf(outcomes);
        stopped = stoppedOf(outcomes).length;
        ranForCloud = {
          providerUoi: configFile.providerUoi,
          ...(configFile.concurrency === undefined ? {} : { concurrency: configFile.concurrency }),
          ran: entries.map((entry, index) => ({ label: entry.label, config: entry.config, outcome: outcomes[index] }))
        };
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
          // As in config mode: set only from the flag, so the SDK can tell a sample limit from its default.
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
          strictMode: opts.strict,
          ...(opts.skipVariations ? { runVariations: false } : {}),
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

      process.exitCode = resolveExitCode(results, stopped);

      if (ranForCloud !== undefined) {
        await offerAtEnd({ ...ranForCloud, endorsementLabel: 'Data Dictionary' }, ranForCloud.ran, opts);
      }
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
  .description('List the variations in review (your own as a provider, the whole pool as an admin) – read-only')
  .option('--status <status>', 'Filter by pool status: pending, ft-submitted or resolved')
  .option('--element-type <type>', 'Filter by element type: resource, field or lookup')
  .option('--provenance', 'Show every submission under each item instead of the summary table')
  .option('--csv', 'Print the items as CSV, in the same shape the desktop client exports')
  .option('--page-size <n>', 'Items per request to the service; every page is fetched regardless')
  .option('--json', 'Print the items exactly as the service returned them')
  .action(
    async (opts: { status?: string; elementType?: string; provenance?: boolean; pageSize?: string; json?: boolean; csv?: boolean }) => {
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
        // CSV is the only output meant to be redirected into a file, so it goes to stdout alone and
        // the count below still goes to stderr. `reso-cert list-variation-reviews --csv > sheet.csv`
        // then yields a file `submit-variation-decisions` can read back.
        if (opts.csv) {
          console.log(formatReviewItemsCsv(items));
          console.error(`${items.length} item(s) in review${opts.status ? ` with status ${opts.status}` : ''}.`);
          return;
        }
        console.log(opts.provenance ? formatProvenance(items) : formatReviewItemsTable(items));
        console.error(`${items.length} item(s) in review${opts.status ? ` with status ${opts.status}` : ''}.`);
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    }
  );

const ENDORSEMENT_REVIEW_STATUSES: ReadonlyArray<EndorsementReviewStatus> = ['none', 'in-review', 'resolved'];

program
  .command('variations-review-status')
  .description('Show where each of your variations submissions stands (lifecycle and review status) – read-only')
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

// ── Cloud runs ──
//
// Where each run in RESO's cloud stands. A cloud run is started only at the end of a local run that passed
// (`core --start-cloud-run`), never on its own. Auth as the variations commands: an
// OAuth2 client_credentials token from .env (TOKEN_URI / CLIENT_ID / CLIENT_SECRET), falling back to the
// CERT_AUTH_API_* provider-token mint.

const cloudCmd = program.command('cloud').description("Certification runs in RESO's cloud: see where each stands, or follow them live");

cloudCmd
  .command('status')
  .description('List your cloud runs and where each stands, newest change first – read-only')
  .option('--since <time>', 'Only runs changed since this time: an ISO timestamp or epoch milliseconds')
  .option('--status <list>', 'Only runs in these statuses, comma-separated (for example running,failed)')
  .option('--in-progress', 'Only runs still scheduled or running')
  .option('--limit <n>', 'At most this many rows')
  .option('--json', 'Print the rows exactly as the service returned them')
  .action(async (opts: { since?: string; status?: string; inProgress?: boolean; limit?: string; json?: boolean }) => {
    try {
      const limit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error(`--limit must be a positive whole number, got '${opts.limit}'`);
      }
      const statuses = opts.status
        ?.split(',')
        .map(s => s.trim())
        .filter(s => s !== '');
      const bearerToken = await mintOAuth2ClientCredentialsToken();
      const page = await listCloudRunStatus({
        fromCli: true,
        ...(bearerToken ? { bearerToken } : {}),
        ...(opts.since === undefined ? {} : { since: opts.since }),
        ...(statuses === undefined ? {} : { statuses }),
        ...(opts.inProgress ? { inProgressOnly: true } : {}),
        ...(limit === undefined ? {} : { limit })
      });
      console.log(maskSecrets(opts.json ? JSON.stringify(page, null, 2) : formatRunStatusTable(page)));
    } catch (error) {
      console.error('Error:', maskSecrets(error instanceof Error ? error.message : String(error)));
      process.exitCode = 2;
    }
  });

/** Collects a repeatable option's values, in the order given. No default, so the help shows none. */
const repeatable = (value: string, previous: ReadonlyArray<string> | undefined): ReadonlyArray<string> => [...(previous ?? []), value];

// `cloud watch` follows runs over RESO's live updates (a WebSocket) instead of polling. The token comes from the same
// chain as `cloud status`, minted again on every connect so a reconnect never presents an expired one.
cloudCmd
  .command('watch')
  .description('Follow your cloud runs live as they change, one line per update with a running tally – read-only')
  .option('--request <id>', 'Only this request; repeat for more', repeatable)
  .option('--endorsement <name>', 'Only this endorsement, for example data-dictionary; repeat for more', repeatable)
  .option('--env <name>', 'The environment your credentials are for: local, qa, staging or production (default: read from your runs)')
  .option('--until-done', 'Exit once every watched request has finished: 0 if all passed, 1 if any failed or errored')
  .option('--json', 'Print each update as the service sent it, one JSON object per line')
  .action(
    async (opts: {
      request?: ReadonlyArray<string>;
      endorsement?: ReadonlyArray<string>;
      env?: string;
      untilDone?: boolean;
      json?: boolean;
    }) => {
      try {
        const prerequisite = cloudWatchPrerequisite(process.env);
        if (prerequisite !== undefined) throw new Error(prerequisite);
        const endpoint = resolveCloudUpdatesUrl();
        const credentials = cliCredentialsTokenProvider();
        process.exitCode = await runCloudWatch(
          {
            requestIds: opts.request ?? [],
            endorsements: opts.endorsement ?? [],
            ...(opts.env === undefined ? {} : { environmentName: opts.env }),
            untilDone: opts.untilDone === true,
            json: opts.json === true
          },
          {
            readStatus: async () => {
              const bearerToken = await credentials();
              return listCloudRunStatus({ fromCli: true, ...(bearerToken ? { bearerToken } : {}), limit: STATUS_READ_LIMIT });
            },
            subscribe: input => subscribeToCloudUpdates({ endpoint, token: credentials, ...input }),
            write: text => {
              process.stdout.write(maskSecrets(text));
            },
            warn: line => console.error(maskSecrets(line)),
            isTty: process.stdout.isTTY === true,
            onInterrupt: handler => {
              process.once('SIGINT', handler);
              return () => {
                process.off('SIGINT', handler);
              };
            }
          }
        );
      } catch (error) {
        console.error('Error:', maskSecrets(error instanceof Error ? error.message : String(error)));
        process.exitCode = 2;
      }
    }
  );

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
    'Synthesize the top-level resources[] block on a DD 2.0/2.1 metadata report so it can be loaded by tools that expect a DD 2.2-shaped report. Idempotent: DD 2.2+ reports pass through unchanged.'
  )
  .requiredOption('--in <path>', 'Input metadata report JSON file')
  .requiredOption('--out <path>', 'Output path for the adapted report')
  .option('--pretty', 'Pretty-print the output JSON (2-space indent)')
  .action(async (opts: { in: string; out: string; pretty?: boolean }) => {
    try {
      const inPath = resolve(opts.in);
      const outPath = resolve(opts.out);

      const raw = await readFile(inPath, 'utf-8');
      const parsed = normalizeReportFieldTypes(JSON.parse(raw) as MetadataReport);
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
  .requiredOption('-p, --payload <file>', 'Payload JSON: an OData collection { value: [...] } or a single record, or "-" for stdin')
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <version>', 'DD version for the schema context', CURRENT_DD_VERSION)
  .option(
    '-r, --resource <name>',
    'Resource name when the payload carries no @reso.context (a present context names the resource); default Property'
  )
  .option('-s, --settings <file>', 'schema-validation-settings.json (else ./ then the prebaked copy)')
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
            ? `PASS: 0 schema validation errors (report: ${dest})\n`
            : `FAIL: ${totalErrors} schema validation error(s) (report: ${dest})\n`
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
  .description('Metadata step: validate OData CSDL/EDMX (XSD + semantic) and convert it to a RESO Format metadata report')
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
        const dest = await writeArtifact(opts.outputDir, 'metadata-report.json', withSoftwareVersion(result.report));
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
  .option('-m, --metadata <path>', 'Metadata report JSON – replicate every resource in it (report-driven mode)')
  .option('-x, --expansions <list>', 'Comma-separated expansions such as Media,OpenHouse (single-resource mode)')
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
  .option('--strict', 'Fail on schema-validation errors (the default when validation is on)')
  .option('--no-strict', 'Record schema-validation errors without failing on them')
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
          `\nreplicate: ${result.strategy} complete (${result.stats.totalRecordsFetched.toLocaleString()} records, ` +
            `${result.stats.totalRequests.toLocaleString()} requests) → ${result.outputDir}\n`
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
// RCF providers deliver data, not a schema – a .json/.zip/directory of payloads or records. This
// streams the input, schema-validates it against the DD (unless --skip-schema-validation), reverse-
// infers a DD-2.0 metadata report + a data-availability report, and runs the variations service on
// the inferred report – the same two artifacts as a DD 2.0 run, plus the variations report. Both
// checks run by default, because certification needs both. Skipping either is for other testing.

program
  .command('rcf')
  .description('RESO Common Format: infer a Data Dictionary metadata report from RCF data and run variations')
  .requiredOption('-i, --input <path>', 'RCF input: a .json file, a .zip or a directory of payloads/records')
  // `--dd-version`, not `-v, --version`: the program's own version flag wins over a subcommand's,
  // so the old spelling printed the package version and exited 0 without ever running the command.
  .option('--dd-version <ver>', `DD version. Without it, the first payload's @reso.context decides, else ${RCF_DEFAULT_DD_VERSION}`)
  .option('-f, --fuzziness <float>', `Variations fuzzy-match threshold (0–1, default ${DEFAULT_FUZZINESS})`, String(DEFAULT_FUZZINESS))
  .option('--output-dir <path>', 'Directory for the reports (created if missing)', '.')
  .option(
    '--skip-schema-validation',
    'Do not schema-validate the payloads against the DD before inferring. The run is NOT eligible for certification'
  )
  .option(
    '--schema-validate',
    'Accepted for compatibility: schema validation is the default (RCF is taken as-is: local fields and values are accepted; a DD field must have the right type; length, precision and scale beyond the DD are warnings)'
  )
  .option(
    '-a, --additional-properties',
    'Accepted for compatibility: extension is always allowed on RCF (local fields and values), so this flag has no effect here'
  )
  .option('--strict', 'Fail fast on the first schema-validation error')
  .option('--skip-variations', 'Do not check variations. The run is NOT eligible for certification')
  .option(
    '--provider-uoi <uoi>',
    `Your organization's UOI. With --provider-usi and --recipient-uoi, variations are also written to ${SUBMITTABLE_REPORT_FILENAME} for submit-variations-report`
  )
  .option('--provider-usi <usi>', 'The system (USI) the data comes from')
  .option('--recipient-uoi <uoi>', 'The organization (UOI) the data is for')
  .option(
    '--start-cloud-run',
    "At the end, start a certification run in RESO's cloud if this one passes and can be certified: the files it read " +
      'are packed, uploaded and run there. Needs --provider-uoi, --provider-usi and --recipient-uoi. Without it, nothing is started'
  )
  .action(
    async (opts: {
      input: string;
      ddVersion?: string;
      fuzziness: string;
      outputDir: string;
      skipSchemaValidation?: boolean;
      schemaValidate?: boolean;
      additionalProperties?: boolean;
      strict?: boolean;
      skipVariations?: boolean;
      providerUoi?: string;
      providerUsi?: string;
      recipientUoi?: string;
      startCloudRun?: boolean;
    }) => {
      try {
        const fuzziness = Number.parseFloat(opts.fuzziness);
        if (!Number.isFinite(fuzziness) || fuzziness < 0 || fuzziness > 1) {
          throw new Error(`--fuzziness must be a number in [0, 1], got '${opts.fuzziness}'`);
        }
        if (opts.schemaValidate && opts.skipSchemaValidation) {
          throw new Error('--schema-validate and --skip-schema-validation cannot both be given');
        }
        const schemaValidate = !opts.skipSchemaValidation;
        // Read before the run, so a partial identity stops it here rather than after the work is done.
        const identityRead = readRcfReportIdentity({
          providerUoi: opts.providerUoi,
          providerUsi: opts.providerUsi,
          recipientUoi: opts.recipientUoi
        });
        if (!identityRead.ok) throw new Error(identityRead.error);
        // Also before the run, so a long run is not wasted: a cloud run is addressed to a provider, system and
        // recipient, and needs the service's address and credentials. Nothing is sent before the run passes.
        if (opts.startCloudRun && identityRead.identity === undefined) {
          throw new Error(
            '--start-cloud-run needs --provider-uoi, --provider-usi and --recipient-uoi: a cloud run is addressed to all three.'
          );
        }
        const cloudPrerequisite = opts.startCloudRun ? cloudRunPrerequisite(process.env) : undefined;
        if (cloudPrerequisite !== undefined) throw new Error(cloudPrerequisite);
        const dir = resolve(opts.outputDir);

        // The pipeline the SDK runs, so a local run and a cloud run of the same files are the same run. It writes the
        // reports, report.json among them, into the output directory.
        const rcfRun: RcfConfig = {
          endorsement: 'rcf',
          input: resolve(opts.input),
          version: opts.ddVersion,
          fuzziness,
          strict: opts.strict,
          schemaValidate,
          runVariations: !opts.skipVariations,
          ...(identityRead.identity ?? {}),
          options: { outputDir: dir }
        };
        // A run that skips schema validation or variations cannot be certified, so it could not start a cloud run.
        // Refused before the run, as the other flags are, so a long run is not wasted.
        const uncertifiable = opts.startCloudRun ? whyNoCloudRunBeforeRun(rcfRun) : undefined;
        if (uncertifiable !== undefined) {
          throw new Error(
            `--start-cloud-run starts from a run that can be certified and sent, and ${uncertifiable}. It does not go with --skip-schema-validation or --skip-variations.`
          );
        }
        // The /compute token for the variations service (from .env; the service mints its own if absent).
        const bearerToken = opts.skipVariations ? undefined : await mintOAuth2ClientCredentialsToken();
        const rcfConfig: RcfConfig = { ...rcfRun, ...(bearerToken ? { servicesAuthToken: bearerToken } : {}) };
        const run = await runRcfCompliance(rcfConfig);
        const outcome = rcfRunOutcome(run);
        if (!outcome.inferred) {
          process.stderr.write(`rcf: ${outcome.error}\n`);
          process.exitCode = outcome.schemaFailure ? 1 : 2;
          return;
        }
        const result = outcome.inferred;

        const s = result.stats;
        process.stderr.write(
          `rcf: DD${result.version} – ${s.totalRecords.toLocaleString()} records → ${s.resources} resources, ${s.fields.toLocaleString()} fields, ${s.lookups.toLocaleString()} lookups${schemaValidate ? `; ${s.schemaErrors} schema error(s)` : ''}${s.variationsTotal !== undefined ? `; ${s.variationsTotal} variation(s)` : ''} → ${dir}\n`
        );
        if (result.variationsError) {
          process.stderr.write(`rcf: variations skipped (reports still written): ${result.variationsError}\n`);
        }
        // Accepted, so not variations, but deprecated: say so once, with a few examples and where the rest are.
        const deprecations = result.variations?.deprecations ?? [];
        if (deprecations.length > 0) {
          const examples = deprecations
            .slice(0, 3)
            .map(d => `${d.fieldName} ${d.lookupValue} → ${d.standardLookupValue}`)
            .join('; ');
          process.stderr.write(
            `rcf: ${deprecations.length} lookup value(s) use the machine-friendly form, accepted until DD ${deprecations[0].deprecatedInVersion} and deprecated there (${examples}${deprecations.length > 3 ? '; ...' : ''}). All are listed under "deprecations" in ${VARIATIONS_REPORT_FILENAME}\n`
          );
        }
        // The pipeline wrote it when there is one; this only says where.
        if (submittableVariationsReport(result, identityRead.identity, run.context.generatedOn as string)) {
          const reportPath = resolve(dir, SUBMITTABLE_REPORT_FILENAME);
          process.stderr.write(`rcf: to start a review of these variations: reso-cert submit-variations-report --report ${reportPath}\n`);
        } else if (!identityRead.identity && (s.variationsTotal ?? 0) > 0) {
          process.stderr.write(
            'rcf: to submit these variations for review, run again with --provider-uoi, --provider-usi and --recipient-uoi\n'
          );
        }
        if (s.totalRecords === 0) {
          process.stderr.write(`rcf: no certifiable records were ingested from ${resolve(opts.input)} – nothing to certify\n`);
        }
        if (s.invalidContextFiles > 0) {
          process.stderr.write(
            `rcf: ${s.invalidContextFiles} file(s) carry an unreadable @reso.context (${s.invalidContextRecords} record(s) not certified)${
              opts.schemaValidate
                ? ' – counted among the schema errors above\n'
                : ' – run with --schema-validate to have them reported as schema errors\n'
            }`
          );
        }
        // Zero-record (empty/unreadable) submissions and degraded variations runs must not read as a clean pass.
        process.exitCode = resolveRcfExitCode(result);

        // The choice at the end, as for every other endorsement: the files the run read are packed, uploaded and
        // run in RESO's cloud by `startCloudRun`. Only a run addressed to a provider, system and recipient is offered.
        if (identityRead.identity) {
          const label = cloudTargetLabel(rcfConfig) ?? 'rcf';
          await offerAtEnd(
            { providerUoi: identityRead.identity.providerUoi, endorsementLabel: 'RESO Common Format' },
            [{ label, config: rcfConfig, outcome: { label, result: run } }],
            opts
          );
        }
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
  .description('Submit a variations report from a DD or rcf run to the Variations Service to start or refresh a review')
  .requiredOption('-r, --report <path>', 'Path to the variations-report.json a DD or rcf run produced')
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
        console.log('Dry run: nothing was sent.');
        console.log(`  Would submit ${result.changeCount} change(s) for ${where}.`);
        console.log('  Everything currently on record for this report is replaced, not merged.');
        console.log('  Rerun without --dry-run to submit.');
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
  .requiredOption('-r, --report <path>', 'Path to the variations-report.json a DD or rcf run produced')
  .requiredOption('-d, --decisions <path>', 'Path to the sheet (Resource Name, Field Name, Lookup Value, Action, Comment)')
  .option('--dry-run', 'Show what would be marked and send nothing')
  .option('--json', 'Print the marked report instead of submitting it')
  .action(async (opts: { report: string; decisions: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const report = JSON.parse(await readFile(resolve(opts.report), 'utf-8')) as Record<string, unknown>;
      const { items, recognizedColumns, skippedColumns, undecidedRows } = parseDecisionsCsv(
        await readFile(resolve(opts.decisions), 'utf-8')
      );
      if (skippedColumns.length) {
        console.error(`Ignoring unrecognized columns: ${skippedColumns.join(', ')}`);
      }
      // Named, not just counted. A row left blank on purpose and a row whose Action was mistyped
      // look identical here, so the only way someone can tell them apart is by reading the list.
      if (undecidedRows.length) {
        console.error(
          `${undecidedRows.length} row(s) carry no Action or Comment and will be left as they are: ${undecidedRows.join(', ')}`
        );
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
        console.log('Dry run: nothing was sent.');
        console.log('  Submitting replaces everything currently on record for this report. It does not merge.');
        console.log('  Rerun without --dry-run to submit.');
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

program
  .command('apply-variation-decisions')
  .description(
    "RESO staff: apply a sheet of actions and comments to a variations report that is already under review, as a merge. Only the sheet's items change; everything else on the review stays as it is"
  )
  .requiredOption('--provider-uoi <uoi>', 'The provider the report is about (UOI)')
  .requiredOption('--provider-usi <usi>', 'The system the report was run against (USI)')
  .requiredOption('--recipient-uoi <uoi>', 'The organization the report is for (UOI)')
  .option('--dd-version <version>', 'The Data Dictionary version of the report', CURRENT_DD_VERSION)
  .requiredOption(
    '-d, --decisions <path>',
    'The sheet: Resource Name, Field Name, Lookup Value, Action, Comment (list-variation-reviews --csv writes one)'
  )
  .option('--dry-run', 'Show what would change and send nothing')
  .option('--json', 'Print the plan as JSON')
  .action(
    async (opts: {
      providerUoi: string;
      providerUsi: string;
      recipientUoi: string;
      ddVersion: string;
      decisions: string;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      try {
        const sheet = parseDecisionsCsv(await readFile(resolve(opts.decisions), 'utf-8'));
        if (sheet.skippedColumns.length) console.error(`Ignoring unrecognized columns: ${sheet.skippedColumns.join(', ')}`);
        if (sheet.undecidedRows.length) {
          console.error(
            `${sheet.undecidedRows.length} row(s) carry no Action or Comment and are left as they are: ${sheet.undecidedRows.join(', ')}`
          );
        }
        console.log(`Parsed ${sheet.items.length} row(s) from columns: ${sheet.recognizedColumns.join(', ')}.`);
        const coordinates = {
          version: opts.ddVersion,
          providerUoi: opts.providerUoi,
          providerUsi: opts.providerUsi,
          recipientUoi: opts.recipientUoi
        };
        const bearerToken = await mintOAuth2ClientCredentialsToken();
        const { plan, sent, mismatches } = await applyVariationDecisionsViaService({
          coordinates,
          rows: sheet.items,
          fromCli: true,
          ...(opts.dryRun ? { dryRun: true } : {}),
          ...(bearerToken ? { bearerToken } : {})
        });
        const where = `${opts.providerUoi} / ${opts.providerUsi} → ${opts.recipientUoi}, DD ${opts.ddVersion}`;
        if (plan.errors.length > 0) {
          console.error(`The sheet has ${plan.errors.length} unusable row(s). Nothing was sent.`);
          for (const error of plan.errors) console.error(`  • ${error}`);
          process.exitCode = 2;
          return;
        }
        if (opts.json) console.log(JSON.stringify(plan, null, 2));
        if (plan.unchanged.length) console.log(`Already as the sheet says (${plan.unchanged.length}): ${plan.unchanged.join('; ')}`);
        for (const warning of plan.warnings) console.log(`Note: ${warning}`);
        if (plan.items.length === 0) {
          console.log(`Nothing to change on ${where}.`);
          return;
        }
        console.log(`${summarizeApplyPlan(plan)} Report: ${where}.`);
        console.log(formatApplyItems(plan));
        if (!sent) {
          console.log('Dry run: nothing was sent. The save is a merge: it changes only these items. Rerun without --dry-run to send it.');
          return;
        }
        if (mismatches.length > 0) {
          console.error(`Saved, but ${mismatches.length} item(s) do not show what was sent:`);
          for (const mismatch of mismatches) console.error(`  • ${mismatch}`);
          process.exitCode = 2;
          return;
        }
        console.log('Saved as one merge, and read back: every item shows what was sent, in the report and in the review pool.');
      } catch (error) {
        const code = (error as { code?: string }).code;
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
    }
  );

program
  .command('restore')
  .description("Restore to a Cert API: a run's stored results, published as the run would have, or a certification server backup")
  .requiredOption(
    '--path <dir>',
    'A stored run, or any directory above stored runs (<endorsement>-<version>/<providerUoi>-<providerUsi>/<recipientUoi>/<run>); or a backup root holding endorsement-type folders'
  )
  .option('--url <url>', 'Cert API origin. Without it, the origin of TOKEN_URI in the credentials file')
  .option('--execute', 'Actually send. Without it this is a dry run and nothing is posted.')
  .option('--notify-provider', 'Stored runs: email each provider the passed notice once both reports are on file')
  .option('--limit <n>', 'Stop after this many runs or reports, for a smoke test')
  .option('--concurrency <n>', 'Backups: reports in flight at once', '4')
  .option('--ledger <path>', 'Where restored keys are recorded so a re-run resumes')
  .option('--derive-missing-type', 'Backups: supply a missing report type where the directory and the document version agree')
  .action(
    async (opts: {
      path: string;
      url?: string;
      execute?: boolean;
      notifyProvider?: boolean;
      limit?: string;
      concurrency: string;
      ledger?: string;
      deriveMissingType?: boolean;
    }) => {
      try {
        const limit = opts.limit === undefined ? undefined : Number.parseInt(opts.limit, 10);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new Error(`--limit must be a positive integer, got '${opts.limit}'`);
        }
        const concurrency = Number.parseInt(opts.concurrency, 10);
        if (!Number.isInteger(concurrency) || concurrency <= 0) {
          throw new Error(`--concurrency must be a positive integer, got '${opts.concurrency}'`);
        }
        const origin = resolveCertApiOrigin({ ...(opts.url === undefined ? {} : { url: opts.url }), env: process.env });
        // CLIENT_SECRET only ever goes to this origin's token endpoint; every post carries the token it returns.
        const authorize = (): Promise<string> => resolveCertApiAuthorization({ env: process.env, origin });
        const ledgerPath = opts.ledger ?? `${opts.path.replace(/\/+$/, '')}/.restore-ledger`;
        const execute = Boolean(opts.execute);

        const stored = findStoredRuns(opts.path);
        if (stored.runs.length > 0 || stored.unplaced.length > 0) {
          const { outcomes, unplaced } = await runRunRestore(
            {
              path: opts.path,
              origin,
              execute,
              notifyProvider: Boolean(opts.notifyProvider),
              done: readLedger(ledgerPath),
              record: key => appendFileSync(ledgerPath, `${key}\n`),
              authorize,
              ...(limit === undefined ? {} : { limit })
            },
            (line: string) => console.error(line)
          );
          console.log(execute ? 'Restore of stored runs' : 'DRY RUN - nothing was sent');
          console.log(`  Cert API       : ${origin}`);
          console.log(`  provider email : ${opts.notifyProvider ? 'yes, once both reports are on file' : 'no'}`);
          for (const outcome of outcomes) {
            const { endorsement, version, providerUoi, providerUsi, recipientUoi } = outcome.identity;
            const who = `${endorsement} ${version}, provider ${providerUoi} (${providerUsi}), recipient ${recipientUoi}`;
            const what =
              outcome.status === 'published'
                ? `published as report ${outcome.reportId}`
                : outcome.status === 'would-publish'
                  ? 'would publish'
                  : outcome.status === 'already-done'
                    ? 'already restored (in the ledger)'
                    : `${outcome.status}: ${outcome.reason}`;
            console.log(`\n  ${outcome.key}\n    ${who}\n    ${what}`);
            if (outcome.droppedKeys && outcome.droppedKeys.length > 0) {
              console.log(`    left out of the metadata post, which the API refuses: ${outcome.droppedKeys.join(', ')}`);
            }
          }
          for (const path of unplaced) {
            console.error(
              `\n  skipped ${path}: it holds a run's files but not the stored layout, so whose run it is cannot be read from its path`
            );
          }
          if (outcomes.some(o => o.status === 'failed' || o.status === 'refused') || unplaced.length > 0) process.exitCode = 1;
          return;
        }

        const summary = await runRestore(
          {
            path: opts.path,
            url: origin,
            execute,
            ...(limit === undefined ? {} : { limit }),
            concurrency,
            deriveMissingType: Boolean(opts.deriveMissingType),
            ledgerPath,
            authorize
          },
          (line: string) => console.error(line)
        );

        console.log(opts.execute ? 'Restore' : 'DRY RUN - nothing was sent');
        console.log(`  found        : ${summary.considered}`);
        console.log(`  already done : ${summary.alreadyDone}`);
        console.log(
          `  ${opts.execute ? 'sent' : 'would send'} : ${opts.execute ? summary.sent : summary.considered - summary.alreadyDone}`
        );
        if (opts.execute) console.log(`  succeeded    : ${summary.succeeded}`);
        if (summary.missingType > 0) {
          const action = opts.deriveMissingType ? 'type derived for' : 'would be refused, derivable';
          console.log(
            `  no type      : ${summary.missingType} (${action} ${summary.derivable}, different shape ${summary.missingType - summary.derivable})`
          );
        }
        for (const [endorsement, count] of [...summary.byEndorsement].sort((a, b) => b[1] - a[1])) {
          console.log(`    ${String(count).padStart(6)}  ${endorsement}`);
        }
        if (summary.failures.length > 0) {
          console.error(`\n${summary.failures.length} failed. First few:`);
          for (const failure of summary.failures.slice(0, 5)) {
            console.error(`  ${failure.status}  ${failure.key}  ${failure.message}`);
          }
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    }
  );

// Archiving a report, as the certification site does: the same warning first, the same POST after,
// with the credential the site's downloaded credentials file carries. The Cert API is found through
// TOKEN_URI in that file, or named with --url. Nothing is archived without --confirm.
program
  .command('archive-report')
  .description('Archive a certification report, with the warning the certification site shows. Archives only with --confirm.')
  .argument('<reportId>', 'The id of the report to archive, as the certification site shows it')
  .option('--confirm', 'Archive the report. Without it the warning is printed and nothing is archived.')
  .option('--url <url>', 'The Cert API origin. Default: taken from TOKEN_URI in the credentials file.')
  .option('--json', 'Print one JSON object with what was read and what happened, for scripts')
  .action(async (reportId: string, opts: { confirm?: boolean; url?: string; json?: boolean }) => {
    try {
      const say = (line: string): void => {
        if (!opts.json) console.log(maskSecrets(line));
      };
      const result: ArchiveReportResult = await runArchiveReport(
        { reportId, confirm: Boolean(opts.confirm), ...(opts.url === undefined ? {} : { url: opts.url }) },
        say
      );
      if (opts.json) console.log(maskSecrets(JSON.stringify(result, null, 2)));
      process.exitCode = archiveExitCode(result);
    } catch (error) {
      console.error('Error:', maskSecrets(error instanceof Error ? error.message : String(error)));
      process.exitCode = 2;
    }
  });

// Asking RESO's Assistant, with the credential the downloaded credentials file carries. A passthrough: the
// Assistant decides what this person may see. Progress goes to stderr, the answer to stdout.
program
  .command('ask')
  .description("Ask RESO's Assistant a question, as yourself. The Assistant is in a closed beta; its address comes with access.")
  .argument('<question...>', 'The question. Quote it, or give it as words.')
  .option('--origin <url>', 'Where the Assistant answers. Default: RESO_ASSISTANT_ORIGIN.')
  .option('--url <url>', 'The Cert API origin, which issues the token. Default: taken from TOKEN_URI in the credentials file.')
  .option('--json', 'Print the answer, its sources and any unconfirmed sections as one JSON object, for scripts')
  .option('--quiet', "Leave out the Assistant's progress lines")
  .action(async (words: string[], opts: { origin?: string; url?: string; json?: boolean; quiet?: boolean }) => {
    try {
      const showProgress = !opts.json && !opts.quiet;
      const answer = await runAsk({
        question: words.join(' '),
        ...(opts.origin === undefined ? {} : { origin: opts.origin }),
        ...(opts.url === undefined ? {} : { url: opts.url }),
        ...(showProgress ? { onStatus: withoutRepeats(text => console.error(maskSecrets(`… ${text}`))) } : {})
      });
      console.log(maskSecrets(opts.json ? JSON.stringify(answer, null, 2) : renderAnswer(answer)));
      process.exitCode = askExitCode();
    } catch (error) {
      console.error('Error:', maskSecrets(error instanceof Error ? error.message : String(error)));
      process.exitCode = askExitCode(error);
    }
  });

// RESO Analytics: what a provider's runs show over time. Read-only, from run directories on disk; nothing is sent.
const analyticsCmd = program
  .command('analytics')
  .description('RESO Analytics: how your certification runs change over time. Reads runs on disk; sends nothing.');

analyticsCmd
  .command('compare')
  .description(
    'Compare a Data Dictionary run with the run before it: what changed, by how much, and whether it is better or worse. ' +
      'Exit code 0 when compared, 1 when there is no earlier run, 2 on any other error.'
  )
  .argument('<run>', 'The run directory: …/current, …/archived/<timestamp>, or any directory holding a run’s reports')
  .argument('[previous]', 'The run to compare with. Default: the previous run of the same connection, from …/archived')
  .option('--json', 'Print the whole comparison as JSON, for scripts and agents')
  .option('--all', 'Show every metric for every resource, not only the ones that changed')
  .action(async (run: string, previous: string | undefined, opts: { json?: boolean; all?: boolean }) => {
    try {
      const comparison = await runCompare({ run, ...(previous === undefined ? {} : { previous }) });
      console.log(opts.json ? JSON.stringify(comparison, null, 2) : renderComparisonText(comparison, { all: Boolean(opts.all) }));
      process.exitCode = compareExitCode();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = compareExitCode(error);
    }
  });

program.parse();
