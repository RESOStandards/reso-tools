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

import { type AddEditAction, type AddEditFormats, type AddEditTestPlan, payloadsFor } from '../add-edit/plan.js';
import { readPayloads } from '../add-edit/test-runner.js';
import { coerceCoreVersion } from '../sdk/core-versions.js';
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
      return nonEmpty(config.specVersion) ? config.specVersion : undefined;
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

/** One entry of a Data Dictionary cloud request. The sample limit and strict mode travel in `ddOptions`, as a config
 *  file carries them. */
export interface DDCloudConfigEntry extends ServerCloudConfigEntry {
  readonly ddOptions: {
    readonly version: string;
    readonly limit?: number;
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
}

const NO_TARGET_REASON = 'it does not name the provider, system and recipient a cloud run is addressed to';

const refused = (reason: string): CloudEntryResult => ({ refused: reason });

const ddCloudEntryOf = (config: DDConfig, description: string | undefined): CloudEntryResult => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  return {
    entry: {
      ...base,
      ddOptions: {
        version: config.version,
        ...(config.limit === undefined ? {} : { limit: config.limit }),
        ...(config.strictMode === undefined ? {} : { strictMode: config.strictMode }),
        ...(config.batchExpand ? { batchExpand: true } : {}),
        ...(config.requestDelay === undefined ? {} : { requestDelay: config.requestDelay }),
        ...(config.rateLimitWait === undefined ? {} : { rateLimitWait: config.rateLimitWait })
      }
    }
  };
};

const isPlan = (value: unknown): value is AddEditTestPlan =>
  typeof value === 'object' && value !== null && Array.isArray((value as { readonly actions?: unknown }).actions);

/**
 * The payloads an Add/Edit run used, inline: the configuration's, or the files it read from its folder, which the
 * cloud cannot reach. The plan the run recorded says which files it read. Auto payloads are refused: they are
 * written for the reference server and the mock, and the cloud tests the provider's own.
 */
const addEditPayloadsOf = async (
  config: AddEditConfig,
  result: PipelineResult
): Promise<{ readonly payloads: InlinePayloads } | { readonly refused: string }> => {
  if (config.autoPayloads) return { refused: 'the tool wrote its payloads, and a cloud run tests the payloads you give' };
  if (config.payloadsDir === undefined) {
    return config.payloads === undefined ? { refused: 'it gives no payloads' } : { payloads: config.payloads };
  }
  const plan = result.context.plan;
  if (!isPlan(plan)) return { refused: 'the run did not record which payload files it read' };
  try {
    return { payloads: await readPayloads(config.payloadsDir, payloadsFor(plan)) };
  } catch (error) {
    return { refused: `its payloads could not be read again: ${error instanceof Error ? error.message : String(error)}` };
  }
};

const addEditCloudEntryOf = async (
  config: AddEditConfig,
  result: PipelineResult,
  description: string | undefined
): Promise<CloudEntryResult> => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  if (!nonEmpty(config.specVersion)) return refused('it does not say which Add/Edit version it ran');
  if (!nonEmpty(config.resource)) return refused('it does not name the resource it wrote to');
  const payloads = await addEditPayloadsOf(config, result);
  if ('refused' in payloads) return refused(payloads.refused);
  return {
    entry: {
      ...base,
      payloads: payloads.payloads,
      addEditOptions: {
        specVersion: config.specVersion,
        resource: config.resource,
        ...(config.actions === undefined ? {} : { actions: config.actions }),
        ...(config.formats === undefined ? {} : { formats: config.formats })
      }
    }
  };
};

const entityEventCloudEntryOf = (config: EntityEventConfig, description: string | undefined): CloudEntryResult => {
  const base = serverEntryOf(config, description);
  if (base === undefined) return refused(NO_TARGET_REASON);
  if (config.mode === undefined) return refused('it does not say whether it observed or wrote');
  if (!nonEmpty(config.writableResource)) return refused('it does not name the resource it writes canaries to');
  if (config.mode === 'full' && config.payloadsDir !== undefined) {
    return refused("it reads its canary payloads from a folder, which a run in RESO's cloud cannot reach");
  }
  return {
    entry: {
      ...base,
      entityEventOptions: {
        mode: config.mode,
        writableResource: config.writableResource,
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

const anyCloudEntryOf = async (config: CloudRunConfig, result: PipelineResult, options: CloudEntryOptions): Promise<CloudEntryResult> => {
  switch (config.endorsement) {
    case 'core': {
      const entry = coreCloudEntryOf(config, options.description);
      return entry === undefined ? refused(NO_TARGET_REASON) : { entry };
    }
    case 'dd':
      return ddCloudEntryOf(config, options.description);
    case 'add-edit':
      return addEditCloudEntryOf(config, result, options.description);
    case 'entity-event':
      return entityEventCloudEntryOf(config, options.description);
    case 'rcf':
      return rcfCloudEntryOf(config, result, options);
  }
};

/**
 * The cloud entry for one local run, in the shape the service reads for its endorsement.
 *
 * Two forms. The Web API Core form, `cloudEntryOf(config, description?)`, is synchronous and answers the entry or
 * `undefined`, as it did in 0.12.0. The general form, `cloudEntryOf(config, result, options?)`, takes any of the five
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
 * The record of any local run, or `undefined` when the run is not addressed to a provider, system and recipient or
 * did not say what it certified. Web API Core and RESO Common Format records are as they were in 0.12.0.
 */
export const localRunRecordOf = <C extends CloudRunConfig>(
  result: PipelineResult,
  config: C,
  now: Date = new Date()
): LocalRunRecordFor<C> | undefined => {
  // The conditional return type narrows per endorsement; the assertion carries the union across it.
  const record: AnyLocalRunRecord | undefined =
    config.endorsement === 'rcf' ? rcfLocalRunRecordOf(result, config, now) : serverLocalRunRecordOf(result, config, now);
  return record as LocalRunRecordFor<C> | undefined;
};
