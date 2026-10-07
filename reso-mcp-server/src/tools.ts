/**
 * MCP tool definitions for the RESO MCP server.
 *
 * Each tool wraps an SDK function from reso-client, reso-validation,
 * reso-certification, or odata-expression-parser.
 */

import {
  CLIENT_CREDENTIAL_ARG_NAMES,
  ENV_AUTH_TOKEN,
  ENV_BASE_URL,
  ENV_CLIENT_CREDENTIAL_NAMES,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  ENV_SCOPE,
  ENV_TOKEN_URI
} from './auth-env.js';

/** Tool scope for filtering. */
export type ToolScope = 'all' | 'cert';

/**
 * MCP ToolAnnotations — behavioral hints that compliant MCP hosts use to decide
 * how to present a tool to the user (e.g. show a confirmation prompt before
 * invoking destructive tools). Mirrors the shape from the MCP SDK.
 */
export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** Tool definition with metadata for registration. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
}

// ── Auth Tools ──

const ENV_CHANNEL = `${ENV_AUTH_TOKEN}, or ${ENV_CLIENT_CREDENTIAL_NAMES.join(' + ')}`;

/**
 * Appended to every credential property. Two jobs, and the second is why the wording is specific
 * about which server the environment serves.
 *
 * It steers an assistant away from asking a user to paste a secret into the conversation, because
 * the environment is the right place for one. But it must not steer an assistant into omitting a
 * credential for a server the environment is NOT configured for: the environment credential is
 * bound to {@link ENV_BASE_URL} and refused for any other host, so omitting it elsewhere produces a
 * refusal rather than a request. Saying "omit it when the environment is configured" without naming
 * the bound server would therefore be advice that fails.
 */
const PREFER_ENV_NOTE = `Optional. Omit it for the server named by ${ENV_BASE_URL}, whose credentials the MCP server process already holds in its environment (${ENV_CHANNEL}); the environment is the right place for a secret and a tool argument is visible in the conversation. The environment credential is sent ONLY to ${ENV_BASE_URL} and is refused for any other host, so to reach a different server pass its own credentials as arguments. Do not ask the user to paste a secret into the conversation.`;

const CLIENT_CREDENTIAL_SET_NOTE = `${CLIENT_CREDENTIAL_ARG_NAMES.join(', ')} travel together or not at all. A partial set is refused, never completed from the environment.`;

/** Shared auth properties for tool schemas. Either authToken, or the client-credentials set, or neither to use the environment. */
const authProperties = {
  authToken: { type: 'string', description: `Bearer token, overriding ${ENV_AUTH_TOKEN} for this one call. ${PREFER_ENV_NOTE}` },
  clientId: {
    type: 'string',
    description: `OAuth2 client ID, overriding ${ENV_CLIENT_ID} for this one call. ${CLIENT_CREDENTIAL_SET_NOTE} ${PREFER_ENV_NOTE}`
  },
  clientSecret: {
    type: 'string',
    description: `OAuth2 client secret, overriding ${ENV_CLIENT_SECRET} for this one call. ${CLIENT_CREDENTIAL_SET_NOTE} ${PREFER_ENV_NOTE}`
  },
  tokenUrl: {
    type: 'string',
    description: `OAuth2 token endpoint URL, overriding ${ENV_TOKEN_URI} for this one call. ${CLIENT_CREDENTIAL_SET_NOTE} ${PREFER_ENV_NOTE}`
  }
};

export const authorizeTool: ToolDef = {
  name: 'authorize',
  description: `Check that the server can authorize. With client credentials it requests a token from the token endpoint and discards it. The token is never returned, and no authorize step is needed before the other tools, because each of them obtains its own token from the same credentials on every call. Called with no arguments it checks ${ENV_CHANNEL} from the MCP server process environment, which is how a user confirms the setup works without putting a credential in the conversation.`,
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      ...authProperties,
      scope: { type: 'string', description: `OAuth2 scope, overriding ${ENV_SCOPE} for this one call. Optional.` }
    },
    required: []
  }
};

// ── Query Tools ──

export const queryTool: ToolDef = {
  name: 'query',
  description:
    'Query a RESO OData server. Returns records from the specified resource with optional $filter, $select, $orderby, $top, $skip, and $count.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL (e.g., https://api.example.com)' },
      resource: { type: 'string', description: 'Resource name (e.g., Property, Member, Office)' },
      ...authProperties,
      filter: { type: 'string', description: 'OData $filter expression (e.g., "ListPrice gt 200000")' },
      select: { type: 'string', description: 'Comma-separated field names for $select' },
      orderby: { type: 'string', description: 'OData $orderby expression (e.g., "ListPrice desc")' },
      top: { type: 'number', description: 'Maximum number of records to return' },
      skip: { type: 'number', description: 'Number of records to skip' },
      count: { type: 'boolean', description: 'Include @odata.count in response' },
      expand: { type: 'string', description: 'OData $expand expression for navigation properties' }
    },
    required: ['url', 'resource']
  }
};

export const metadataTool: ToolDef = {
  name: 'metadata',
  description: 'Fetch and parse OData $metadata from a RESO server. Returns entity types, fields, key properties, and type information.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      ...authProperties,
      resource: { type: 'string', description: "Optional: return only this resource's entity type" }
    },
    required: ['url']
  }
};

// ── Write Tools ──

export const createTool: ToolDef = {
  name: 'create',
  description:
    'Create a new record on a RESO OData resource via POST. Returns the server response (typically the created record or its location).',
  scope: 'all',
  annotations: {
    title: 'Create record',
    readOnlyHint: false,
    destructiveHint: false, // POST adds, doesn't destroy
    idempotentHint: false, // re-running creates duplicates
    openWorldHint: true // touches an external system
  },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      resource: { type: 'string', description: 'Resource name to create a record in (e.g., Property)' },
      ...authProperties,
      record: { type: 'object', description: 'Field/value pairs for the new record' }
    },
    required: ['url', 'resource', 'record']
  }
};

export const updateTool: ToolDef = {
  name: 'update',
  description: 'Update fields on an existing RESO OData record via PATCH. Returns the server response.',
  scope: 'all',
  annotations: {
    title: 'Update record',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true, // same PATCH twice yields the same result
    openWorldHint: true
  },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      resource: { type: 'string', description: 'Resource name (e.g., Property)' },
      key: { type: 'string', description: 'Key value of the record to update (e.g., the ListingKey)' },
      ...authProperties,
      record: { type: 'object', description: 'Field/value pairs to PATCH onto the record' },
      ifMatch: {
        type: 'string',
        description:
          "The record's @odata.etag as you last read it, so the change is refused rather than applied " +
          'if someone else edited the record in between. Omit only when overwriting whatever is there is ' +
          "intended. Use '*' to match any version."
      }
    },
    required: ['url', 'resource', 'key', 'record']
  }
};

export const deleteTool: ToolDef = {
  name: 'delete',
  description: 'Delete a RESO OData record via DELETE. Returns the server response (typically 204 No Content on success).',
  scope: 'all',
  annotations: {
    title: 'Delete record',
    readOnlyHint: false,
    destructiveHint: true, // ← the big one — hosts should require confirmation
    idempotentHint: true,
    openWorldHint: true
  },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      resource: { type: 'string', description: 'Resource name (e.g., Property)' },
      key: { type: 'string', description: 'Key value of the record to delete' },
      ...authProperties,
      ifMatch: {
        type: 'string',
        description:
          "The record's @odata.etag as you last read it, so the change is refused rather than applied " +
          'if someone else edited the record in between. Omit only when overwriting whatever is there is ' +
          "intended. Use '*' to match any version."
      }
    },
    required: ['url', 'resource', 'key']
  }
};

// ── Validation Tools ──

export const validateTool: ToolDef = {
  name: 'validate',
  description:
    'Validate a record against RESO Data Dictionary field rules. Returns validation failures with field names, expected types, and error descriptions.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      record: { type: 'object', description: 'The record to validate (key-value pairs)' },
      resource: { type: 'string', description: 'Resource name (e.g., Property) for looking up field rules' },
      version: { type: 'string', description: 'DD version: "1.7" or "2.0"', default: '2.0' }
    },
    required: ['record', 'resource']
  }
};

// ── Parser Tools ──

export const parseFilterTool: ToolDef = {
  name: 'parse-filter',
  description: 'Parse an OData $filter expression into an AST. Useful for understanding, validating, or transforming filter expressions.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'OData $filter expression (e.g., "ListPrice gt 200000 and City eq \'Austin\'")' }
    },
    required: ['filter']
  }
};

// ── Certification Tools ──

export const runComplianceTool: ToolDef = {
  name: 'run-compliance',
  description:
    'Run RESO certification compliance tests against an OData server. Supports Add/Edit (RCP-010), EntityEvent (RCP-027), and Web API Core endorsements.',
  scope: 'cert',
  inputSchema: {
    type: 'object',
    properties: {
      endorsement: {
        type: 'string',
        enum: ['add-edit', 'entity-event', 'core'],
        description: 'Which endorsement to test'
      },
      url: { type: 'string', description: 'OData service root URL' },
      ...authProperties,
      resource: { type: 'string', description: 'Resource name (required for add-edit, optional for core)' },
      version: { type: 'string', description: 'Spec version (e.g., "2.0.0" for core)' },
      mode: { type: 'string', description: 'EntityEvent mode: "observe" or "full"' },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resources to test (core only, defaults to well-known list)'
      }
    },
    required: ['endorsement', 'url']
  }
};

export const metadataReportTool: ToolDef = {
  name: 'metadata-report',
  description:
    "Generate a RESO metadata compliance report from a server's $metadata. Checks entity types, fields, and annotations against the Data Dictionary.",
  scope: 'cert',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      ...authProperties
    },
    required: ['url']
  }
};

// ── All Tools ──

export const allTools: ReadonlyArray<ToolDef> = [
  authorizeTool,
  queryTool,
  metadataTool,
  createTool,
  updateTool,
  deleteTool,
  validateTool,
  parseFilterTool,
  runComplianceTool,
  metadataReportTool
];

/** Get tools filtered by scope. */
export const toolsForScope = (scope: 'all' | 'cert'): ReadonlyArray<ToolDef> =>
  scope === 'cert' ? allTools.filter(t => t.scope === 'cert') : allTools;
