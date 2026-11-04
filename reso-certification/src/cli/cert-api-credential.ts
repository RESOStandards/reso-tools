/**
 * The credential the Cert API commands present, resolved from the environment.
 *
 * `CLIENT_SECRET` first: it is what the certification site's downloaded file carries, and it is
 * already `base64(keyId:apiKey)` - the exact bytes the server's Bearer envelope decodes - so one
 * downloaded file drives these commands with nothing to convert. `CERTIFICATION_API_KEY` is accepted
 * for an environment already set up for the older tools.
 *
 * One resolver, shared by `restore` and `archive-report`, so the two can never drift apart on which
 * variable wins.
 *
 * A variable that is set but empty, or blank, is absent: it falls through to the next one and then
 * to undefined, so an exported-but-empty `CLIENT_SECRET` neither shadows a set
 * `CERTIFICATION_API_KEY` nor reaches a request as a bare `Bearer`. Surrounding whitespace is
 * trimmed, since a credential never carries any and a trailing newline from a shell is common.
 */
const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

export const resolveCertApiCredential = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  present(env.CLIENT_SECRET) ?? present(env.CERTIFICATION_API_KEY);

/** Said when neither variable is set. The same words from every command that needs the credential. */
export const MISSING_CERT_API_CREDENTIAL =
  'No credential. Set CLIENT_SECRET (the value from the downloaded credentials file) or CERTIFICATION_API_KEY.';
