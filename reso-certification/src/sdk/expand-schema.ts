/**
 * Expanded-item schema validator for the Core 2.1.0 $expand test.
 *
 * Builds a reusable validator from the provider's metadata report using the LEGACY JSON-schema utilities
 * (`src/legacy/lib/schema`) — generate the JSON Schema ONCE, then validate each expanded child item against its
 * target entity type. The Web API Core runner consumes it through the {@link ExpandItemValidator} interface and
 * never touches the schema machinery itself.
 *
 * The legacy module is loaded lazily via a dynamic `import()` with a LITERAL specifier so the esbuild
 * cert-worker bundle inlines it — a computed `createRequire` path escapes static analysis and fails to load
 * in the packaged app (reso-tools-private #102); the lazy `import()` also defers the ajv + ETL-reference cost
 * until the $expand path actually runs. We call the legacy utilities DIRECTLY (`generateJsonSchema` /
 * `validate`) rather than the CLI's typed wrappers to avoid an sdk → cli layering inversion (cli already
 * depends on sdk).
 *
 * ── Validation policy (mirrors DD/Core testing exactly — NOT RCF mode) ──
 *  - `additionalProperties: false` when generating the schema: a field on the expanded item that the provider's
 *    metadata does not advertise is an ERROR (`Fields MUST be advertised in the metadata`).
 *  - The severity mode follows the ACQUISITION PATH (#298): every expanded child item is validated with
 *    `acquisition: 'transport'` → DD/Core mode whether or not it carries `@reso.context`: a value exceeding the
 *    provider's declared `maxLength` is a hard ERROR (`MUST have a maximum advertised length …`), never the RCF
 *    `SHOULD have a maximum suggested length` warning. An item is `embedded` in its page, so an absent context
 *    on the item is never a finding; a present one is checked.
 *  - The committed `schema-validation-settings.json` exemptions are threaded as `validationConfig`, so the
 *    `ignoreEnumerations` fields (Property MLS-area/school, Media ImageSizeDescription) downgrade an
 *    unadvertised-enum ERROR to a WARNING — exactly as the DD/schema path does. The settings are keyed by DD
 *    major.minor (`2.0`/`2.1`), so the endorsement version (`2.1.0`) is normalized before it reaches the
 *    validator's `getVersion()` exemption lookup.
 *  - The nav gates on `stats.totalErrors === 0`: errors fail, warnings do not.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataReport, MetadataReportField } from '@reso-standards/reso-metadata-utils';
import type { ExpandItemValidator } from '../web-api-core/test-runner.js';

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
    /** How the payload was obtained (#298): transport rules vs RCF rules; omitted = legacy presence heuristic. */
    readonly acquisition?: 'transport' | 'rcf';
    /** The payload is an item embedded in a page: an absent context on it is never a finding (#298). */
    readonly embedded?: boolean;
  }) => Record<string, unknown>;
}

const isLegacySchemaModule = (m: unknown): m is LegacySchemaModule =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as Record<string, unknown>).generateJsonSchema === 'function' &&
  typeof (m as Record<string, unknown>).validate === 'function';

const loadLegacySchemaModule = async (): Promise<LegacySchemaModule> => {
  // Static specifier so esbuild bundles the legacy module (+ its graph) into the cert-worker bundle;
  // a computed createRequire path escapes static analysis and fails in the packaged app (reso-tools-private #102).
  // Dynamic import() keeps the load lazy — the legacy module pulls in ajv + the DD reference, loaded only
  // when the $expand schema path actually runs, not at SDK import.
  // The specifier MUST stay a literal in the call so esbuild statically follows + inlines the module
  // (a variable specifier would escape the bundle — the very bug this fixes). `as string` only widens
  // the literal's type so tsc treats it as a runtime dynamic import of the untyped legacy CJS module
  // (no implicit-any TS7016); the assertion is erased in the emitted JS. Shape runtime-guarded below.
  const mod: unknown = await import('../legacy/lib/schema/index.js' as string);
  const raw = (mod as { readonly default?: unknown }).default ?? mod;
  if (!isLegacySchemaModule(raw)) {
    throw new Error('Failed to load the legacy schema module — expected generateJsonSchema / validate exports.');
  }
  return raw;
};

/** The legacy `validate()` result carries a running error tally on `stats` and a per-message cache. */
interface LegacyValidateResult {
  readonly stats?: { readonly totalErrors?: number };
  readonly errorCache?: Record<string, unknown>;
  /** Payload-level failures the legacy validator records outside the error tally (an invalid resource, a
   *  schema-selection failure): the item was not evaluated, so a non-empty map is indeterminate, never valid. */
  readonly payloadErrors?: Record<string, unknown>;
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
export const loadValidationConfig = async (): Promise<Record<string, unknown>> => {
  const path = resolveSettingsPath();
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Narrow `unknown` to a plain object for safe nested lookups (no `any`). */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * Turn the legacy validator's errorCache into ONE message per failing RULE, each naming its offending
 * field(s): "<message> (fields: A, B)". A schema-invalid expanded item then names the field, not just the
 * generic rule — while keeping one entry per rule so a truncated inline preview (validateExpandedItems shows
 * only the first few) never crowds out a distinct second rule. The errorCache is keyed by message; each value
 * nests resources → fields. Falls back to the bare message when no field is attributed. Exported for testing.
 */
export const errorMessagesFromCache = (errorCache: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  Object.entries(errorCache ?? {}).map(([message, entry]) => {
    const resources = asRecord(asRecord(entry)?.resources);
    const fields = resources ? [...new Set(Object.values(resources).flatMap(r => Object.keys(asRecord(asRecord(r)?.fields) ?? {})))] : [];
    return fields.length > 0 ? `${message} (field${fields.length === 1 ? '' : 's'}: ${fields.join(', ')})` : message;
  });

/**
 * True when a resource+field is on the committee-approved ignore-enumerations list (a closed enum whose
 * unadvertised/local values are permitted). The committed `schema-validation-settings.json` is keyed
 * DD-major.minor → resource → field → `{ ignoreEnumerations: true }`, so the endorsement's full semver
 * (`2.1.0`) is normalized to `2.1` before the lookup. `config` is the object {@link loadValidationConfig}
 * returns — pass it once per run and bind the predicate.
 */
export const isEnumerationIgnored = (
  config: Readonly<Record<string, unknown>>,
  version: string,
  resource: string,
  field: string
): boolean => {
  const ddVersion = toDataDictionaryVersion(version);
  const fieldNode = asRecord(asRecord(asRecord(config[ddVersion])?.[resource])?.[field]);
  return fieldNode?.ignoreEnumerations === true;
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
  })
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
  /** Resource types whose resource-specific schema failed to compile during warm-up: every item of such a type
   *  is indeterminate, decided here so the verdict never depends on which resource came first in the report. */
  readonly undeterminable: ReadonlySet<string>;
}

/**
 * Build the schema ONCE and force ajv's lazy compile with a warm-up that walks the report's resources until one
 * compiles. Returns `undefined` only on a wholesale failure — a report the generator cannot project (returns
 * null) or no resource whose schema compiles — so the caller gates the nav on the 200 alone rather than let a
 * per-item catch silently pass every item (the false-PASS this guards against). Resources whose own schema
 * threw during the walk come back in `undeterminable`: their items are indeterminate (#297), decided at
 * construction so the verdict never depends on declaration order. The legacy `validate()` restores the schema
 * it mutates on every exit, so neither the warm-up nor a per-item compile failure leaves residue.
 */
const buildExpandSchema = async (
  mod: LegacySchemaModule,
  report: MetadataReport,
  ddVersion: string,
  validationConfig: unknown
): Promise<BuiltSchema | undefined> => {
  try {
    const normalized = unwrapCollectionElementTypes(report);
    const jsonSchema = await mod.generateJsonSchema({ metadataReportJson: normalized, additionalProperties: false });
    if (jsonSchema == null) return undefined;
    // Warm-up: force the lazy ajv compile now, walking the report's resources in declaration order until ONE
    // compiles. That one compile proves the schema is structurally sound; a wholesale failure (no resource
    // compiles) is caught below → undefined validator → the nav gates on the observable 200, never a silent
    // per-item "valid". A resource whose OWN schema throws (a navigation whose target type has no definition,
    // the 494d9be shape) is recorded as undeterminable — its items are INDETERMINATE (#297) — and the walk moves
    // on, so the verdict never depends on which resource was declared first. We deliberately do not warm every
    // resource: the legacy validate() compiles a resource-specific schema per call, so that would be O(resources)
    // compiles at construction (41 for the full DD reference). A compile failure on a resource the walk did not
    // reach is caught per item instead, and because validate() restores the shared schema on every exit, it
    // leaves nothing behind for the next resource.
    const undeterminable = new Set<string>();
    const resources = [...new Set(normalized.fields.map(field => field.resourceName))];
    for (const resourceName of resources) {
      try {
        mod.validate({
          jsonSchema,
          jsonPayload: {},
          resourceName,
          version: ddVersion,
          validationConfig,
          errorMap: {},
          acquisition: 'transport'
        });
        return { jsonSchema, undeterminable };
      } catch {
        undeterminable.add(resourceName);
      }
    }
    return undefined;
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
export const createExpandSchemaValidator = async (input: CreateExpandSchemaValidatorInput): Promise<ExpandItemValidator | undefined> => {
  const mod = await loadLegacySchemaModule();
  const ddVersion = toDataDictionaryVersion(input.version);
  const validationConfig = input.validationConfig ?? (await loadValidationConfig());

  const built = await buildExpandSchema(mod, input.metadataReport, ddVersion, validationConfig);
  if (!built) return undefined;

  const definitions = (built.jsonSchema as { readonly definitions?: Record<string, unknown> } | null)?.definitions ?? {};
  const hasDefinition = (targetType: string): boolean => Object.hasOwn(definitions, targetType);

  return {
    validate: (item, targetType) => {
      // An unknown target type is INDETERMINATE, not valid: the legacy validate() logs "Found invalid resource",
      // records a payload error and returns the caller's empty error map, so its `totalErrors` would read 0
      // (#297, route 2). Decide here, from the schema, before the legacy call.
      if (!hasDefinition(targetType)) {
        return { valid: false, indeterminate: true, errors: [], reason: `no schema definition for target type ${targetType}` };
      }
      if (built.undeterminable.has(targetType)) {
        return { valid: false, indeterminate: true, errors: [], reason: `the schema for target type ${targetType} could not be compiled` };
      }
      try {
        const result = mod.validate({
          jsonSchema: built.jsonSchema,
          jsonPayload: item,
          resourceName: targetType,
          version: ddVersion,
          validationConfig,
          errorMap: {},
          // an $expand child item is transport-acquired (#298): DD/Core rules, never the advisory RCF mode; it is
          // embedded in the page, so an absent context on the item itself is never a finding (even from DD 3.0)
          acquisition: 'transport',
          embedded: true
        }) as LegacyValidateResult;
        const totalErrors = result.stats?.totalErrors ?? 0;
        // A payload-level failure (recorded outside the tally) means the item was not evaluated: indeterminate,
        // never "valid" read off a zero tally (the third route #297 closes; unreachable through the generator
        // today, since such a failure fails the warm-up, and guarded here so it stays closed).
        const payloadErrors = Object.keys(result.payloadErrors ?? {});
        if (payloadErrors.length > 0) {
          return {
            valid: false,
            indeterminate: true,
            errors: [],
            reason: `validator recorded a payload error for a ${targetType} item: ${payloadErrors.join(', ')}`
          };
        }
        // Field-qualified messages so a schema-invalid expanded item names the offending field(s) — the
        // errorCache already carries them; the old Object.keys(errorCache) surfaced only the generic rule.
        const errors = errorMessagesFromCache(result.errorCache);
        return { valid: totalErrors === 0, errors };
      } catch (err) {
        // The warm-up compiled ONE resource at construction; ajv compiles lazily per resource-specific root, so a
        // throw here is usually a compile failure isolated to THIS target type (e.g. a navigation whose target has
        // no definition — the 494d9be shape) on a non-warm-up resource. That is INDETERMINATE: the item was not
        // evaluated. It was reported as `{ valid: true }` before #297, which the consumer rendered as "all N items
        // valid" — a fabricated pass whose occurrence depended on EntitySet declaration order. Never a false fail
        // either: the consumer reports the navigation as skipped with this reason. The throw is confined to this
        // type: validate() restores the schema it mutated, so later types compile from a clean root.
        const message = err instanceof Error ? err.message : String(err);
        return { valid: false, indeterminate: true, errors: [], reason: `validator could not evaluate a ${targetType} item: ${message}` };
      }
    }
  };
};
