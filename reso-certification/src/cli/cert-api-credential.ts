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
 */
export const resolveCertApiCredential = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.CLIENT_SECRET ?? env.CERTIFICATION_API_KEY;

/** Said when neither variable is set. The same words from every command that needs the credential. */
export const MISSING_CERT_API_CREDENTIAL =
  'No credential. Set CLIENT_SECRET (the value from the downloaded credentials file) or CERTIFICATION_API_KEY.';
