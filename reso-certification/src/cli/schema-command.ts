/**
 * Testable core for the `reso-cert schema` command (validate / generate).
 *
 * Wraps the carried JSON-schema validator (`src/legacy/lib/schema`) — `generateJsonSchema`, `validate`,
 * `combineErrors` — and resolves the schema-validation-settings (exemptions) so the CLI verdict matches the
 * in-run cert verdict. IO, output routing and exit codes live in the command action (index.ts); this module is
 * pure over its inputs so it can be unit-tested without a process.
 */

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
 * Generate a JSON Schema from a metadata report and validate a payload against it. `validate` infers the
 * resource/version from the payload's `@odata.context` when `resourceName`/`version` are omitted, applies the
 * exemptions in `validationConfig`, and handles both a collection (`{ value: [...] }`) and a single record.
 */
export const validateSchemaPayload = async (opts: {
  readonly metadataReportJson: unknown;
  readonly jsonPayload: unknown;
  readonly resourceName?: string;
  readonly version?: string;
  readonly validationConfig?: unknown;
  readonly additionalProperties?: boolean;
}): Promise<SchemaValidationResult> => {
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
    version: opts.version,
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
}): Promise<DdSchemaValidator> => {
  const mod = loadSchemaModule();
  const jsonSchema = await mod.generateJsonSchema({
    metadataReportJson: opts.metadataReportJson,
    additionalProperties: opts.additionalProperties ?? false,
  });
  return {
    validate: (jsonPayload, resourceName, version, errorMap = {}) =>
      mod.validate({ jsonSchema, jsonPayload, resourceName, version, validationConfig: opts.validationConfig ?? {}, errorMap }),
    combine: errorMap => {
      // A payload whose resource isn't in the schema leaves the error map without `stats`; default it
      // so combineErrors doesn't dereference `stats.totalErrors` on undefined (an existing `stats` wins).
      const combined = mod.combineErrors({ stats: { totalErrors: 0, totalWarnings: 0 }, ...errorMap });
      return { totalErrors: combined.totalErrors ?? 0, report: combined };
    },
  };
};
