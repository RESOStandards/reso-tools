#!/usr/bin/env node

/**
 * RESO MCP Server — exposes RESO tools for AI agents via Model Context Protocol.
 *
 * Usage:
 *   reso-mcp                     # all tools
 *   reso-mcp --scope cert        # certification tools only
 *   reso-cert mcp                # alias for --scope cert
 */

/// <reference types="node" />

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toolsForScope, type ToolScope } from './tools.js';
import { handlers } from './handlers.js';

/** Parse CLI args for --scope flag. */
const parseScope = (): ToolScope => {
  const scopeIdx = process.argv.indexOf('--scope');
  if (scopeIdx !== -1 && process.argv[scopeIdx + 1]) {
    const scope = process.argv[scopeIdx + 1];
    if (scope === 'cert' || scope === 'all') return scope;
  }
  return 'all';
};

/** Convert a JSON Schema property definition to a Zod schema. */
const jsonPropToZod = (prop: Record<string, unknown>): z.ZodTypeAny => {
  switch (prop.type) {
    case 'string': return prop.enum
      ? z.enum(prop.enum as [string, ...string[]])
      : z.string().describe(String(prop.description ?? ''));
    case 'number': return z.number().describe(String(prop.description ?? ''));
    case 'boolean': return z.boolean().describe(String(prop.description ?? ''));
    case 'object': return z.record(z.unknown()).describe(String(prop.description ?? ''));
    case 'array': return z.array(z.string()).describe(String(prop.description ?? ''));
    default: return z.unknown();
  }
};

/** Convert a JSON Schema to a Zod raw shape for MCP SDK. */
const jsonSchemaToZodShape = (schema: Record<string, unknown>): Record<string, z.ZodTypeAny> => {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const zodType = jsonPropToZod(prop);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return shape;
};

const scope = parseScope();
const tools = toolsForScope(scope);

const server = new McpServer({
  name: 'reso-mcp-server',
  version: '0.7.0',
});

// Register each tool with its Zod schema
for (const tool of tools) {
  const zodShape = jsonSchemaToZodShape(tool.inputSchema);

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: zodShape,
    },
    async (args) => {
      const handler = handlers[tool.name];
      if (!handler) {
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${tool.name}` }],
          isError: true,
        };
      }

      try {
        return await handler(args as Record<string, unknown>);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
