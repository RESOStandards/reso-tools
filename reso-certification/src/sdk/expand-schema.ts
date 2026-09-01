/**
 * Expanded-item schema validator for the Core 2.1.0 $expand test.
 *
 * Builds a reusable validator from the provider's metadata report using the LEGACY JSON-schema utilities
 * (`src/legacy/lib/schema`) — generate the JSON Schema ONCE, then validate each expanded child item against its
 * target entity type. The Web API Core runner consumes it through the {@link ExpandItemValidator} interface and
 * never touches the schema machinery itself.
 *
 * The legacy module is loaded via `createRequire` because it is CommonJS (and pulls in ajv + the ETL reference
 * bridge) — the same interop pattern `src/cli/schema-command.ts` uses. We call the legacy utilities DIRECTLY
 * (`generateJsonSchema` / `validate`) rather than the CLI's typed wrappers to avoid an sdk → cli layering
 * inversion (cli already depends on sdk).
 *
 * ── Validation policy (mirrors DD/Core testing exactly — NOT RCF mode) ──
 *  - `additionalProperties: false` when generating the schema: a field on the expanded item that the provider's
 *    metadata does not advertise is an ERROR (`Fields MUST be advertised in the metadata`).
 *  - `isRCF` is DERIVED by the legacy validator from `payload['@reso.context']` (`validate.js`). An expanded
 *    child item never carries `@reso.context`, so `isRCF()` is `false` → DD/Core mode: a value exceeding the
 *    provider's declared `maxLength` is a hard ERROR (`MUST have a maximum advertised length …`), not the RCF
 *    `SHOULD have a maximum suggested length` warning.
 *  - The committed `schema-validation-settings.json` exemptions are threaded as `validationConfig`, so the
 *    `ignoreEnumerations` fields (Property MLS-area/school, Media ImageSizeDescription) downgrade an
 *    unadvertised-enum ERROR to a WARNING — exactly as the DD/schema path does. The settings are keyed by DD
 *    major.minor (`2.0`/`2.1`), so the endorsement version (`2.1.0`) is normalized before it reaches the
 *    validator's `getVersion()` exemption lookup.
 *  - The nav gates on `stats.totalErrors === 0`: errors fail, warnings do not.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataReport, MetadataReportField } from '@reso-standards/reso-metadata-utils';
import type { ExpandItemValidator } from '../web-api-core/test-runner.js';

const requireLegacy = createRequire(import.meta.url);

/** The committed, committee-approved exemptions file (never modified). Keyed by DD major.minor. */
const SETTINGS_FILE = 'schema-validation-settings.json';

/** The slice of the legacy schema module (`src/legacy/lib/schema/index.js`) this validator needs. */
interface LegacySchemaModule {
  readonly generateJsonSchema: (opts: {
    readonly metadataReportJson: unknown;
    readonly additionalProperties?: boolean;
  }) => Promise<unknown>;
  readonly validate: (opts: {
    readonly jsonSchema: unknown;
    readonly jsonPayload: unknown;
    readonly resourceName?: string;
    readonly version?: string;
    readonly validationConfig?: unknown;
    readonly errorMap?: Record<string, unknown>;
  }) => Record<string, unknown>;
}

const isLegacySchemaModule = (m: unknown): m is LegacySchemaModule =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as Record<string, unknown>).generateJsonSchema === 'function' &&
  typeof (m as Record<string, unknown>).validate === 'function';

const loadLegacySchemaModule = (): LegacySchemaModule => {
  const raw: unknown = requireLegacy(resolve(dirname(fileURLToPath(import.meta.url)), '../legacy/lib/schema/index.js'));
  if (!isLegacySchemaModule(raw)) {
    throw new Error('Failed to load the legacy schema module — expected generateJsonSchema / validate exports.');
  }
  return raw;
};

/** The legacy `validate()` result carries a running error tally on `stats` and a per-message cache. */
interface LegacyValidateResult {
  readonly stats?: { readonly totalErrors?: number };
  readonly errorCache?: Record<string, unknown>;
}

/**
 * Normalize a version to DD major.minor (`2.1.0` → `2.1`). The legacy validator's `getVersion()` keys the
 * `ignoreEnumerations` exemption lookup, and `schema-validation-settings.json` is keyed `2.0`/`2.1`; the Core
 * endorsement carries the full semver (`2.1.0`), which would miss the exemptions and false-fail the exempt
 * fields. The single generated schema is not version-keyed, so this only steers the exemption lookup/error text.
 */
const toDataDictionaryVersion = (version: string): string => version.split('.').slice(0, 2).join('.');

/**
 * Resolve the committed exemptions file: the current run directory first, then the copy shipped beside the
 * package root (`../..` from `src/sdk` in dev, `dist/sdk` when packaged — same depth as `schema-command.ts`).
 * `fileURLToPath` (not `new URL().pathname`) keeps this correct on Windows.
 */
const resolveSettingsPath = (): string | undefined => {
  const cwdSettings = resolve(process.cwd(), SETTINGS_FILE);
  if (existsSync(cwdSettings)) return cwdSettings;
  const prebaked = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', SETTINGS_FILE);
  return existsSync(prebaked) ? prebaked : undefined;
};

/** Load the exemptions (`ignoreEnumerations`) config; `{}` (no exemptions) when the file is absent/unreadable. */
const loadValidationConfig = async (): Promise<Record<string, unknown>> => {
  const path = resolveSettingsPath();
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** A `Collection(...)` type in the metadata report (e.g. `Collection(org.reso.metadata.enums.Feature)`). */
const COLLECTION_TYPE = /^Collection\((.+)\)$/;

/**
 * Align the provider report's collection fields with the shape the legacy schema generator expects.
 *
 * `generateMetadataReport` serializes a non-expansion collection field's `type` WRAPPED
 * (`Collection(org.reso.metadata.enums.Feature)`), whereas the legacy generator — written for the DD-reference
 * shape — matches a collection field's ELEMENT type against the advertised lookups and primitive map. Left
 * wrapped, an enum collection resolves to an empty enum (only `null` valid) and a primitive collection to
 * `items: { type: object }`, so any populated collection value on a compliant server's expanded item would
 * FALSE-FAIL. Unwrapping to the element type restores the DD-reference shape the generator matches on. This is
 * a pure, local no-op for the DD reference itself (its collection fields are already unwrapped) and never
 * touches expansion collections (those key off `typeName`, not `type`).
 */
const unwrapCollectionElementTypes = (report: MetadataReport): MetadataReport => ({
  ...report,
  fields: report.fields.map((field): MetadataReportField => {
    if (field.isCollection === true && field.isExpansion !== true && typeof field.type === 'string') {
      const match = COLLECTION_TYPE.exec(field.type);
      if (match) return { ...field, type: match[1] };
    }
    return field;
  }),
});

export interface CreateExpandSchemaValidatorInput {
  /** The provider's metadata report — its `definitions` cover EVERY resource, so one schema validates any
   *  expanded target entity type. Generate it once per run from the EDMX already fetched (`generateMetadataReport`). */
  readonly metadataReport: MetadataReport;
  /** The endorsement/DD version. Normalized to DD major.minor for the exemption lookup (see
   *  {@link toDataDictionaryVersion}); the legacy validator also requires a truthy version for a payload without
   *  an `@reso.context` (an expanded child item never carries one). */
  readonly version: string;
  /** Exemptions override. Defaults to the committed {@link SETTINGS_FILE}; tests inject a fixture directly so
   *  they never depend on the current working directory. */
  readonly validationConfig?: Readonly<Record<string, unknown>>;
}

/** A compiled schema handle — present only when construction AND the ajv compile both succeeded. */
interface BuiltSchema {
  readonly jsonSchema: unknown;
}

/**
 * Build AND compile the schema ONCE. Returns `undefined` on ANY construction failure — a report the generator
 * cannot project (returns null) OR a schema ajv cannot compile — so the caller can gate the nav on the 200
 * alone rather than let a per-item catch silently pass every item (the false-PASS this guards against).
 *
 * `generateJsonSchema` builds the JSON Schema object but ajv compilation is LAZY (it happens inside the first
 * `validate()`); a warm-up `validate()` against a real resource forces that compile HERE, so a non-compilable
 * schema fails determinately at construction. The legacy `validate()` deep-clones and restores the schema it
 * mutates on each call, so the warm-up leaves no residue for later items.
 */
const buildExpandSchema = async (
  mod: LegacySchemaModule,
  report: MetadataReport,
  ddVersion: string,
  validationConfig: unknown,
): Promise<BuiltSchema | undefined> => {
  try {
    const normalized = unwrapCollectionElementTypes(report);
    const jsonSchema = await mod.generateJsonSchema({ metadataReportJson: normalized, additionalProperties: false });
    if (jsonSchema == null) return undefined;
    // Force the lazy ajv compile of one representative resource now (result discarded) to surface a wholesale
    // schema-compile failure HERE — caught below → undefined validator → the nav gates on the observable 200,
    // never a silent per-item "valid". One compile is enough for a structural/wholesale failure. We deliberately
    // do NOT warm every distinct resource: the legacy validate() compiles a resource-specific schema per call
    // (it mutates `oneOf` per resource before `ajv.compile`), so warming all of them is O(resources) compiles
    // at construction — 41 for the full DD reference, seconds of work on a CI runner. A compile failure isolated
    // to a single OTHER resource is not reachable through generateMetadataReport anyway (the generator emits
    // compilable schemas — even a dangling enum ref compiles, verified), and were it ever to occur the per-item
    // catch degrades that item to the 200-gate rather than fabricating a fail.
    const warmupResource = normalized.fields[0]?.resourceName;
    if (warmupResource) {
      mod.validate({ jsonSchema, jsonPayload: {}, resourceName: warmupResource, version: ddVersion, validationConfig, errorMap: {} });
    }
    return { jsonSchema };
  } catch {
    return undefined;
  }
};

/**
 * Build the expanded-item validator ONCE per run from a metadata report. `generateJsonSchema` builds a schema
 * whose `definitions` cover every resource in the report, so a single schema validates any target entity type.
 *
 * Returns `undefined` when the schema cannot be built or compiled (a determinate tooling failure): the $expand
 * nav then gates on its 200 response alone. A COMPLIANT server never false-fails, and — because a compile
 * failure is surfaced as `undefined` rather than swallowed — the gate never silently passes an item it could
 * not actually validate.
 */
export const createExpandSchemaValidator = async (
  input: CreateExpandSchemaValidatorInput,
): Promise<ExpandItemValidator | undefined> => {
  const mod = loadLegacySchemaModule();
  const ddVersion = toDataDictionaryVersion(input.version);
  const validationConfig = input.validationConfig ?? (await loadValidationConfig());

  const built = await buildExpandSchema(mod, input.metadataReport, ddVersion, validationConfig);
  if (!built) return undefined;

  return {
    validate: (item, targetType) => {
      try {
        const result = mod.validate({
          jsonSchema: built.jsonSchema,
          jsonPayload: item,
          resourceName: targetType,
          version: ddVersion,
          validationConfig,
          errorMap: {},
        }) as LegacyValidateResult;
        const totalErrors = result.stats?.totalErrors ?? 0;
        const errors = Object.keys(result.errorCache ?? {});
        return { valid: totalErrors === 0, errors };
      } catch {
        // The schema COMPILED at construction (buildExpandSchema warmed it up), so a throw HERE is a genuinely
        // unexpected per-item failure (an odd item shape / unknown target), not a systematic compile failure.
        // Treat THIS item as indeterminate — never a false fail — while a real compile failure was already
        // caught at construction (→ undefined validator), so it can never masquerade as "all valid".
        return { valid: true, errors: [] };
      }
    },
  };
};
