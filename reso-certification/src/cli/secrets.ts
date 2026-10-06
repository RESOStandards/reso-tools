/**
 * Secret masking for anything the CLI prints.
 *
 * The problem this solves: `--output json` was a bare `JSON.stringify` of the pipeline result, and
 * the result carries the accumulated context, and the context carries the bearer token the steps
 * use to make requests. So the token reached stdout — in the output the guide recommends archiving.
 *
 * Masking is keyed on the VALUE, not on a list of field names. A denylist of fields is only ever
 * safe for the fields someone remembered, and the leak above happened precisely because nobody
 * enumerated what was in the context. A value we hold can be caught wherever it surfaces: a context
 * field, a request URL in verbose output, an error message quoting a header, an echoed response body.
 *
 * It is a net, not the fix. The credential is also dropped from the serialized context, so the mask
 * is what catches the paths we failed to think of rather than the only thing standing there.
 */

/**
 * The registered secret values, longest first so that a secret which contains another is masked
 * before its substring is. Insertion order is not enough: a token and the client secret it was
 * minted from can overlap.
 */
const secrets = new Set<string>();

/**
 * Values shorter than this are never registered.
 *
 * This is a different concern from how much of a secret is revealed. Masking every occurrence of a
 * short string would corrupt unrelated output: registering `abc` would rewrite that sequence
 * wherever it appeared, including inside field names and URLs. No real credential is this short, so
 * the floor costs nothing and removes the failure mode.
 */
const MIN_REGISTERABLE_LENGTH = 8;

/** The fixed number of stars. Constant, so the masked form carries no length signal. */
const STARS = 4;

/** The most trailing characters ever revealed. */
const MAX_REVEALED = 4;

/**
 * Mask one value: four stars, then up to four of its trailing characters.
 *
 *   length 4 or less -> `****`      (nothing revealed; the value is too short to spare any)
 *   length 5         -> `****e`
 *   length 6         -> `****de`
 *   length 8 or more -> `****cdef`  (capped at four)
 *
 * The reveal exists so an operator can tell two runs apart, or confirm which credential was used,
 * without the value being recoverable. Four stars regardless of length means a 40-character token
 * and a 200-character one render identically.
 */
export const maskSecret = (value: string): string => {
  const revealed = Math.min(Math.max(value.length - STARS, 0), MAX_REVEALED);
  return '*'.repeat(STARS) + (revealed > 0 ? value.slice(-revealed) : '');
};

/**
 * Register a secret so it is masked wherever it later appears in output.
 *
 * Call this where a secret COMES INTO EXISTENCE, not where a flag is parsed. The distinction is
 * load bearing: with client credentials the token that reaches the output is the one
 * `fetchAccessToken` mints, a value nobody typed, so registering only the flags would miss the
 * single value most likely to be printed.
 *
 * Returns the value unchanged, so it can wrap an expression at the point of creation.
 */
export const registerSecret = (value: string | undefined): string | undefined => {
  if (value && value.length >= MIN_REGISTERABLE_LENGTH) secrets.add(value);
  return value;
};

/** Every registered secret, longest first. Exported for the masker and for tests. */
const byLengthDescending = (): ReadonlyArray<string> => [...secrets].sort((a, b) => b.length - a.length);

/**
 * Replace every registered secret in `text` with its masked form.
 *
 * Longest first, so a secret that contains another does not leave the shorter one's tail behind.
 * Plain string replacement rather than a regular expression, because a secret can contain
 * characters a pattern would treat as syntax.
 */
export const maskSecrets = (text: string): string =>
  byLengthDescending().reduce((masked, secret) => masked.split(secret).join(maskSecret(secret)), text);

/**
 * Known limit, recorded rather than left to be discovered: an ENCODED occurrence is not caught.
 * A Basic authorization header is base64 of `id:secret`, and a value in a query string may be
 * percent-encoded, so neither matches the raw bytes. Where the code builds such a form from a
 * secret it holds, register the built form with `registerSecret` as well — which is also the case
 * the longest-first ordering above exists for, since a wrapped form contains the raw one.
 */

/** Test seam. Not for production use: the registry is process-wide by design. */
export const __clearSecretsForTest = (): void => secrets.clear();

/** Test seam: how many secrets are registered. */
export const __registeredCountForTest = (): number => secrets.size;
