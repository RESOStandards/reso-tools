/**
 * What a cloud run is started from: a local run that passed.
 *
 * A provider starts a run in RESO's cloud only at the end of a local run of the same entry that passed and can be
 * certified. RESO runs the code on its own end, so the cloud run is the verdict that counts. The local run's record
 * travels with the request so the service can require a local pass and keep a record of it.
 *
 * The cloud entry is built from the configuration that ran, not from the file it came from, because CLI flags
 * (`--auth-token`, `--resources`, `--field-overrides` and the rest) override the file for the local run. The
 * cloud run has to be the same run.
 */

import { type AddEditAction, type AddEditFormats, type AddEditTestPlan, payloadsFor, planAddEditTests } from '../add-edit/plan.js';
import { CURRENT_ADD_EDIT_VERSION, whyAddEditVersionDoesNotCertify } from '../sdk/add-edit-versions.js';
import { coerceCoreVersion, whyCoreVersionDoesNotCertify } from '../sdk/core-versions.js';
import { DD_DEFAULT_SAMPLE_LIMIT_TEXT, isDDLimitBelowDefault } from '../sdk/dd-sample-limit.js';
import { whyDDVersionDoesNotCertify } from '../sdk/dd-versions.js';
import { serializeDDRemarks } from '../sdk/dd.js';
import { serializeRcfRemarks } from '../sdk/rcf.js';
import { SOFTWARE_VERSION, serializeAddEditRemarks, serializeCoreRemarks, serializeEntityEventRemarks } from '../sdk/reports.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT } from '../sdk/step-names.js';
import type {
  AddEditConfig,
  CertificationValidity,
  CoreConfig,
  DDConfig,
  EntityEventConfig,
  InlinePayloads,
  PipelineResult,
  RcfConfig
} from '../sdk/types.js';
import type { AuthConfig } from '../test-runner/types.js';
import { CLOUD_ENDORSEMENT, type CloudEndorsementName } from './runs.js';

/** The configuration of any local run a cloud run can start from. */
export type CloudRunConfig = CoreConfig | DDConfig | AddEditConfig | EntityEventConfig | RcfConfig;

/** The configurations whose run tests a server, which is every one but RESO Common Format. */
export type ServerCloudRunConfig = Exclude<CloudRunConfig, RcfConfig>;

/**
 * The version every EntityEvent run reports. reso-certification does not version EntityEvent per entry: the pipeline
 * writes `1.0.0` on its reports, and the service accepts that one.
 */
export const ENTITY_EVENT_VERSION = '1.0.0';

/** What a cloud request carries about the local run of one entry. */
export interface LocalRunRecord {
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly serviceRootUri: string;
  readonly endorsementName: string;
  readonly endorsementVersion: string;
  readonly softwareVersion: string;
  readonly generatedOn: string;
  readonly outcome: PipelineResult['status'];
  readonly certification: CertificationValidity;
  readonly remarks: string;
}

/** What every entry that tests a server carries: the server, the credential and the scope. */
export interface ServerCloudConfigEntry {
  readonly description?: string;
  readonly serviceRootUri: string;
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly token?: string;
  readonly clientCredentials?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tokenUri: string;
    readonly scope?: string;
  };
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
}

/** One entry of a Web API Core cloud request, in the config-file shape the service reads. Carries the entry's credential. */
export interface CloudConfigEntry extends ServerCloudConfigEntry {
  readonly coreOptions: {
    readonly version: string;
    readonly enumMode?: string;
    readonly resources?: ReadonlyArray<string>;
    readonly fieldOverrides?: ReadonlyArray<string>;
    readonly fullCoverage?: boolean;
  };
}

/** The run passed and its own verdict says it can be certified. Nothing else starts a cloud run. */
export const isSuccessfulRun = (result: PipelineResult): boolean => result.status === 'passed' && result.certification.valid;

/**
 * Why a result is not the run of a configuration: every pipeline writes its own endorsement on its result, and a
 * result of another endorsement is another run, whatever it passed. `undefined` when they pair.
 */
export const pairingRefusal = (config: CloudRunConfig, result: PipelineResult): string | undefined =>
  result.endorsement === config.endorsement
    ? undefined
    : `it is the result of a ${result.endorsement} run, and its configuration is for ${config.endorsement}`;

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** The identifiers a cloud run is addressed by. A run without all of them cannot be started in the cloud. */
export const cloudTargetOf = (
  config: CloudRunConfig
): { readonly providerUoi: string; readonly providerUsi: string; readonly recipientUoi: string } | undefined =>
  nonEmpty(config.providerUoi) && nonEmpty(config.providerUsi) && nonEmpty(config.recipientUoi)
    ? { providerUoi: config.providerUoi, providerUsi: config.providerUsi, recipientUoi: config.recipientUoi }
    : undefined;

/** The Core version a run used, normalized as `runCoreCompliance` normalizes it when the run starts. */
const coreVersionOf = (config: CoreConfig): string => coerceCoreVersion(config.version);

/** A string the run recorded in its context, when it recorded one. */
const recordedString = (result: PipelineResult, key: string): string | undefined => {
  const value = result.context[key];
  return typeof value === 'string' && nonEmpty(value) ? value : undefined;
};

/**
 * The Add/Edit version a run used: what `runAddEditCompliance` resolved and recorded in the result, so a run whose
 * configuration omitted it and ran at the engine's default is recorded at that default. Before a result records it,
 * the configuration's own. `undefined` when neither says.
 */
const addEditVersionOf = (config: AddEditConfig, result: PipelineResult): string | undefined =>
  recordedString(result, 'specVersion') ?? (nonEmpty(config.specVersion) ? config.specVersion : undefined);

const isEntityEventMode = (value: unknown): value is 'observe' | 'full' => value === 'observe' || value === 'full';

/**
 * The mode an EntityEvent run used: what `runEntityEventCompliance` resolved and recorded in the result, so a run
 * whose configuration omitted it and observed at the engine's default is recorded as observing. Before a result
 * records it, the configuration's own.
 */
const entityEventModeOf = (config: EntityEventConfig, result: PipelineResult): 'observe' | 'full' | undefined => {
  const recorded = result.context.mode;
  return isEntityEventMode(recorded) ? recorded : config.mode;
};

/** The resource an EntityEvent run wrote its canaries to, as the run recorded it, else as configured. */
const entityEventWritableResourceOf = (config: EntityEventConfig, result: PipelineResult): string | undefined =>
  recordedString(result, 'writableResource') ?? (nonEmpty(config.writableResource) ? config.writableResource : undefined);

/** The endorsement name the request route takes for a configuration. */
export const cloudEndorsementOf = (config: CloudRunConfig): CloudEndorsementName => {
  switch (config.endorsement) {
    case 'core':
      return CLOUD_ENDORSEMENT.webApiCore;
    case 'dd':
      return CLOUD_ENDORSEMENT.dataDictionary;
    case 'add-edit':
      return CLOUD_ENDORSEMENT.addEdit;
    case 'entity-event':
      return CLOUD_ENDORSEMENT.entityEvent;
    case 'rcf':
      return CLOUD_ENDORSEMENT.resoCommonFormat;
  }
};

/**
 * The version a run certified, as the request route names it: what the run normalized or recorded, never a default
 * filled in here. `undefined` when the run did not say.
 */
export const cloudVersionOf = (config: CloudRunConfig, result: PipelineResult): string | undefined => {
  switch (config.endorsement) {
    case 'core':
      return coreVersionOf(config);
    case 'dd':
      return config.version;
    case 'add-edit':
      return addEditVersionOf(config, result);
    case 'entity-event':
      return ENTITY_EVENT_VERSION;
    case 'rcf':
      return stepParam(result, INFER_RCF_REPORTS, 'version');
  }
};

const serverRemarksOf = (config: ServerCloudRunConfig, result: PipelineResult): string => {
  switch (config.endorsement) {
    case 'core':
      return serializeCoreRemarks(result);
    case 'dd':
      return serializeDDRemarks(result);
    case 'add-edit':
      return serializeAddEditRemarks(result);
    case 'entity-event':
      return serializeEntityEventRemarks(result);
  }
};

/** The record of a run that tested a server, or `undefined` when it is not addressed or did not say its version. */
const serverLocalRunRecordOf = (result: PipelineResult, config: ServerCloudRunConfig, now: Date): LocalRunRecord | undefined => {
  const target = cloudTargetOf(config);
  const endorsementVersion = cloudVersionOf(config, result);
  if (target === undefined || endorsementVersion === undefined) return undefined;
  return {
    recipientUoi: target.recipientUoi,
    providerUsi: target.providerUsi,
    serviceRootUri: config.server.url,
    endorsementName: cloudEndorsementOf(config),
    endorsementVersion,
    softwareVersion: SOFTWARE_VERSION,
    generatedOn: now.toISOString(),
    outcome: result.status,
    certification: result.certification,
    remarks: serverRemarksOf(config, result)
  };
};

const credentialOf = (auth: AuthConfig): Pick<CloudConfigEntry, 'token' | 'clientCredentials'> =>
  auth.mode === 'token'
    ? { token: auth.authToken }
    : {
        clientCredentials: {
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          tokenUri: auth.tokenUrl,
          ...(auth.scope ? { scope: auth.scope } : {})
        }
      };

/** What every server entry carries, from the configuration as it ran. */
const serverEntryOf = (config: ServerCloudRunConfig, description: string | undefined): ServerCloudConfigEntry | undefined => {
  const target = cloudTargetOf(config);
  if (target === undefined) return undefined;
  // Add/Edit and EntityEvent take no originating-system scope: reso-certification reads none for them.
  const scope: { readonly originatingSystemName?: string; readonly originatingSystemId?: string } =
    config.endorsement === 'core' || config.endorsement === 'dd' ? config : {};
  return {
    ...(nonEmpty(description) ? { description } : {}),
    serviceRootUri: config.server.url,
    recipientUoi: target.recipientUoi,
    providerUsi: target.providerUsi,
    ...credentialOf(config.server.auth),
    ...(nonEmpty(scope.originatingSystemName) ? { originatingSystemName: scope.originatingSystemName } : {}),
    ...(nonEmpty(scope.originatingSystemId) ? { originatingSystemId: scope.originatingSystemId } : {})
  };
};

/** The cloud entry for a Core run, as it ran: its server, credential, scope and options. */
const coreCloudEntryOf = (config: CoreConfig, description?: string): CloudConfigEntry | undefined => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return undefined;
  return {
    ...base,
    coreOptions: {
      version: coreVersionOf(config),
      ...(config.enumMode ? { enumMode: config.enumMode } : {}),
      ...(config.resources?.length ? { resources: config.resources } : {}),
      ...(config.fieldOverrides?.length ? { fieldOverrides: config.fieldOverrides } : {}),
      ...(config.fullCoverage ? { fullCoverage: true } : {})
    }
  };
};

/** What a cloud request carries about the local RESO Common Format run for one recipient: the files it read, by their
 *  fingerprint, where a Core record names a server. */
export interface RcfLocalRunRecord {
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly fingerprint: string;
  readonly endorsementName: string;
  readonly endorsementVersion: string;
  readonly softwareVersion: string;
  readonly generatedOn: string;
  readonly outcome: PipelineResult['status'];
  readonly certification: CertificationValidity;
  readonly remarks: string;
}

/** One entry of a RESO Common Format cloud request. The upload takes the place a server has in a Core entry, and there
 *  is no credential: the cloud run reads the uploaded files. */
export interface RcfCloudConfigEntry {
  readonly description?: string;
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly upload: { readonly uploadId: string; readonly fingerprint: string };
}

/** A string a step recorded, when it recorded one. */
const stepParam = (result: PipelineResult, step: string, param: string): string | undefined => {
  const value = result.steps.find(s => s.name === step)?.params?.[param];
  return nonEmpty(typeof value === 'string' ? value : undefined) ? String(value) : undefined;
};

/**
 * The record of a RESO Common Format run, or `undefined` when it is not addressed to a provider, system and recipient
 * or did not record the fingerprint of what it read and the Data Dictionary version it used.
 */
export const rcfLocalRunRecordOf = (result: PipelineResult, config: RcfConfig, now: Date = new Date()): RcfLocalRunRecord | undefined => {
  const fingerprint = stepParam(result, READ_RCF_INPUT, 'fingerprint');
  const version = stepParam(result, INFER_RCF_REPORTS, 'version');
  if (!nonEmpty(config.providerUoi) || !nonEmpty(config.providerUsi) || !nonEmpty(config.recipientUoi)) return undefined;
  if (fingerprint === undefined || version === undefined) return undefined;
  return {
    recipientUoi: config.recipientUoi,
    providerUsi: config.providerUsi,
    fingerprint,
    endorsementName: CLOUD_ENDORSEMENT.resoCommonFormat,
    endorsementVersion: version,
    softwareVersion: SOFTWARE_VERSION,
    generatedOn: now.toISOString(),
    outcome: result.status,
    certification: result.certification,
    remarks: serializeRcfRemarks(result)
  };
};

// ── Every endorsement: the entry and the record of any local run ──

/** One entry of a Data Dictionary cloud request. The strict mode travels in `ddOptions`, as a config file carries
 *  it. A sample limit never does: a run that set one is refused before an entry is built (`ddSampleLimitRefusal`). */
export interface DDCloudConfigEntry extends ServerCloudConfigEntry {
  readonly ddOptions: {
    readonly version: string;
    readonly strictMode?: boolean;
    readonly batchExpand?: boolean;
    readonly requestDelay?: number;
    readonly rateLimitWait?: number;
  };
}

/** One entry of an Add/Edit cloud request. The payloads the local run used go inline: the cloud reaches no folder. */
export interface AddEditCloudConfigEntry extends ServerCloudConfigEntry {
  readonly payloads: InlinePayloads;
  readonly addEditOptions: {
    readonly specVersion: string;
    readonly resource: string;
    readonly actions?: ReadonlyArray<AddEditAction>;
    readonly formats?: AddEditFormats;
  };
}

/** One entry of an EntityEvent cloud request. */
export interface EntityEventCloudConfigEntry extends ServerCloudConfigEntry {
  readonly entityEventOptions: {
    readonly mode: 'observe' | 'full';
    readonly writableResource: string;
    readonly maxEvents?: number;
    readonly pollInterval?: number;
    readonly pollTimeout?: number;
  };
}

/** The entry of any of the five endorsements. */
export type AnyCloudConfigEntry =
  | CloudConfigEntry
  | DDCloudConfigEntry
  | AddEditCloudConfigEntry
  | EntityEventCloudConfigEntry
  | RcfCloudConfigEntry;

/** The record of any of the five endorsements' local runs. */
export type AnyLocalRunRecord = LocalRunRecord | RcfLocalRunRecord;

/** The entry for one local run, or why there is none. A refusal names what is missing, and nothing is filled in. */
export type CloudEntryResult = { readonly entry: AnyCloudConfigEntry } | { readonly refused: string };

export interface CloudEntryOptions {
  /** The entry's label in the configuration file. */
  readonly description?: string;
  /** RESO Common Format only: the upload the files went to. The entry names it in place of a server. */
  readonly upload?: { readonly uploadId: string };
  /**
   * Add/Edit only: the payloads the run used, captured when it ran, for a result from an engine that did not record
   * them itself. A result that recorded them is sent as recorded, and this is not read.
   */
  readonly payloads?: InlinePayloads;
}

const NO_TARGET_REASON = 'it does not name the provider, system and recipient a cloud run is addressed to';
const AUTO_PAYLOADS_REASON = 'the tool wrote its payloads, and a cloud run tests the payloads you give';
const NO_PAYLOADS_REASON = 'it gives no payloads';
const NO_RESOURCE_REASON = 'it does not name the resource it writes to';
const CANARY_FOLDER_REASON = "it reads its canary payloads from a folder, which a run in RESO's cloud cannot reach";

const refused = (reason: string): CloudEntryResult => ({ refused: reason });

/**
 * Why a Data Dictionary configuration that set a sample limit below the default can start no cloud run, or
 * `undefined` when it set none or one at or above the default. A smaller sample is for local testing: the run
 * measures less than certification samples, so it cannot be certified. A limit at or above the default is a larger
 * sample, which certifies, and the entry carries it (see `dd-sample-limit.ts`). Only a limit the configuration set
 * counts: `limit` is undefined when neither `--limit` nor the entry's `ddOptions.limit` set one, and the pipeline
 * applies its own default then. Read before the run, when the entry is built and when a run is reserved, so the same
 * words refuse it everywhere.
 */
export const ddSampleLimitRefusal = (config: CloudRunConfig): string | undefined =>
  config.endorsement === 'dd' && isDDLimitBelowDefault(config.limit)
    ? `it cannot be certified: it uses a sample limit of ${config.limit} records per resource, below the ${DD_DEFAULT_SAMPLE_LIMIT_TEXT} that certification samples, which is for local testing. Remove the limit, or raise it to ${DD_DEFAULT_SAMPLE_LIMIT_TEXT} or more, to start a cloud run`
    : undefined;

const ddCloudEntryOf = (config: DDConfig, description: string | undefined): CloudEntryResult => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  const limited = ddSampleLimitRefusal(config);
  if (limited !== undefined) return refused(limited);
  return {
    entry: {
      ...base,
      ddOptions: {
        version: config.version,
        ...(config.strictMode === undefined ? {} : { strictMode: config.strictMode }),
        // Only a limit at or above the default reaches here (`ddSampleLimitRefusal` above), and the cloud run samples
        // what the local run did rather than falling back to the default.
        ...(config.limit === undefined ? {} : { limit: config.limit }),
        ...(config.batchExpand ? { batchExpand: true } : {}),
        ...(config.requestDelay === undefined ? {} : { requestDelay: config.requestDelay }),
        ...(config.rateLimitWait === undefined ? {} : { rateLimitWait: config.rateLimitWait })
      }
    }
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Payloads as a run records them: an object whose every entry is itself an object, one per payload name. */
const isInlinePayloads = (value: unknown): value is InlinePayloads => isRecord(value) && Object.values(value).every(isRecord);

/**
 * The payloads a plan uses, out of a set that may hold more: the local run checks only the plan's, so a stray one,
 * for an action not tested, passes locally and would be refused by the cloud. A folder run reads only the plan's.
 */
const payloadsUsedBy = (plan: AddEditTestPlan, payloads: InlinePayloads): InlinePayloads =>
  Object.fromEntries(payloadsFor(plan).flatMap(name => (payloads[name] === undefined ? [] : [[name, payloads[name]]])));

/**
 * The payloads an Add/Edit run used, inline: the ones the pipeline recorded when it read them, else the ones captured
 * when it ran, else the configuration's own, each narrowed to the plan the configuration tests. A run that read a
 * folder and recorded nothing is refused, never read again: the folder may not hold what ran. Auto payloads are
 * refused: they are written for the reference server and the mock, and the cloud tests the provider's own.
 */
const addEditPayloadsOf = (
  config: AddEditConfig,
  result: PipelineResult,
  captured: InlinePayloads | undefined
): { readonly payloads: InlinePayloads } | { readonly refused: string } => {
  if (config.autoPayloads) return { refused: AUTO_PAYLOADS_REASON };
  // The plan is a function of the configuration, so it is the plan the run was given.
  const planned = planAddEditTests({ actions: config.actions, formats: config.formats });
  if ('problems' in planned) return { refused: `its selection cannot be tested: ${planned.problems.join('; ')}` };
  const recorded = result.context.payloads;
  if (isInlinePayloads(recorded)) return { payloads: payloadsUsedBy(planned.plan, recorded) };
  if (captured !== undefined) return { payloads: payloadsUsedBy(planned.plan, captured) };
  if (config.payloadsDir !== undefined) {
    return { refused: 'the run did not record the payloads it read from its folder, so what ran cannot be sent as it was. Run it again' };
  }
  return config.payloads === undefined ? { refused: NO_PAYLOADS_REASON } : { payloads: payloadsUsedBy(planned.plan, config.payloads) };
};

const addEditCloudEntryOf = async (
  config: AddEditConfig,
  result: PipelineResult,
  options: CloudEntryOptions
): Promise<CloudEntryResult> => {
  const base = serverEntryOf(config, options.description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  const specVersion = addEditVersionOf(config, result);
  if (specVersion === undefined) return refused('it does not say which Add/Edit version it ran');
  if (!nonEmpty(config.resource)) return refused(NO_RESOURCE_REASON);
  const payloads = addEditPayloadsOf(config, result, options.payloads);
  if ('refused' in payloads) return refused(payloads.refused);
  return {
    entry: {
      ...base,
      payloads: payloads.payloads,
      addEditOptions: {
        specVersion,
        resource: config.resource,
        ...(config.actions === undefined ? {} : { actions: config.actions }),
        ...(config.formats === undefined ? {} : { formats: config.formats })
      }
    }
  };
};

const entityEventCloudEntryOf = (config: EntityEventConfig, result: PipelineResult, description: string | undefined): CloudEntryResult => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  const mode = entityEventModeOf(config, result);
  const writableResource = entityEventWritableResourceOf(config, result);
  if (mode === undefined) return refused('it does not say whether it observed or wrote');
  if (writableResource === undefined) return refused('it does not name the resource it writes canaries to');
  if (mode === 'full' && config.payloadsDir !== undefined) return refused(CANARY_FOLDER_REASON);
  return {
    entry: {
      ...base,
      entityEventOptions: {
        mode,
        writableResource,
        ...(config.maxEvents === undefined ? {} : { maxEvents: config.maxEvents }),
        ...(config.pollInterval === undefined ? {} : { pollInterval: config.pollInterval }),
        ...(config.pollTimeout === undefined ? {} : { pollTimeout: config.pollTimeout })
      }
    }
  };
};

const rcfCloudEntryOf = (config: RcfConfig, result: PipelineResult, options: CloudEntryOptions): CloudEntryResult => {
  const record = rcfLocalRunRecordOf(result, config);
  if (record === undefined) return refused(`${NO_TARGET_REASON}, or did not record the fingerprint of what it read`);
  if (options.upload === undefined || !nonEmpty(options.upload.uploadId)) {
    return refused('its files have not been uploaded yet: a RESO Common Format entry names the upload in place of a server');
  }
  return {
    entry: {
      ...(nonEmpty(options.description) ? { description: options.description } : {}),
      recipientUoi: record.recipientUoi,
      providerUsi: record.providerUsi,
      upload: { uploadId: options.upload.uploadId, fingerprint: record.fingerprint }
    }
  };
};

const cannotCertify = (why: string | undefined): ReadonlyArray<string> => (why === undefined ? [] : [`it cannot be certified: ${why}`]);

/** What a configuration asks for that its own certification rule will refuse, or the cloud will not run, read before it runs. */
const uncertifiableBeforeRun = (config: CloudRunConfig): ReadonlyArray<string> => {
  switch (config.endorsement) {
    case 'core':
      return cannotCertify(whyCoreVersionDoesNotCertify(coreVersionOf(config)));
    case 'dd': {
      const limited = ddSampleLimitRefusal(config);
      return [
        ...cannotCertify(whyDDVersionDoesNotCertify(config.version)),
        ...cannotCertify(
          config.strictMode === false ? 'strict mode is off, so schema errors would be recorded and not enforced' : undefined
        ),
        ...cannotCertify(
          config.runVariations === false ? 'variations would not run, so no name would be checked against the Data Dictionary' : undefined
        ),
        ...(limited === undefined ? [] : [limited])
      ];
    }
    case 'add-edit':
      return [
        // The version the pipeline runs at when the configuration omits it, as `runAddEditCompliance` resolves it.
        ...cannotCertify(whyAddEditVersionDoesNotCertify(config.specVersion ?? CURRENT_ADD_EDIT_VERSION)),
        ...(config.autoPayloads ? [AUTO_PAYLOADS_REASON] : []),
        ...(!config.autoPayloads && config.payloads === undefined && config.payloadsDir === undefined ? [NO_PAYLOADS_REASON] : []),
        ...(nonEmpty(config.resource) ? [] : [NO_RESOURCE_REASON])
      ];
    case 'entity-event': {
      // The mode the pipeline runs at when the configuration omits it, as `runEntityEventCompliance` resolves it.
      const mode = config.mode ?? 'observe';
      return [
        ...cannotCertify(mode === 'observe' ? 'it would only observe, and a run that writes nothing certifies nothing' : undefined),
        ...(mode === 'full' && config.payloadsDir !== undefined ? [CANARY_FOLDER_REASON] : [])
      ];
    }
    case 'rcf':
      return [
        ...cannotCertify(
          config.schemaValidate === false
            ? 'schema validation would not run, so no record would be checked against the Data Dictionary'
            : undefined
        ),
        ...cannotCertify(
          config.runVariations === false ? 'variations would not run, so no name would be checked against the Data Dictionary' : undefined
        )
      ];
  }
};

/**
 * Why a cloud run could never start from a configuration, known before it runs: it is not addressed, or it asks for a
 * run its own rule will not certify or the cloud will not run. Every reason is named, so the file is fixed once.
 * `undefined` when the run may go on. What only the run can tell, whether it passes and what it records, is left to
 * `isSuccessfulRun` and `cloudEntryOf` at the end.
 */
export const whyNoCloudRunBeforeRun = (config: CloudRunConfig): string | undefined => {
  const reasons = [...(cloudTargetOf(config) === undefined ? [NO_TARGET_REASON] : []), ...uncertifiableBeforeRun(config)];
  return reasons.length === 0 ? undefined : reasons.join('; ');
};

const anyCloudEntryOf = async (config: CloudRunConfig, result: PipelineResult, options: CloudEntryOptions): Promise<CloudEntryResult> => {
  const mismatch = pairingRefusal(config, result);
  if (mismatch !== undefined) return refused(mismatch);
  switch (config.endorsement) {
    case 'core': {
      const entry = coreCloudEntryOf(config, options.description);
      return entry === undefined ? refused(NO_TARGET_REASON) : { entry };
    }
    case 'dd':
      return ddCloudEntryOf(config, options.description);
    case 'add-edit':
      return addEditCloudEntryOf(config, result, options);
    case 'entity-event':
      return entityEventCloudEntryOf(config, result, options.description);
    case 'rcf':
      return rcfCloudEntryOf(config, result, options);
  }
};

/**
 * The cloud entry for one local run, in the shape the service reads for its endorsement.
 *
 * Two forms. The Web API Core form, `cloudEntryOf(config, description?)`, is synchronous and answers the entry or
 * `undefined`, as its first callers use it. The general form, `cloudEntryOf(config, result, options?)`, takes any of the five
 * configurations and the run's result, and answers the entry or the reason there is none. It is asynchronous because
 * an Add/Edit entry inlines the payload files the run read.
 */
export interface CloudEntryOf {
  (config: CoreConfig, description?: string): CloudConfigEntry | undefined;
  (config: CloudRunConfig, result: PipelineResult, options?: CloudEntryOptions): Promise<CloudEntryResult>;
}

const isResult = (value: unknown): value is PipelineResult =>
  typeof value === 'object' && value !== null && 'steps' in value && 'certification' in value;

// The two forms are told apart by their second argument. The assertion is the one place the two signatures meet.
export const cloudEntryOf: CloudEntryOf = ((config: CloudRunConfig, second?: string | PipelineResult, options: CloudEntryOptions = {}) =>
  isResult(second)
    ? anyCloudEntryOf(config, second, options)
    : config.endorsement === 'core'
      ? coreCloudEntryOf(config, second)
      : undefined) as CloudEntryOf;

/** The record type a configuration's local run produces: RESO Common Format names an upload where the rest name a server. */
export type LocalRunRecordFor<C extends CloudRunConfig> = C extends RcfConfig ? RcfLocalRunRecord : LocalRunRecord;

/**
 * The record of any local run, or `undefined` when the result is not the run of this configuration, the run is not
 * addressed to a provider, system and recipient, or it did not say what it certified. Web API Core and RESO Common
 * Format records are as the Core and `rcf` commands first built them.
 */
export const localRunRecordOf = <C extends CloudRunConfig>(
  result: PipelineResult,
  config: C,
  now: Date = new Date()
): LocalRunRecordFor<C> | undefined => {
  if (pairingRefusal(config, result) !== undefined) return undefined;
  // The conditional return type narrows per endorsement; the assertion carries the union across it.
  const record: AnyLocalRunRecord | undefined =
    config.endorsement === 'rcf' ? rcfLocalRunRecordOf(result, config, now) : serverLocalRunRecordOf(result, config, now);
  return record as LocalRunRecordFor<C> | undefined;
};
