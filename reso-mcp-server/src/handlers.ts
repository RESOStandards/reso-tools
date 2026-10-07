/**
 * MCP tool handlers — implement each tool by calling SDK functions.
 */

import { fetchMetadata, getEntityType, parseMetadataXml, runComplianceTests } from '@reso-standards/reso-certification';
import type { AuthConfig, ComplianceConfig } from '@reso-standards/reso-certification';
import { createClient, createEntity, deleteEntity, queryEntities, resolveToken, updateEntity } from '@reso-standards/reso-client';
import type { ODataClient } from '@reso-standards/reso-client';
import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
import {
  CLIENT_CREDENTIAL_ARG_NAMES,
  CREDENTIAL_ARG_NAMES,
  ENV_AUTH_TOKEN,
  ENV_BASE_URL,
  ENV_CLIENT_CREDENTIAL_NAMES,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  ENV_SCOPE,
  ENV_TOKEN_URI
} from './auth-env.js';

/** Auth args common to most tools. */
interface AuthArgs {
  readonly authToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  /**
   * The data server this call targets, read from the same `url` argument the handlers already
   * destructure, so no call site had to change to supply it.
   *
   * It is here because the resolver needs it: an environment credential may only be sent to the host
   * {@link ENV_BASE_URL} names, and that check is impossible without knowing where the call is going.
   * Absent for `authenticate`, which contacts only the token endpoint carried by the credential
   * itself and no data server.
   */
  readonly url?: string;
}

/**
 * The environment as the resolver reads it. Always passed in and never read inside the resolver, so
 * a test can hand in a literal and watch the resolution decision directly.
 */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

/** Which channel supplied the credentials. The `authenticate` tool reports this. The values never are. */
export type AuthSource = 'arguments' | 'environment';

/** A resolved credential set together with the channel it came from. */
export interface ResolvedAuth {
  readonly auth: AuthConfig;
  readonly source: AuthSource;
  /**
   * The base URL an environment credential is bound to, present only when `source` is
   * `environment`. An argument credential has no binding: the caller chose the credential and the
   * host together, so there is nothing to constrain.
   */
  readonly boundTo?: string;
}

const AUTH_MODE_TOKEN = 'token' as const;
const AUTH_MODE_CLIENT_CREDENTIALS = 'client_credentials' as const;
const SOURCE_ARGUMENTS = 'arguments' as const;
const SOURCE_ENVIRONMENT = 'environment' as const;

const AUTH_REQUIRED_MESSAGE = `Authentication required. Set ${ENV_BASE_URL} together with ${ENV_AUTH_TOKEN}, or with ${ENV_CLIENT_CREDENTIAL_NAMES.join(' + ')}, in the environment the MCP server process runs in. ${ENV_BASE_URL} is required alongside the credential: it names the one server the credential may be sent to. Passing ${CREDENTIAL_ARG_NAMES.join(', ')} as tool arguments works too and overrides the environment for that one call, but a tool argument is visible in the conversation, so the environment is the right place for a secret.`;

/** Present means a non-empty string. This is the truthiness these handlers have always applied. */
const isPresent = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The names, never the values, of the entries that are absent. */
const absentNames = (entries: ReadonlyArray<readonly [string, unknown]>): ReadonlyArray<string> =>
  entries.filter(([, value]) => !isPresent(value)).map(([name]) => name);

/**
 * Credentials from the call's own arguments.
 *
 * Returns undefined only when the call carries no credential argument at all, which is the single
 * case in which the environment is consulted. An incomplete client-credentials set is refused here
 * rather than completed from the environment: completing it would post one server's secret to
 * another server's token endpoint.
 */
const authFromArgs = (args: AuthArgs): ResolvedAuth | undefined => {
  if (isPresent(args.authToken)) {
    return { auth: { mode: AUTH_MODE_TOKEN, authToken: args.authToken }, source: SOURCE_ARGUMENTS };
  }

  const { clientId, clientSecret, tokenUrl } = args;
  if (isPresent(clientId) && isPresent(clientSecret) && isPresent(tokenUrl)) {
    return { auth: { mode: AUTH_MODE_CLIENT_CREDENTIALS, clientId, clientSecret, tokenUrl }, source: SOURCE_ARGUMENTS };
  }

  const absent = absentNames([
    ['clientId', clientId],
    ['clientSecret', clientSecret],
    ['tokenUrl', tokenUrl]
  ]);
  if (absent.length === CLIENT_CREDENTIAL_ARG_NAMES.length) return undefined;

  throw new Error(
    `Incomplete client credentials in the tool arguments: ${absent.join(', ')} missing. Pass all of ${CLIENT_CREDENTIAL_ARG_NAMES.join(', ')} together. A partial set is never completed from the environment, because that would send one server credential to a different server.`
  );
};

/**
 * Credentials from the MCP server process environment.
 *
 * Client credentials win over a bearer token when all three are set, which is the order reso-client
 * declares for the same variables (reso-client/src/env.ts:54, :69), so one environment means the
 * same thing to the reso-cert CLI and to this server. An incomplete set is refused rather than
 * falling through to the bearer token, which is stricter than reso-client: a half-configured set is
 * more likely a typo than an intention, and falling through would answer it with an unrelated
 * credential that happened to be set.
 */
const authFromEnv = (env: AuthEnv): ResolvedAuth | undefined => {
  const clientId = env[ENV_CLIENT_ID];
  const clientSecret = env[ENV_CLIENT_SECRET];
  const tokenUrl = env[ENV_TOKEN_URI];

  /**
   * An environment credential without a bound destination is refused. Fail closed: the alternative
   * is an ambient secret that any call's `url` can collect, which is a worse failure than refusing
   * to start. Called at each point a credential is found rather than once up front, so an
   * environment with no credential at all still returns undefined and falls through to the ordinary
   * "authentication required" refusal.
   */
  const bound = (resolved: Omit<ResolvedAuth, 'boundTo'>): ResolvedAuth => {
    const baseUrl = env[ENV_BASE_URL];
    if (!isPresent(baseUrl)) {
      throw new Error(
        `${ENV_BASE_URL} is not set, so the credential in the MCP server environment has no server it is allowed to be sent to and was not used. ` +
          `Set ${ENV_BASE_URL} to the data server those credentials belong to. An unbound environment credential would be sent to whatever host a tool call names, which is why it is refused instead.`
      );
    }
    return { ...resolved, boundTo: baseUrl };
  };

  if (isPresent(clientId) && isPresent(clientSecret) && isPresent(tokenUrl)) {
    const scope = env[ENV_SCOPE];
    const auth = { mode: AUTH_MODE_CLIENT_CREDENTIALS, clientId, clientSecret, tokenUrl };
    return bound({ auth: isPresent(scope) ? { ...auth, scope } : auth, source: SOURCE_ENVIRONMENT });
  }

  const absent = absentNames([
    [ENV_CLIENT_ID, clientId],
    [ENV_CLIENT_SECRET, clientSecret],
    [ENV_TOKEN_URI, tokenUrl]
  ]);
  if (absent.length < ENV_CLIENT_CREDENTIAL_NAMES.length) {
    throw new Error(
      `Incomplete client credentials in the MCP server environment: ${absent.join(', ')} not set. Set all of ` +
        `${ENV_CLIENT_CREDENTIAL_NAMES.join(', ')}, or unset all of them to use ${ENV_AUTH_TOKEN}.`
    );
  }

  const authToken = env[ENV_AUTH_TOKEN];
  if (isPresent(authToken)) {
    return bound({ auth: { mode: AUTH_MODE_TOKEN, authToken }, source: SOURCE_ENVIRONMENT });
  }

  return undefined;
};

/**
 * Same origin means same protocol, host and port. Protocol is included deliberately: http against
 * https for one host is a downgrade, and a credential set for the secure origin should not travel
 * over the insecure one. A value that does not parse returns false, so a malformed target refuses
 * rather than being waved through.
 */
const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/**
 * Enforce the binding on an environment credential.
 *
 * `targetUrl` absent means no data server is being contacted. Only `authenticate` is in that
 * position: it exchanges credentials at the token endpoint carried by the credential itself, and
 * returns no token, so there is no destination to constrain and nothing to disclose. Every tool that
 * reaches a data server passes its `url` through, so this is not a hole a new tool falls into
 * silently; a tool with a target has a target to check.
 */
const withinBinding = (resolved: ResolvedAuth, targetUrl: string | undefined): ResolvedAuth => {
  if (targetUrl === undefined) return resolved;
  if (!isPresent(resolved.boundTo)) {
    throw new Error(`An environment credential reached a call for ${targetUrl} without a bound server. Refusing.`);
  }
  if (sameOrigin(targetUrl, resolved.boundTo)) return resolved;

  throw new Error(
    `The credential in the MCP server environment is bound to ${resolved.boundTo} (${ENV_BASE_URL}) and this call targets ${targetUrl}, so it was not used. Pass ${CREDENTIAL_ARG_NAMES.join(', ')} as arguments to reach a different server, or change ${ENV_BASE_URL}. The environment credential is never sent to a host it was not set for.`
  );
};

/**
 * Resolve the credential set for one call. Pure: the call's arguments and the environment record are
 * the only inputs, and the chosen channel comes back as `source`, so a test asserts the decision
 * itself instead of inferring it from a side effect.
 *
 * Arguments win as a set. When the call carries any credential argument the environment is not read
 * at all, so no field is ever taken from one channel and combined with the other. Every message this
 * throws names argument names and variable names, never a value.
 */
export const resolveAuth = (args: AuthArgs, env: AuthEnv): ResolvedAuth => {
  const fromArgs = authFromArgs(args);
  if (fromArgs) return fromArgs;

  const fromEnv = authFromEnv(env);
  if (fromEnv) return withinBinding(fromEnv, args.url);

  throw new Error(AUTH_REQUIRED_MESSAGE);
};

/** Resolve a bearer token for one call: the call's arguments first, then the server environment. */
const resolveAuthToken = async (args: AuthArgs): Promise<string> => resolveToken(resolveAuth(args, process.env).auth);

/** Build an AuthConfig for the certification SDK: the call's arguments first, then the server environment. */
const buildAuthConfig = (args: AuthArgs): AuthConfig => resolveAuth(args, process.env).auth;

/** Tool handler result — matches MCP SDK's CallToolResult shape. */
interface HandlerResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const textResult = (data: unknown): HandlerResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

const errorResult = (message: string): HandlerResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
});

/**
 * A result with a note attached as its own content block, so the payload the server returned is
 * handed back byte for byte and the note never becomes a key inside it.
 */
const resultWithNote = (data: unknown, note: string): HandlerResult => ({
  content: [
    { type: 'text', text: JSON.stringify(data, null, 2) },
    { type: 'text', text: note }
  ]
});

/**
 * What to tell the model when a filtered query matches nothing.
 *
 * "No listings found" is the obvious reply and the least useful one. The criteria are conjoined, so
 * which of them emptied the set is recoverable by re-counting with each one removed, and that is
 * usually the answer the user actually wanted: a literal "3 bedrooms" excludes a five-bedroom house.
 *
 * It instructs a re-query rather than an estimate. A breakdown inferred from what is already in hand
 * would be a guess, and a confident one, because an empty result carries no rows to reason from.
 */
const NO_MATCH_GUIDANCE =
  'No records matched this filter. Do not stop at reporting zero. Tell the user no exact matches ' +
  'were found, then offer them the breakdown: re-run this query once per criterion with that ' +
  'criterion removed, each with count=true and top=0, and report how many records each relaxation ' +
  'would return, naming the one that eliminated the matches. Then ask whether they want to widen ' +
  'or change their criteria. Take every number from an actual query and never estimate one. ' +
  'Speak in the terms the user used, such as bedrooms, price, acreage and city. Do not mention ' +
  'field names, filters, parsers or query syntax unless they ask how it works. Assume someone who ' +
  'knows real estate and data but not necessarily more than that.';

/** True for an OData payload whose `value` is present and empty. */
const isEmptyResult = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  Array.isArray((body as { value?: unknown }).value) &&
  (body as { value: ReadonlyArray<unknown> }).value.length === 0;

/** Consecutive misses that re-earn the offer after it has already been made once. */
const GUIDANCE_STREAK_THRESHOLD = 3;

/**
 * Decides whether an empty result should carry the guidance.
 *
 * Said once it is useful and said every time it is nagging, so two gates govern it. The first empty
 * filtered query of a session earns the offer. After that it takes a run of
 * GUIDANCE_STREAK_THRESHOLD consecutive misses, because someone striking out repeatedly is in a
 * different situation from someone whose one speculative search came back empty.
 *
 * Every offer resets the run, so the cadence is miss 1, then miss 4, then miss 7, rather than
 * firing on each miss once the threshold is passed. Any query that returns rows resets it too: a
 * run means consecutive, not cumulative.
 *
 * Session scope is process scope here, since the stdio transport runs one server process per client
 * session, so state that lives as long as this module lives exactly as long as the session. Both
 * mutable values are sealed inside the closure and never leave it, which is the one place the coding
 * standards allow local mutable state.
 */
export const createGuidanceGate = (threshold: number): ((missed: boolean) => boolean) => {
  let offered = false;
  let run = 0;

  return (missed: boolean): boolean => {
    if (!missed) {
      run = 0;
      return false;
    }

    run += 1;

    if (!offered) {
      offered = true;
      run = 0;
      return true;
    }

    if (run >= threshold) {
      run = 0;
      return true;
    }

    return false;
  };
};

const offerNoMatchGuidance = createGuidanceGate(GUIDANCE_STREAK_THRESHOLD);

// ── Authenticate ──

const AUTHENTICATE_EXCHANGED_MESSAGE =
  'The token endpoint issued a token for these credentials. The token was discarded and is not returned. ' +
  'Nothing was checked against a data server. Every other tool obtains its own token from the same credentials on each call, ' +
  'so no authenticate step is needed before them.';

const AUTHENTICATE_TOKEN_MODE_MESSAGE =
  'A bearer token is configured, so there was no token exchange to make and nothing was checked. ' +
  'The other tools send the token as it is. Call metadata or query to find out whether a server accepts it.';

/**
 * The token endpoint reduced to origin and path, so a result can say which endpoint answered. Query
 * string and fragment are dropped, because a configured URL can carry a secret in them and this
 * tool's result text becomes conversation history. Returns undefined when the value does not parse,
 * so an unparsed string is never echoed back.
 */
const tokenEndpointLabel = (tokenUrl: string): string | undefined => {
  try {
    const parsed = new URL(tokenUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};

/**
 * Check that the server can authenticate, without returning a token.
 *
 * Credentials resolve exactly as they do for every other tool, so this reports the configuration the
 * other tools will actually use. Called with no arguments it checks the server environment, which is
 * the point of the tool: a user confirms the setup works without putting a credential in the
 * conversation. The result reports the mode, the channel and the endpoint, and no credential.
 */
export const handleAuthenticate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { scope } = args as { scope?: string };
  const { auth, source } = resolveAuth(args as AuthArgs, process.env);

  if (auth.mode === AUTH_MODE_TOKEN) {
    return textResult({ mode: auth.mode, source, message: AUTHENTICATE_TOKEN_MODE_MESSAGE });
  }

  // An explicit scope argument overrides RESO_SCOPE. Scope is not a credential and cannot change
  // which endpoint a secret reaches, so it is the one field allowed to cross between the channels.
  await resolveToken(isPresent(scope) ? { ...auth, scope } : auth);

  const endpoint = tokenEndpointLabel(auth.tokenUrl);

  return textResult({
    mode: auth.mode,
    source,
    ...(endpoint ? { tokenEndpoint: endpoint } : {}),
    message: AUTHENTICATE_EXCHANGED_MESSAGE
  });
};

// ── Query ──

export const handleQuery = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { url, resource, filter, select, orderby, top, skip, count, expand } = args as {
    url: string;
    resource: string;
    filter?: string;
    select?: string;
    orderby?: string;
    top?: number;
    skip?: number;
    count?: boolean;
    expand?: string;
  };

  const client = await clientFor(url, args as AuthArgs);

  // The SDK owns the query-option encoding. Hand-assembling these into a query string is the one
  // place this adapter used to reimplement something the client already does, and it did it less
  // carefully: the builder escapes what belongs escaped and omits what was not asked for.
  const response = await queryEntities(client, resource, {
    ...(filter ? { $filter: filter } : {}),
    ...(select ? { $select: select } : {}),
    ...(orderby ? { $orderby: orderby } : {}),
    ...(top != null ? { $top: top } : {}),
    ...(skip != null ? { $skip: skip } : {}),
    ...(count ? { $count: true } : {}),
    ...(expand ? { $expand: expand } : {})
  });

  if (response.status !== 200) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  // Consulted on every successful query, not only the empty ones, because a query that returns rows
  // is what breaks a run of misses.
  const missed = Boolean(filter) && isEmptyResult(response.body);

  return offerNoMatchGuidance(missed) ? resultWithNote(response.body, NO_MATCH_GUIDANCE) : textResult(response.body);
};

// ── Write helpers ──

/**
 * An SDK client bound to one server, with the credential already resolved.
 *
 * `resolveAuthToken` runs first and stays the single enforcement point for the environment
 * credential's origin binding, so no client exists until that check has passed. Building one any
 * other way would route around it.
 *
 * A client per call, because the credential can differ per call. That is what the certification
 * runner's own helper did, so this is the same cost at a higher layer.
 */
const clientFor = async (url: string, args: AuthArgs): Promise<ODataClient> => {
  const authToken = await resolveAuthToken(args);

  return createClient({
    baseUrl: url.replace(/\/$/, ''),
    auth: { mode: 'token', authToken }
  });
};

const writeOk = (status: number): boolean => status >= 200 && status < 300;

// ── Create ──

export const handleCreate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { url, resource, record } = args as {
    url: string;
    resource: string;
    record: Record<string, unknown>;
  };

  const client = await clientFor(url, args as AuthArgs);
  const response = await createEntity(client, resource, record);

  if (!writeOk(response.status)) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult({ status: response.status, body: response.body });
};

// ── Update ──

export const handleUpdate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { url, resource, key, record, ifMatch } = args as {
    url: string;
    resource: string;
    key: string;
    record: Record<string, unknown>;
    ifMatch?: string;
  };

  const client = await clientFor(url, args as AuthArgs);

  // ifMatch is the reason this goes through the SDK's write helper rather than a raw PATCH. Passing
  // the ETag from the record as read turns a blind overwrite into a conditional one, so an edit made
  // by someone else in between is refused instead of silently lost.
  const response = await updateEntity(client, resource, key, record, isPresent(ifMatch) ? { ifMatch } : undefined);

  if (!writeOk(response.status)) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult({ status: response.status, body: response.body });
};

// ── Delete ──

export const handleDelete = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { url, resource, key, ifMatch } = args as {
    url: string;
    resource: string;
    key: string;
    ifMatch?: string;
  };

  const client = await clientFor(url, args as AuthArgs);
  const response = await deleteEntity(client, resource, key, isPresent(ifMatch) ? { ifMatch } : undefined);

  if (!writeOk(response.status)) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult({ status: response.status, body: response.body });
};

// ── Metadata ──

export const handleMetadata = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, resource } = args as { url: string; resource?: string };

  const metadataXml = await fetchMetadata(url, authToken);
  const metadata = parseMetadataXml(metadataXml);

  if (resource) {
    const entityType = getEntityType(metadata, resource);
    if (!entityType) {
      return errorResult(`Resource "${resource}" not found in metadata. Available: ${metadata.entityTypes.map(et => et.name).join(', ')}`);
    }
    return textResult(entityType);
  }

  return textResult(metadata);
};

// ── Validate ──

export const handleValidate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { record, resource } = args as { record: Record<string, unknown>; resource: string };

  // Fetch field definitions for the resource
  // For now, return a basic validation check
  // TODO: integrate with reso-validation when field metadata is available
  const fieldCount = Object.keys(record).length;
  return textResult({
    resource,
    fieldsProvided: fieldCount,
    message: `Record has ${fieldCount} fields. Full DD validation requires server metadata, so call the metadata tool first to fetch field definitions.`
  });
};

// ── Parse Filter ──

export const handleParseFilter = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { filter } = args as { filter: string };

  try {
    // Dynamic import since odata-expression-parser may not export types we need at compile time
    const { parseFilter } = await import('@reso-standards/odata-expression-parser');
    const ast = parseFilter(filter);
    return textResult(ast);
  } catch (err) {
    return errorResult(`Failed to parse filter: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ── Run Compliance ──

export const handleRunCompliance = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { endorsement, url, resource, version, mode, resources } = args as {
    endorsement: string;
    url: string;
    resource?: string;
    version?: string;
    mode?: string;
    resources?: ReadonlyArray<string>;
  };

  const auth = buildAuthConfig(args as AuthArgs);
  const progressLog: string[] = [];

  const buildConfig = (): ComplianceConfig => {
    const server = { url, auth };

    switch (endorsement) {
      case 'add-edit':
        return { endorsement: 'add-edit' as const, server, resource: resource ?? 'Property' };
      case 'entity-event':
        return { endorsement: 'entity-event' as const, server, mode: (mode as 'observe' | 'full') ?? 'observe' };
      case 'core':
        return { endorsement: 'core' as const, server, version: (version as '2.0.0' | '2.1.0') ?? '2.0.0', resources };
      default:
        throw new Error(`Unknown endorsement: ${endorsement}`);
    }
  };

  const config = buildConfig();

  const result = await runComplianceTests(config, (progress: { step: string; status: string; message?: string; duration?: number }) => {
    const icon = progress.status === 'passed' ? '\u2713' : progress.status === 'failed' ? '\u2717' : '\u25CB';
    const msg = progress.message ? ` \u2014 ${progress.message}` : '';
    const dur = progress.duration ? ` (${progress.duration}ms)` : '';
    progressLog.push(`${icon} ${progress.step}${msg}${dur}`);
  });

  return textResult({
    status: result.status,
    endorsement: result.endorsement,
    duration: result.duration,
    steps: result.steps.map((s: { name: string; status: string; duration: number; summary?: string; errors?: ReadonlyArray<string> }) => ({
      name: s.name,
      status: s.status,
      duration: s.duration,
      summary: s.summary,
      errors: s.errors
    })),
    progress: progressLog
  });
};

// ── Metadata Report ──

export const handleMetadataReport = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, version } = args as { url: string; version?: string };

  const metadataXml = await fetchMetadata(url, authToken);
  const report = generateMetadataReport(metadataXml, version ?? '2.0');

  return textResult(report);
};

// ── Handler Map ──

export const handlers: Readonly<Record<string, (args: Record<string, unknown>) => Promise<HandlerResult>>> = {
  authenticate: handleAuthenticate,
  query: handleQuery,
  metadata: handleMetadata,
  create: handleCreate,
  update: handleUpdate,
  delete: handleDelete,
  validate: handleValidate,
  'parse-filter': handleParseFilter,
  'run-compliance': handleRunCompliance,
  'metadata-report': handleMetadataReport
};
