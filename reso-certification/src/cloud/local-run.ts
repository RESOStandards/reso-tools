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

import { coerceCoreVersion } from '../sdk/core-versions.js';
import { serializeRcfRemarks } from '../sdk/rcf.js';
import { SOFTWARE_VERSION, serializeCoreRemarks } from '../sdk/reports.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT } from '../sdk/step-names.js';
import type { CertificationValidity, CoreConfig, PipelineResult, RcfConfig } from '../sdk/types.js';
import type { AuthConfig } from '../test-runner/types.js';
import { CLOUD_ENDORSEMENT } from './runs.js';

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

/** One entry of a cloud request, in the config-file shape the service reads. Carries the entry's credential. */
export interface CloudConfigEntry {
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
  config: CoreConfig
): { readonly providerUoi: string; readonly providerUsi: string; readonly recipientUoi: string } | undefined =>
  nonEmpty(config.providerUoi) && nonEmpty(config.providerUsi) && nonEmpty(config.recipientUoi)
    ? { providerUoi: config.providerUoi, providerUsi: config.providerUsi, recipientUoi: config.recipientUoi }
    : undefined;

/** The Core version a run used, normalized as `runCoreCompliance` normalizes it when the run starts. */
const coreVersionOf = (config: CoreConfig): string => coerceCoreVersion(config.version);

/** The record of a Core run, or `undefined` when the run is not addressed to a provider, system and recipient. */
export const localRunRecordOf = (result: PipelineResult, config: CoreConfig, now: Date = new Date()): LocalRunRecord | undefined => {
  const target = cloudTargetOf(config);
  if (target === undefined) return undefined;
  return {
    recipientUoi: target.recipientUoi,
    providerUsi: target.providerUsi,
    serviceRootUri: config.server.url,
    endorsementName: CLOUD_ENDORSEMENT.webApiCore,
    endorsementVersion: coreVersionOf(config),
    softwareVersion: SOFTWARE_VERSION,
    generatedOn: now.toISOString(),
    outcome: result.status,
    certification: result.certification,
    remarks: serializeCoreRemarks(result)
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

/** The cloud entry for a Core run, as it ran: its server, credential, scope and options. */
export const cloudEntryOf = (config: CoreConfig, description?: string): CloudConfigEntry | undefined => {
  const target = cloudTargetOf(config);
  if (target === undefined) return undefined;
  return {
    ...(nonEmpty(description) ? { description } : {}),
    serviceRootUri: config.server.url,
    recipientUoi: target.recipientUoi,
    providerUsi: target.providerUsi,
    ...credentialOf(config.server.auth),
    ...(nonEmpty(config.originatingSystemName) ? { originatingSystemName: config.originatingSystemName } : {}),
    ...(nonEmpty(config.originatingSystemId) ? { originatingSystemId: config.originatingSystemId } : {}),
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
