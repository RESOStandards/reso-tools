/**
 * MCP tool handlers — implement each tool by calling SDK functions.
 */

import { resolveToken } from '@reso-standards/reso-client';
import {
  odataRequest,
  buildResourceUrl,
  fetchMetadata,
  parseMetadataXml,
  getEntityType,
  runComplianceTests,
  generateMetadataReport,
} from '@reso-standards/reso-certification';
import type { ComplianceConfig } from '@reso-standards/reso-certification';

/** Auth args common to most tools. */
interface AuthArgs {
  readonly authToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
}

/** Resolve a bearer token from auth args. Supports both token and Client Credentials. */
const resolveAuthToken = async (args: AuthArgs): Promise<string> => {
  if (args.authToken) return args.authToken;

  if (args.clientId && args.clientSecret && args.tokenUrl) {
    return resolveToken({
      mode: 'client_credentials',
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      tokenUrl: args.tokenUrl,
    });
  }

  throw new Error('Authentication required. Provide authToken or clientId + clientSecret + tokenUrl.');
};

/** Build an AuthConfig for the certification SDK. */
const buildAuthConfig = (args: AuthArgs) => {
  if (args.authToken) return { mode: 'token' as const, authToken: args.authToken };
  if (args.clientId && args.clientSecret && args.tokenUrl) {
    return { mode: 'client_credentials' as const, clientId: args.clientId, clientSecret: args.clientSecret, tokenUrl: args.tokenUrl };
  }
  throw new Error('Authentication required.');
};

/** Tool handler result — matches MCP SDK's CallToolResult shape. */
interface HandlerResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const textResult = (data: unknown): HandlerResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string): HandlerResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

// ── Authenticate ──

export const handleAuthenticate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const { clientId, clientSecret, tokenUrl, scope } = args as {
    clientId: string; clientSecret: string; tokenUrl: string; scope?: string;
  };

  const token = await resolveToken({
    mode: 'client_credentials',
    clientId,
    clientSecret,
    tokenUrl,
    ...(scope ? { scope } : {}),
  });

  return textResult({ token, message: 'Token obtained. Use this token as authToken in subsequent tool calls.' });
};

// ── Query ──

export const handleQuery = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, resource, filter, select, orderby, top, skip, count, expand } = args as {
    url: string; resource: string;
    filter?: string; select?: string; orderby?: string;
    top?: number; skip?: number; count?: boolean; expand?: string;
  };

  const params = new URLSearchParams();
  if (filter) params.set('$filter', filter);
  if (select) params.set('$select', select);
  if (orderby) params.set('$orderby', orderby);
  if (top != null) params.set('$top', String(top));
  if (skip != null) params.set('$skip', String(skip));
  if (count) params.set('$count', 'true');
  if (expand) params.set('$expand', expand);

  const queryString = params.toString();
  const requestUrl = `${buildResourceUrl(url, resource)}${queryString ? `?${queryString}` : ''}`;

  const response = await odataRequest({ method: 'GET', url: requestUrl, authToken });

  if (response.status !== 200) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult(response.body);
};

// ── Write helpers ──

const writeOk = (status: number): boolean => status >= 200 && status < 300;

// ── Create ──

export const handleCreate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, resource, record } = args as {
    url: string; resource: string; record: Record<string, unknown>;
  };

  const requestUrl = buildResourceUrl(url, resource);
  const response = await odataRequest({ method: 'POST', url: requestUrl, body: record, authToken });

  if (!writeOk(response.status)) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult({ status: response.status, body: response.body });
};

// ── Update ──

export const handleUpdate = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, resource, key, record } = args as {
    url: string; resource: string; key: string; record: Record<string, unknown>;
  };

  const requestUrl = buildResourceUrl(url, resource, key);
  const response = await odataRequest({ method: 'PATCH', url: requestUrl, body: record, authToken });

  if (!writeOk(response.status)) {
    return errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`);
  }

  return textResult({ status: response.status, body: response.body });
};

// ── Delete ──

export const handleDelete = async (args: Record<string, unknown>): Promise<HandlerResult> => {
  const authToken = await resolveAuthToken(args as AuthArgs);
  const { url, resource, key } = args as { url: string; resource: string; key: string };

  const requestUrl = buildResourceUrl(url, resource, key);
  const response = await odataRequest({ method: 'DELETE', url: requestUrl, authToken });

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
    message: `Record has ${fieldCount} fields. Full DD validation requires server metadata — use the metadata tool first to fetch field definitions.`,
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
    endorsement: string; url: string;
    resource?: string; version?: string; mode?: string;
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
      errors: s.errors,
    })),
    progress: progressLog,
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
  'metadata-report': handleMetadataReport,
};
