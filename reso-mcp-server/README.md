# RESO MCP Server

MCP server that exposes RESO tools for AI agents. Query OData servers, parse metadata, validate records, run compliance tests — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Works with any MCP client: Claude, Cursor, Windsurf, VS Code, or your own application.

## Quick Start

### Claude Code / Claude Desktop

Add to your MCP settings:

```json
{
  "mcpServers": {
    "reso": {
      "command": "npx",
      "args": ["@reso-standards/reso-mcp-server"]
    }
  }
}
```

Certification tools only:

```json
{
  "mcpServers": {
    "reso-cert": {
      "command": "npx",
      "args": ["@reso-standards/reso-mcp-server", "--scope", "cert"]
    }
  }
}
```

### Docker

```bash
docker build -t reso-mcp-server .
docker run -i reso-mcp-server
```

## Tools

### authenticate

Obtain a bearer token using OAuth2 Client Credentials. Returns a token for use with all other tools.

```
authenticate({ clientId, clientSecret, tokenUrl, scope? })
→ { token: "..." }
```

### query

Query a RESO OData server. Supports `$filter`, `$select`, `$orderby`, `$top`, `$skip`, `$count`, and `$expand`.

```
query({ url, resource, authToken, filter?, select?, orderby?, top?, skip?, count?, expand? })
→ { value: [...records] }
```

All tools accept either `authToken` (bearer token) or `clientId` + `clientSecret` + `tokenUrl` (OAuth2 Client Credentials).

### metadata

Fetch and parse OData `$metadata`. Returns entity types, fields, key properties, and type information.

```
metadata({ url, authToken, resource? })
→ { namespace, entityTypes: [...] }
```

### validate

Validate a record against RESO Data Dictionary field rules.

```
validate({ record, resource, version? })
→ { failures: [...] }
```

### parse-filter

Parse an OData `$filter` expression into an AST. Useful for understanding, validating, or transforming filter expressions.

```
parse-filter({ filter })
→ { type: "logical", operator: "and", left: {...}, right: {...} }
```

### run-compliance

Run RESO certification compliance tests. Supports Add/Edit (RCP-010), EntityEvent (RCP-027), and Web API Core.

```
run-compliance({ endorsement, url, authToken, resource?, version?, mode?, resources? })
→ { status: "passed", steps: [...], duration: 450 }
```

### metadata-report

Generate a RESO metadata compliance report. Checks entity types, fields, and annotations.

```
metadata-report({ url, authToken })
→ { serverUrl, entityTypes: 14, resources: [...] }
```

## Scope

The `--scope` flag limits which tools are available:

| Scope | Tools |
|-------|-------|
| `all` (default) | All tools |
| `cert` | `run-compliance`, `metadata-report` |

## Authentication

Tools accept authentication in two ways:

1. **Bearer token**: Pass `authToken` directly
2. **Client Credentials**: Pass `clientId`, `clientSecret`, `tokenUrl` — the tool exchanges them for a token automatically

Or use the `authenticate` tool first to get a token, then pass it to subsequent calls.

## Development

```bash
npm install
npm run build
npm run dev    # Watch mode
```

### Testing locally

```bash
# Start the reference server
cd ../reso-reference-server && docker compose up -d

# Test the MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"url":"http://localhost:8080","resource":"Property","authToken":"admin-token","top":3}}}' | node dist/index.js
```

## Related

- [`reso-certification/`](../reso-certification/) — CLI and SDK for compliance testing
- [`reso-client/`](../reso-client/) — OData client SDK
- [RESO Tools MCP Server ticket](https://github.com/RESOStandards/reso-tools/issues/91)

## License

See [LICENSE](../LICENSE) in the repository root.
