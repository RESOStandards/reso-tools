/**
 * Testable core for the `reso-cert schema` command (validate / generate).
 *
 * Wraps the carried JSON-schema validator (`src/legacy/lib/schema`) — `generateJsonSchema`, `validate`,
 * `combineErrors` — and resolves the schema-validation-settings (exemptions) so the CLI verdict matches the
 * in-run cert verdict. IO, output routing and exit codes live in the command action (index.ts); this module is
 * pure over its inputs so it can be unit-tested without a process.
 */

import { normalizeDDVersion } from '../sdk/dd-versions.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireLegacy = createRequire(import.meta.url);

const SETTINGS_FILE = 'schema-validation-settings.json';

interface SchemaModule {
  readonly generateJsonSchema: (opts: { metadataReportJson: unknown; additionalProperties?: boolean }) => Promise<unknown>;
  readonly validate: (opts: {
    readonly jsonSchema: unknown;
    readonly jsonPayload: unknown;
    readonly resourceName?: string;
    readonly version?: string;
    readonly validationConfig?: unknown;
    readonly isResoDataDictionarySchema?: boolean;
    readonly errorMap?: Record<string, unknown>;
    readonly acquisition?: 'transport' | 'rcf';
  }) => Record<string, unknown>;
  readonly combineErrors: (errorMap: Record<string, unknown>) => { readonly totalErrors?: number; readonly [k: string]: unknown };
}

const isSchemaModule = (m: unknown): m is SchemaModule =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as Record<string, unknown>).generateJsonSchema === 'function' &&
  typeof (m as Record<string, unknown>).validate === 'function' &&
  typeof (m as Record<string, unknown>).combineErrors === 'function';

const loadSchemaModule = (): SchemaModule => {
  const raw: unknown = requireLegacy(resolve(dirname(fileURLToPath(import.meta.url)), '../legacy/lib/schema/index.js'));
  if (!isSchemaModule(raw)) {
    throw new Error('Failed to load the schema module — expected generateJsonSchema / validate / combineErrors exports.');
  }
  return raw;
};

/**
 * Resolve the schema-validation-settings file. Precedence: an explicit path, then one in the current run
 * directory, then the pre-baked copy shipped at the package root. `import.meta.url` lands in `src/cli/` (dev)
 * or `dist/cli/` (packaged) — both two levels below the package root — so the pre-baked path is the same for
 * each. `fileURLToPath` (not `new URL().pathname`) keeps it correct on Windows (cf. #175).
 */
export const resolveSettingsPath = (explicit?: string): string | undefined => {
  if (explicit) return resolve(explicit);
  const cwdSettings = resolve(process.cwd(), SETTINGS_FILE);
  if (existsSync(cwdSettings)) return cwdSettings;
  const prebaked = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', SETTINGS_FILE);
  return existsSync(prebaked) ? prebaked : undefined;
};

/** Load the exemptions/validation config from a resolved settings path; `{}` (no exemptions) when absent. */
export const loadSettings = async (settingsPath?: string): Promise<Record<string, unknown>> => {
  const path = resolveSettingsPath(settingsPath);
  if (!path) return {};
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
};

export interface SchemaValidationResult {
  readonly totalErrors: number;
  readonly report: Record<string, unknown>;
}

/**
 * Generate a JSON Schema from a metadata report and validate a payload against it. On this path (no
 * acquisition declared) a present `@reso.context` names the RESOURCE, and `resourceName` applies only when the
 * payload carries none (default Property); for the VERSION it is the other way round: `version` wins when
 * given (normalized to the Data Dictionary form), else the context's. The exemptions in `validationConfig` are
 * applied, and both a collection (`{ value: [...] }`) and a single record are handled.
 */
export const validateSchemaPayload = async (opts: {
  readonly metadataReportJson: unknown;
  readonly jsonPayload: unknown;
  readonly resourceName?: string;
  readonly version?: string;
  readonly validationConfig?: unknown;
  readonly additionalProperties?: boolean;
}): Promise<SchemaValidationResult> => {
  // A payload is a JSON object: a single record or a collection `{ value: [...] }`. Anything else (a bare
  // array, a string, a number, null) has no resource and no records; the legacy validator drops ajv's
  // root-level type error, so such an input read as PASS. Refuse it up front (the CLI maps a throw to exit 2).
  if (typeof opts.jsonPayload !== 'object' || opts.jsonPayload === null || Array.isArray(opts.jsonPayload)) {
    throw new Error('payload must be a JSON object: a single record or a collection { "value": [ ... ] }');
  }
  const mod = loadSchemaModule();
  const jsonSchema = await mod.generateJsonSchema({
    metadataReportJson: opts.metadataReportJson,
    additionalProperties: opts.additionalProperties ?? false,
  });
  // A single generated schema (not a version Map), so `isResoDataDictionarySchema` stays false (validate's default).
  const errorMap = mod.validate({
    jsonSchema,
    jsonPayload: opts.jsonPayload,
    resourceName: opts.resourceName,
    // the exemptions in validationConfig are keyed by the Data Dictionary form (2.1, never 2.1.0)
    version: opts.version === undefined ? undefined : normalizeDDVersion(opts.version),
    validationConfig: opts.validationConfig ?? {},
    errorMap: {},
  });
  const combined = mod.combineErrors(errorMap);
  return { totalErrors: combined.totalErrors ?? 0, report: combined };
};

/** Generate a JSON Schema from a metadata report (the `schema generate` verb). */
export const generateSchemaFromReport = async (opts: {
  readonly metadataReportJson: unknown;
  readonly additionalProperties?: boolean;
}): Promise<unknown> =>
  loadSchemaModule().generateJsonSchema({
    metadataReportJson: opts.metadataReportJson,
    additionalProperties: opts.additionalProperties ?? false,
  });

export interface DdSchemaValidator {
  /** Validate one payload, folding its errors into `errorMap` (shared across a stream). */
  readonly validate: (
    jsonPayload: unknown,
    resourceName?: string,
    version?: string,
    errorMap?: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Total + combine an accumulated error map into a report. */
  readonly combine: (errorMap: Record<string, unknown>) => { readonly totalErrors: number; readonly report: Record<string, unknown> };
}

/**
 * Build a reusable validator: generate the JSON Schema ONCE from a metadata report, then
 * validate many payloads against it. Errors fold into a caller-owned `errorMap` so a whole
 * RCF stream collapses into one report; `combine` totals it. This avoids the per-payload
 * schema regeneration `validateSchemaPayload` does — essential when streaming thousands of files.
 */
export const createDdSchemaValidator = async (opts: {
  readonly metadataReportJson: unknown;
  readonly additionalProperties?: boolean;
  readonly validationConfig?: unknown;
  /** How the payloads were obtained (#298). 'rcf' — RESO Common Format files, taken as-is: values outside the
   *  standard set accepted, a DD field held to its type, length / precision / scale advisory, `@reso.context`
   *  required and validated (local FIELDS are accepted when the caller generates the schema with
   *  additionalProperties, as the rcf command does). 'transport' — Web API pages: type, length, precision, scale and
   *  values are MUSTs (the exempt enumerated fields, ignoreEnumerations, are warnings), context optional until DD
   *  3.0 and validated when present. Omitted — the legacy presence heuristic. */
  readonly acquisition?: 'transport' | 'rcf';
}): Promise<DdSchemaValidator> => {
  const mod = loadSchemaModule();
  const jsonSchema = await mod.generateJsonSchema({
    metadataReportJson: opts.metadataReportJson,
    additionalProperties: opts.additionalProperties ?? false,
  });
  return {
    validate: (jsonPayload, resourceName, version, errorMap = {}) =>
      mod.validate({ jsonSchema, jsonPayload, resourceName, version, validationConfig: opts.validationConfig ?? {}, errorMap, ...(opts.acquisition ? { acquisition: opts.acquisition } : {}) }),
    combine: errorMap => {
      // Every validate() exit now returns its caches; the default keeps `combine` total on an untouched
      // accumulator (a stream that validated nothing) without dereferencing `stats` on undefined.
      const combined = mod.combineErrors({ stats: { totalErrors: 0, totalWarnings: 0 }, ...errorMap });
      return { totalErrors: combined.totalErrors ?? 0, report: combined };
    },
  };
};
