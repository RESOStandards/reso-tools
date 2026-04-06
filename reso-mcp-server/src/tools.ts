/**
 * MCP tool definitions for the RESO MCP server.
 *
 * Each tool wraps an SDK function from reso-client, reso-validation,
 * reso-certification, or odata-expression-parser.
 */

/** Tool scope for filtering. */
export type ToolScope = 'all' | 'cert';

/** Tool definition with metadata for registration. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly inputSchema: Record<string, unknown>;
}

// ── Auth Tools ──

export const authenticateTool: ToolDef = {
  name: 'authenticate',
  description: 'Obtain a bearer token using OAuth2 Client Credentials. Returns a token that can be used with all other tools. Tokens are cached and refreshed automatically.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'OAuth2 client ID' },
      clientSecret: { type: 'string', description: 'OAuth2 client secret' },
      tokenUrl: { type: 'string', description: 'OAuth2 token endpoint URL' },
      scope: { type: 'string', description: 'OAuth2 scope (optional)' },
    },
    required: ['clientId', 'clientSecret', 'tokenUrl'],
  },
};

// ── Query Tools ──

/** Shared auth properties for tool schemas. Either authToken or clientId+clientSecret+tokenUrl. */
const authProperties = {
  authToken: { type: 'string', description: 'Bearer token for authentication' },
  clientId: { type: 'string', description: 'OAuth2 client ID (alternative to authToken)' },
  clientSecret: { type: 'string', description: 'OAuth2 client secret' },
  tokenUrl: { type: 'string', description: 'OAuth2 token endpoint URL' },
};

export const queryTool: ToolDef = {
  name: 'query',
  description: 'Query a RESO OData server. Returns records from the specified resource with optional $filter, $select, $orderby, $top, $skip, and $count.',
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
      expand: { type: 'string', description: 'OData $expand expression for navigation properties' },
    },
    required: ['url', 'resource'],
  },
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
      resource: { type: 'string', description: 'Optional: return only this resource\'s entity type' },
    },
    required: ['url'],
  },
};

// ── Validation Tools ──

export const validateTool: ToolDef = {
  name: 'validate',
  description: 'Validate a record against RESO Data Dictionary field rules. Returns validation failures with field names, expected types, and error descriptions.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      record: { type: 'object', description: 'The record to validate (key-value pairs)' },
      resource: { type: 'string', description: 'Resource name (e.g., Property) for looking up field rules' },
      version: { type: 'string', description: 'DD version: "1.7" or "2.0"', default: '2.0' },
    },
    required: ['record', 'resource'],
  },
};

// ── Parser Tools ──

export const parseFilterTool: ToolDef = {
  name: 'parse-filter',
  description: 'Parse an OData $filter expression into an AST. Useful for understanding, validating, or transforming filter expressions.',
  scope: 'all',
  inputSchema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'OData $filter expression (e.g., "ListPrice gt 200000 and City eq \'Austin\'")' },
    },
    required: ['filter'],
  },
};

// ── Certification Tools ──

export const runComplianceTool: ToolDef = {
  name: 'run-compliance',
  description: 'Run RESO certification compliance tests against an OData server. Supports Add/Edit (RCP-010), EntityEvent (RCP-027), and Web API Core endorsements.',
  scope: 'cert',
  inputSchema: {
    type: 'object',
    properties: {
      endorsement: {
        type: 'string',
        enum: ['add-edit', 'entity-event', 'core'],
        description: 'Which endorsement to test',
      },
      url: { type: 'string', description: 'OData service root URL' },
      ...authProperties,
      resource: { type: 'string', description: 'Resource name (required for add-edit, optional for core)' },
      version: { type: 'string', description: 'Spec version (e.g., "2.0.0" for core)' },
      mode: { type: 'string', description: 'EntityEvent mode: "observe" or "full"' },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resources to test (core only, defaults to well-known list)',
      },
    },
    required: ['endorsement', 'url'],
  },
};

export const metadataReportTool: ToolDef = {
  name: 'metadata-report',
  description: 'Generate a RESO metadata compliance report from a server\'s $metadata. Checks entity types, fields, and annotations against the Data Dictionary.',
  scope: 'cert',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'OData service root URL' },
      ...authProperties,
    },
    required: ['url'],
  },
};

// ── All Tools ──

export const allTools: ReadonlyArray<ToolDef> = [
  authenticateTool,
  queryTool,
  metadataTool,
  validateTool,
  parseFilterTool,
  runComplianceTool,
  metadataReportTool,
];

/** Get tools filtered by scope. */
export const toolsForScope = (scope: 'all' | 'cert'): ReadonlyArray<ToolDef> =>
  scope === 'cert'
    ? allTools.filter(t => t.scope === 'cert')
    : allTools;
