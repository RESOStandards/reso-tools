# RESO MCP Server

MCP server that exposes RESO tools for AI agents. Query OData servers, parse metadata, validate records, run compliance tests – all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Works with any MCP client: Claude, Cursor, Windsurf, VS Code or your own application.

> **New here?** The [User Guide](doc/GUIDE.md) walks through using the server from an AI assistant: setting up credentials, searching listings and the data attached to them, adding and editing records, and keeping another system in sync. Every number in it came from a real query against a seeded reference server, and each exchange carries the tool call and response in a collapsible block. The tool-call blocks elide the `url` argument, which every data tool requires, to keep the dialogue readable.

## Install

This package is **deliberately not published to npm**. It is a reference adapter meant to be read and cloned rather than installed as a dependency. See [Architecture](doc/ARCHITECTURE.md) for what it demonstrates. Build it from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools
npm install      # the whole workspace
npm run build    # every package in dependency order
```

Build from the repo root rather than from this directory. Each package resolves its siblings through
the `dist` their `package.json` points at, and a workspace symlink alone does not create that `dist`,
so a sibling has to be built before anything that imports it.

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
# From the repo root. The Dockerfile copies the root lockfile and every sibling it needs,
# so the build context has to be the repo rather than this directory.
docker build -t reso-mcp-server -f reso-mcp-server/Dockerfile .

docker run -i --rm --env-file ./reso-mcp-server/.env \
  --add-host=host.docker.internal:host-gateway reso-mcp-server
```

The `--env-file` is not optional. The image sets no credential defaults, so without it every data
call refuses with the authentication message above.

## Tools

### authorize

Check that the configured credentials work. Takes no arguments: it reads the server environment, and
for client credentials it performs the token exchange and then **discards the token**. Nothing is
returned to the caller and nothing is checked against a data server.

```
authorize()
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

**No tool requires a credential, and nothing in this documentation passes one.** The server reads one
from its own environment instead, so nothing sensitive travels inside a tool call. That matters because
an argument passed to a tool becomes part of the agent's conversation history and of every transcript
of it, while a credential the server holds never appears in a message.

Eight of the ten tools do still *accept* four optional credential properties, for a multi-tenant host
that has no single environment to read. Each one is documented in the schema as optional, with the
reason to omit it, and the schema tells a model not to ask anyone to paste a secret into the
conversation. No flow here uses them.

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

`RESO_BASE_URL` is **required** and is not a convenience. It names the one server the credential may be sent to, and a call targeting any other origin is refused. See [Architecture](doc/ARCHITECTURE.md) for why, and for what a mismatch reports.

### metadata

Fetch and parse OData `$metadata`. Returns entity types, fields, key properties and type information.

```
metadata({ url, resource? })
→ { namespace, entityTypes: [...] }
```

### validate

**Currently a stub.** It counts the fields it was given and returns a message saying so. It does not
compare anything against the Data Dictionary, and it never returns failures, so an empty result does
not mean a record is valid. Wiring it to `@reso-standards/reso-validation` is a follow-up.

```
validate({ record, resource })
→ { resource, fieldsProvided, message }
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
metadata-report({ url, version? })
→ { description, version, generatedOn, resources, fields, lookups, actions, functions }
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
[Install](#install) for the `--env-file` wiring and [Architecture](doc/ARCHITECTURE.md)
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
- [Architecture](doc/ARCHITECTURE.md) – how this server works, where the SDK boundary is, and why it is only 1,002 lines. Read this before building your own.
- [`reso-certification/`](../reso-certification/) – CLI and SDK for compliance testing
- [`reso-client/`](../reso-client/) – OData client SDK
- [RESO Tools MCP Server ticket](https://github.com/RESOStandards/reso-tools/issues/91)

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
