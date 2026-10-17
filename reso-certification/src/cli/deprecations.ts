/**
 * Spellings the CLI still recognizes in order to explain that they are gone.
 *
 * This file is the whole extent of the deprecation. It lives under `src/cli/` on purpose: the engine
 * (`src/web-api-core/**`) and the SDK (`src/sdk/**`) must not know the old names exist, so nothing
 * downstream can grow a dependency on a spelling we are removing. `ConfigCoreOptions` no longer declares
 * `preferFields` either, which is why the reader below narrows an `unknown` rather than reading a typed
 * field.
 *
 * It is separate from `cli/index.ts` only because that module calls `program.parse()` at import time and so
 * cannot be loaded by a test. Operator-facing text on a breaking change is worth a test.
 */

/**
 * Pull a removed `coreOptions.preferFields` out of a config entry's `coreOptions` block.
 *
 * Accepts BOTH shapes. The 0.11.0 flag took a comma-separated string and the config took an array, and a
 * hand-written or hand-edited config could reasonably carry either. Reading only the array form let a
 * string-valued key through in silence: the run went fully automatic and said nothing about it, which is
 * the one outcome this notice exists to prevent.
 *
 * Returns the entries as written, trimmed, so the notice can name them back to the operator.
 */
export const removedPreferFields = (coreOptions: unknown): ReadonlyArray<string> => {
  if (!(typeof coreOptions === 'object' && coreOptions !== null && 'preferFields' in coreOptions)) return [];
  const value = coreOptions.preferFields;
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
};

/**
 * The single explanation of the 0.11.1 override rename, shared by the flag and the config paths so the two
 * cannot drift apart.
 *
 * It carries two separate facts, and the second is the one that matters: the spelling changed, AND the
 * behavior changed. An operator who only reads "renamed" would retype the same list and get a run that
 * certifies something different from what their old list certified. So the lines are separate rather than
 * run together as prose nobody finishes, and the last of them says outright why the value was not carried
 * over for them.
 */
export const overrideRenameNotice = (removed: string, replacement: string, found: ReadonlyArray<string>): string =>
  [
    `${removed} was removed in 0.11.1 and its value was ignored: ${found.join(', ')}`,
    `Use ${replacement} instead, with each entry as Resource.Field – a bare field name is no longer accepted.`,
    'The behavior also changed. An override now REPLACES automatic selection for its data type rather than',
    're-ordering candidates, so the named field is the one tested and a failure on it fails that test instead',
    'of falling back to an automatic choice. The value was not carried over for you, because applying the new',
    'binding behavior to a list written for the old one would change what your run certifies.'
  ].join('\n');
