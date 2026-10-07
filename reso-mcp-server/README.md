# RESO MCP Server

MCP server that exposes RESO tools for AI agents. Query OData servers, parse metadata, validate records, run compliance tests – all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Works with any MCP client: Claude, Cursor, Windsurf, VS Code or your own application.

> **New here?** The [User Guide](doc/GUIDE.md) is a dialogue-format walk-through – every example is a real question to an AI assistant, the actual MCP tool call and the live response from a seeded reference server. It covers auth, metadata exploration, querying, searching and the full Add/Edit + EntityEvent loop including error handling.

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

Check that the configured credentials work. Takes no arguments: it reads the server environment, and
for client credentials it performs the token exchange and then **discards the token**. Nothing is
returned to the caller and nothing is checked against a data server.

```
authenticate()
→ { mode, channel, tokenEndpoint }
```

It is a diagnostic rather than a prerequisite. Every other tool obtains its own token from the same
credentials on each call, so there is no need to call this first.

### query

Query a RESO OData server. Supports `$filter`, `$select`, `$orderby`, `$top`, `$skip`, `$count` and `$expand`.

```
query({ url, resource, filter?, select?, orderby?, top?, skip?, count?, expand? })
→ { value: [...records] }
```

**No tool takes a credential.** The server reads one from its own environment, so nothing sensitive travels inside a tool call. That is the point: an argument passed to a tool becomes part of the agent's conversation history and of any transcript of it, while a credential held by the server never appears in a message.

Put it in a `.env` beside the server and point Node at the file:

```jsonc
{
  "mcpServers": {
    "reso": {
      "command": "node",
      "args": ["--env-file=/absolute/path/to/reso-tools/reso-mcp-server/.env",
               "/absolute/path/to/reso-tools/reso-mcp-server/dist/index.js"]
    }
  }
}
```

```bash
# .env - gitignored, never committed
RESO_BASE_URL=https://api.example.com
RESO_AUTH_TOKEN=...
# or, for OAuth2 client credentials instead of a bearer token:
# RESO_CLIENT_ID=...
# RESO_CLIENT_SECRET=...
# RESO_TOKEN_URI=https://auth.example.com/oauth2/token
```

`RESO_BASE_URL` is **required** and is not a convenience. It names the one server the credential may be sent to, and a call targeting any other origin is refused. See [Authentication](doc/GUIDE.md#65-authentication) in the User Guide for why, and for what a mismatch reports.

### metadata

Fetch and parse OData `$metadata`. Returns entity types, fields, key properties and type information.

```
metadata({ url, resource? })
→ { namespace, entityTypes: [...] }
```

### validate

Validate a record against RESO Data Dictionary field rules.

```
validate({ record, resource, version? })
→ { failures: [...] }
```

### parse-filter

Parse an OData `$filter` expression into an AST. Useful for understanding, validating or transforming filter expressions.

```
parse-filter({ filter })
→ { type: "logical", operator: "and", left: {...}, right: {...} }
```

### run-compliance

Run RESO Certification compliance tests. Supports Add/Edit (RCP-010), EntityEvent (RCP-027) and Web API Core.

```
run-compliance({ endorsement, url, resource?, version?, mode?, resources? })
→ { status: "passed", steps: [...], duration: 450 }
```

### metadata-report

Generate a RESO metadata compliance report. Checks entity types, fields and annotations.

```
metadata-report({ url })
→ { serverUrl, entityTypes: 14, resources: [...] }
```

## Scope

The `--scope` flag limits which tools are available:

| Scope | Tools |
|-------|-------|
| `all` (default) | All tools |
| `cert` | `run-compliance`, `metadata-report` |

## Authentication

The server reads its credential from its own environment. Two modes, and a complete set of client
credentials wins over a bearer token:

| Mode | Variables |
|---|---|
| Bearer token | `RESO_AUTH_TOKEN` |
| OAuth2 client credentials | `RESO_CLIENT_ID`, `RESO_CLIENT_SECRET`, `RESO_TOKEN_URI`, optional `RESO_SCOPE` |

`RESO_BASE_URL` is required alongside either, and binds the credential to one server. See
[Install](#install) for the `--env-file` wiring and [Authentication](doc/GUIDE.md#65-authentication)
in the User Guide for the full rules.

Two behaviors worth knowing before you debug something:

- **A partial set is refused, never completed.** Supplying a client id and a token URI without a
  secret fails by name instead of quietly falling back to a bearer token or borrowing the missing
  field from somewhere else.
- **An environment credential is never sent to an unbound host.** A call targeting an origin other
  than `RESO_BASE_URL` is refused, and the refusal names both origins and no value.

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
# The reference server's mock IdP accepts any client id and secret.
cat > .env <<'ENV'
RESO_BASE_URL=http://localhost:8080
RESO_CLIENT_ID=test
RESO_CLIENT_SECRET=test
RESO_TOKEN_URI=http://localhost:8080/oauth/token
ENV

echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"url":"http://localhost:8080","resource":"Property","top":3}}}' | node --env-file=.env dist/index.js
```

## Related

- [User Guide](doc/GUIDE.md) – dialogue-format walk-through with live examples
- [`reso-certification/`](../reso-certification/) – CLI and SDK for compliance testing
- [`reso-client/`](../reso-client/) – OData client SDK
- [RESO Tools MCP Server ticket](https://github.com/RESOStandards/reso-tools/issues/91)

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
