# RESO MCP Server

MCP server that exposes RESO tools for AI agents. Query OData servers, parse metadata, validate records, run compliance tests – all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Works with any MCP client: Claude, Cursor, Windsurf, VS Code, or your own application.

> **New here?** The [User Guide](doc/GUIDE.md) is a dialogue-format walkthrough – every example is a real question to an AI assistant, the actual MCP tool call, and the live response from a seeded reference server. It covers auth, metadata exploration, querying, searching, and the full Add/Edit + EntityEvent loop including error handling.

## Install

This package is not on npm yet. Build from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-mcp-server
npm install      # preinstall hook builds sibling deps automatically
npm run build
```

The built binary lives at `reso-tools/reso-mcp-server/dist/index.js`. Note its absolute path – you will point your MCP client at it below.

## Quick Start

### Claude Code / Claude Desktop

Add to your MCP settings (`~/.claude/claude_desktop_config.json` or via `/mcp add`). Replace `/absolute/path/to/` with the directory where you cloned `reso-tools`:

```json
{
  "mcpServers": {
    "reso": {
      "command": "node",
      "args": ["/absolute/path/to/reso-tools/reso-mcp-server/dist/index.js"]
    }
  }
}
```

Certification tools only:

```json
{
  "mcpServers": {
    "reso-cert": {
      "command": "node",
      "args": ["/absolute/path/to/reso-tools/reso-mcp-server/dist/index.js", "--scope", "cert"]
    }
  }
}
```

### Other MCP Clients

The server uses stdio transport, so the configuration is the same `command` + `args` across all clients:

- [Cursor](https://docs.cursor.com/context/model-context-protocol) – Settings > MCP Servers
- [VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) – `.vscode/mcp.json`
- [Windsurf](https://docs.windsurf.com/windsurf/mcp) – MCP settings
- [JetBrains](https://www.jetbrains.com/help/idea/mcp-servers.html) – Settings > AI Assistant > MCP
- [Zed](https://zed.dev/docs/assistant/model-context-protocol) – Settings
- [Continue](https://docs.continue.dev/customize/model-providers/mcp), [Cline](https://github.com/cline/cline), [Amazon Q](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp.html), [Sourcegraph Cody](https://sourcegraph.com/docs/cody/clients/mcp)

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

Run RESO Certification compliance tests. Supports Add/Edit (RCP-010), EntityEvent (RCP-027), and Web API Core.

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
2. **Client Credentials**: Pass `clientId`, `clientSecret`, `tokenUrl` – the tool exchanges them for a token automatically

Or use the `authenticate` tool first to get a token, then pass it to subsequent calls.

## Development

From the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo:

```bash
cd reso-tools/reso-mcp-server
npm install    # preinstall builds sibling deps if their dist/ is missing
npm run build
npm run dev    # Watch mode
```

### Testing Locally

```bash
# Start the reference server
cd ../reso-reference-server && docker compose up -d

# Test the MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"url":"http://localhost:8080","resource":"Property","authToken":"admin-token","top":3}}}' | node dist/index.js
```

## Related

- [User Guide](doc/GUIDE.md) – dialogue-format walkthrough with live examples
- [`reso-certification/`](../reso-certification/) – CLI and SDK for compliance testing
- [`reso-client/`](../reso-client/) – OData client SDK
- [RESO Tools MCP Server ticket](https://github.com/RESOStandards/reso-tools/issues/91)

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
