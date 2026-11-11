/**
 * Starting a cloud run from local runs that passed: the one path the CLI and the desktop share.
 *
 * Given the local runs of one endorsement and version for one provider, each with the reservation made when it
 * passed, `startCloudRun` checks each run, builds its entry from the configuration that ran, uploads a RESO Common
 * Format run's files, and submits. Every check here is a refusal with its reason: nothing is filled in, and a run that
 * did not pass, is not addressed, or is not the endorsement and version asked for stops the whole start before
 * anything is sent. What the service then accepts is its decision, answered in its own words.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintOAuth2ClientCredentialsToken } from '../cli/auth.js';
import type { PipelineResult } from '../sdk/types.js';
import {
  type AnyCloudConfigEntry,
  type AnyLocalRunRecord,
  type CloudRunConfig,
  cloudEndorsementOf,
  cloudEntryOf,
  cloudTargetOf,
  ddSampleLimitRefusal,
  isSuccessfulRun,
  localRunRecordOf,
  pairingRefusal
} from './local-run.js';
import { type PackRcfResult, packRcfInput } from './rcf-pack.js';
import {
  type AcceptedCloudRun,
  type CloudEndorsementName,
  type CloudRunReservation,
  type CloudRunTarget,
  requestUploadSlot,
  reserveCloudRun,
  submitCloudRun,
  uploadToSlot
} from './runs.js';

/** One local run a cloud run starts from, with the reservation made when it passed. */
export interface CloudLocalRun {
  /** The configuration that ran, flags included, never the file it came from. */
  readonly config: CloudRunConfig;
  readonly result: PipelineResult;
  /** The request ID reserved when this run passed. */
  readonly certificationRequestId: string;
  /** The entry's label, for the request and for refusals. */
  readonly description?: string;
}

/** What a cloud run of one endorsement and version is started from, for one provider. */
export interface StartCloudRunInput {
  readonly endorsementName: CloudEndorsementName;
  readonly endorsementVersion: string;
  readonly providerUoi: string;
  /** How many of the provider's recipients the service may run at once. */
  readonly concurrency?: number;
  readonly localRuns: ReadonlyArray<CloudLocalRun>;
  /** The bearer for RESO's service: a session token. Without it, the CLI's own resolution from the environment. */
  readonly servicesAuthToken?: string;
  /** True from the CLI, so an auth failure points at the environment file. */
  readonly fromCli?: boolean;
  /** When the records are written. For tests. */
  readonly now?: Date;
}

/** The calls a start makes, injectable so it can be tested without a network or a large file. */
export interface StartCloudRunDeps {
  readonly submit: typeof submitCloudRun;
  readonly requestSlot: typeof requestUploadSlot;
  readonly upload: typeof uploadToSlot;
  readonly pack: (input: string, zipPath: string, fingerprint: string) => Promise<PackRcfResult>;
  /** A folder of its own for the packed zip. Removed however the start ends. */
  readonly makeTempDir: () => Promise<string>;
  readonly removeTempDir: (dir: string) => Promise<void>;
  /** The CLI's resolution of the services bearer, used only when no `servicesAuthToken` is given. */
  readonly resolveCliToken: () => Promise<string | undefined>;
}

const defaultDeps: StartCloudRunDeps = {
  submit: submitCloudRun,
  requestSlot: requestUploadSlot,
  upload: uploadToSlot,
  pack: (input, zipPath, fingerprint) => packRcfInput(input, zipPath, { fingerprint }),
  makeTempDir: () => mkdtemp(join(tmpdir(), 'reso-rcf-upload-')),
  removeTempDir: dir => rm(dir, { recursive: true, force: true }),
  resolveCliToken: mintOAuth2ClientCredentialsToken
};

/** Why a run did not succeed, in words a person can act on. Only for display: `isSuccessfulRun` decides. */
export const whyNotSuccessful = (result: PipelineResult): string => {
  if (result.status === 'incomplete') return 'it did not finish';
  if (result.status !== 'passed') return 'it failed';
  return result.certification.valid ? 'it did not pass' : `it cannot be certified: ${result.certification.reasons.join('; ')}`;
};

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

const labelOf = (run: CloudLocalRun, index: number): string => {
  if (nonEmpty(run.description)) return run.description;
  const target = cloudTargetOf(run.config);
  return target === undefined ? `entry ${index + 1}` : `${target.recipientUoi}, system ${target.providerUsi}`;
};

const refusal = (label: string, reason: string): Error => new Error(`${label}: ${reason}. No cloud run was started.`);

type AuthInput = { readonly fromCli?: boolean; readonly bearerToken?: string };

/** The bearer for every call, resolved once and only when something is sent. */
const authOf = (input: Pick<StartCloudRunInput, 'servicesAuthToken' | 'fromCli'>, resolveCliToken: () => Promise<string | undefined>) => {
  const held: { token?: Promise<string | undefined> } = {};
  return async (): Promise<AuthInput> => {
    held.token ??= nonEmpty(input.servicesAuthToken) ? Promise.resolve(input.servicesAuthToken) : resolveCliToken();
    const bearerToken = await held.token;
    return { ...(input.fromCli === undefined ? {} : { fromCli: input.fromCli }), ...(bearerToken ? { bearerToken } : {}) };
  };
};

/** A checked run: its record, and its entry once the files it read (if any) are uploaded. */
interface CheckedRun {
  readonly label: string;
  readonly run: CloudLocalRun;
  readonly record: AnyLocalRunRecord;
}

/** Every check that needs no network, so a start that cannot go sends nothing. */
const check = (input: StartCloudRunInput, run: CloudLocalRun, index: number): CheckedRun => {
  const label = labelOf(run, index);
  if (!nonEmpty(run.certificationRequestId)) {
    throw refusal(label, 'it has no reservation. A cloud run starts from the request ID reserved when the local run passed');
  }
  if (!isSuccessfulRun(run.result)) throw refusal(label, whyNotSuccessful(run.result));
  // The result has to be the run of the configuration it is paired with, or the record and the entry describe
  // different runs.
  const mismatch = pairingRefusal(run.config, run.result);
  if (mismatch !== undefined) throw refusal(label, mismatch);
  const endorsementName = cloudEndorsementOf(run.config);
  if (endorsementName !== input.endorsementName) {
    throw refusal(label, `it is a ${endorsementName} run, and this start is for ${input.endorsementName}`);
  }
  if (run.config.providerUoi !== input.providerUoi) {
    throw refusal(label, `it is not addressed from provider ${input.providerUoi}`);
  }
  const record = localRunRecordOf(run.result, run.config, input.now);
  if (record === undefined) {
    throw refusal(
      label,
      'it does not name the provider, system and recipient a cloud run is addressed to, or did not record what it certified'
    );
  }
  if (record.endorsementVersion !== input.endorsementVersion) {
    throw refusal(label, `it ran ${input.endorsementName} ${record.endorsementVersion}, and this start is for ${input.endorsementVersion}`);
  }
  return { label, run, record };
};

/**
 * Pack what a RESO Common Format run read, ask where to upload it, and upload it. The packed zip lives in a folder of
 * its own, removed however this ends. Answers the upload ID the entry names.
 */
const uploadRcfInput = async (
  input: StartCloudRunInput,
  checked: CheckedRun,
  auth: () => Promise<AuthInput>,
  deps: StartCloudRunDeps
): Promise<string> => {
  const { label, run, record } = checked;
  if (run.config.endorsement !== 'rcf' || !('fingerprint' in record)) throw refusal(label, 'it is not a RESO Common Format run');
  const dir = await deps.makeTempDir();
  try {
    // TODO(later): the reservation was made when the local run passed, before the pack. A pack over the size limit
    // refuses here and leaves that reservation to expire unused in 24 hours.
    const packed = await deps.pack(run.config.input, join(dir, 'upload.zip'), record.fingerprint);
    if ('refused' in packed) throw refusal(label, packed.refused);
    const slot = await deps.requestSlot({
      ...(await auth()),
      certificationRequestId: run.certificationRequestId,
      endorsementName: input.endorsementName,
      endorsementVersion: input.endorsementVersion,
      recipientUoi: record.recipientUoi,
      providerUsi: record.providerUsi,
      fingerprint: record.fingerprint,
      bytes: packed.packed.bytes
    });
    await deps.upload(slot, packed.packed.path);
    return slot.uploadId;
  } finally {
    await deps.removeTempDir(dir);
  }
};

/** One request: the runs that share a reservation, in the order given. */
interface RequestGroup {
  readonly certificationRequestId: string;
  readonly configs: ReadonlyArray<AnyCloudConfigEntry>;
  readonly localRuns: ReadonlyArray<AnyLocalRunRecord>;
}

/**
 * Start a cloud run from local runs that passed. Each run is checked before anything is sent; a RESO Common Format
 * run's files are then packed, uploaded and the temporary folder removed; and one request goes per reservation, so
 * runs that share one go together. Answers the runs the service accepted, in reservation order, or throws the first
 * refusal, in the service's words where it refused.
 */
export const startCloudRun = async (
  input: StartCloudRunInput,
  overrides: Partial<StartCloudRunDeps> = {}
): Promise<ReadonlyArray<AcceptedCloudRun>> => {
  const deps: StartCloudRunDeps = { ...defaultDeps, ...overrides };
  if (input.localRuns.length === 0) throw new Error('No local run was given, so no cloud run was started.');
  const checked = input.localRuns.map((run, index) => check(input, run, index));
  const auth = authOf(input, deps.resolveCliToken);

  const built = await checked.reduce<Promise<ReadonlyArray<CheckedRun & { readonly entry: AnyCloudConfigEntry }>>>(async (done, item) => {
    const previous = await done;
    const upload = item.run.config.endorsement === 'rcf' ? { uploadId: await uploadRcfInput(input, item, auth, deps) } : undefined;
    const result = await cloudEntryOf(item.run.config, item.run.result, {
      ...(nonEmpty(item.run.description) ? { description: item.run.description } : {}),
      ...(upload === undefined ? {} : { upload })
    });
    if ('refused' in result) throw refusal(item.label, result.refused);
    return [...previous, { ...item, entry: result.entry }];
  }, Promise.resolve([]));

  // The reservations in the order first seen, each with every run that shares it.
  const ids = [...new Set(built.map(item => item.run.certificationRequestId))];
  const groups: ReadonlyArray<RequestGroup> = ids.map(certificationRequestId => {
    const members = built.filter(item => item.run.certificationRequestId === certificationRequestId);
    return { certificationRequestId, configs: members.map(m => m.entry), localRuns: members.map(m => m.record) };
  });

  return groups.reduce<Promise<ReadonlyArray<AcceptedCloudRun>>>(async (done, group) => {
    const previous = await done;
    const accepted = await deps.submit({
      ...(await auth()),
      endorsementName: input.endorsementName,
      endorsementVersion: input.endorsementVersion,
      config: {
        certificationRequestId: group.certificationRequestId,
        providerUoi: input.providerUoi,
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        configs: group.configs,
        localRuns: group.localRuns
      }
    });
    return [...previous, accepted];
  }, Promise.resolve([]));
};

/** What reserving at the end of a local run takes: the run, and the bearer for RESO's service. */
export interface ReserveForLocalRunInput {
  readonly config: CloudRunConfig;
  readonly result: PipelineResult;
  readonly servicesAuthToken?: string;
  readonly fromCli?: boolean;
}

/**
 * Reserve a request ID for one local run that passed and can be certified, so the service's clock records the pass.
 * Called at the end of the run, never at submit time. The reservation names the target only, never a credential.
 */
export const reserveForLocalRun = async (
  input: ReserveForLocalRunInput,
  overrides: { readonly reserve?: typeof reserveCloudRun; readonly resolveCliToken?: () => Promise<string | undefined> } = {}
): Promise<CloudRunReservation> => {
  const reserve = overrides.reserve ?? reserveCloudRun;
  const label = labelOf({ ...input, certificationRequestId: '' }, 0);
  if (!isSuccessfulRun(input.result)) throw refusal(label, whyNotSuccessful(input.result));
  // Read from the configuration, not the verdict: a result that calls a run limited below the default certifiable,
  // from another engine or by hand, reserves nothing either. A limit below the default is for local testing.
  const limited = ddSampleLimitRefusal(input.config);
  if (limited !== undefined) throw refusal(label, limited);
  const record = localRunRecordOf(input.result, input.config);
  if (record === undefined || !nonEmpty(input.config.providerUoi)) {
    throw refusal(
      label,
      'it does not name the provider, system and recipient a cloud run is addressed to, or did not record what it certified'
    );
  }
  const target: CloudRunTarget = {
    recipientUoi: record.recipientUoi,
    providerUsi: record.providerUsi,
    ...('serviceRootUri' in record ? { serviceRootUri: record.serviceRootUri } : {})
  };
  const auth = await authOf(input, overrides.resolveCliToken ?? defaultDeps.resolveCliToken)();
  return reserve({
    ...auth,
    endorsementName: record.endorsementName,
    endorsementVersion: record.endorsementVersion,
    providerUoi: input.config.providerUoi,
    targets: [target]
  });
};
