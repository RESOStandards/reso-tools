# How This Server Works, and Why It Is So Small

This package is a **reference adapter**. Its job is to put RESO's published SDK behind the Model
Context Protocol so an AI agent can use it, and the interesting thing about it is how little code
that takes. If you are here to build your own MCP server over RESO data, or to decide whether to,
this document is the shortest path to understanding what you would actually be writing.

The [User Guide](GUIDE.md) covers using the server. This covers how it is built.

## The Measurement

Counted as every `.ts`, `.js`, `.cjs` and `.mjs` file under each package's `src/`, excluding test
files. The basis matters: counting TypeScript alone gives a different total, because
`reso-certification` carries a substantial JavaScript `src/legacy` and `src/etl`.

| Package | Source lines |
|---|---|
| `reso-validation` | 435 |
| `reso-common` | 1,150 |
| `odata-expression-parser` | 1,356 |
| `reso-metadata-utils` | 1,979 |
| `reso-client` | 3,032 |
| `reso-certification` | 33,266 |
| **shared SDK total** | **41,218** |
| `reso-mcp-server` | **1,002** |

**This adapter is 1,002 lines over the 41,218 it draws on, about 2.4%.** Its dependency closure
really is all six packages: `reso-certification` pulls `reso-client`, `reso-common`,
`reso-metadata-utils` and `reso-validation`, and `reso-client` pulls `odata-expression-parser`.

A measurement only means something against the SDK a thing actually uses, which is worth saying
because the obvious comparison does not hold. `reso-reference-server` is 5,992 lines, but it declares
and imports only three packages, totalling 2,941 lines, so it is **two lines of server for every line
of SDK** rather than a thin layer over all of it. Counting it against the full 41,218 would credit it
with `reso-certification`'s 33,266 lines, which it never touches.

So the claim this document supports is the narrow one: **a protocol adapter over a good SDK is almost
all SDK.** A full OData server is not, and nothing here shows otherwise. There is still no proprietary
layer and nothing clever withheld, and the whole of this one is on this page.

## The Boundary

Four files, and each one has exactly one job.

| File | Lines | Job | RESO imports |
|---|---|---|---|
| `src/index.ts` | 111 | MCP protocol wiring | **none** |
| `src/tools.ts` | 302 | tool schemas, declarations only | the credential *names* |
| `src/handlers.ts` | 530 | credential resolution and ten handlers | ten symbols |
| `src/auth-env.ts` | 59 | the credential names, declared once | none |

`index.ts` imports `McpServer`, `StdioServerTransport` and `zod`, and nothing about real estate. The
protocol layer does not know what a listing is. That separation is why the same shape works for any
domain with a decent SDK.

The borrowed surface is **eleven symbols for ten tools**, ten of them imported statically:

```ts
import {
  buildResourceUrl, fetchMetadata, getEntityType,
  odataRequest, parseMetadataXml, runComplianceTests
} from '@reso-standards/reso-certification';
import type { AuthConfig, ComplianceConfig } from '@reso-standards/reso-certification';
import { resolveToken } from '@reso-standards/reso-client';
import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
```

Plus `parseFilter`, loaded dynamically inside `handleParseFilter`. Roughly one SDK function per tool,
and nothing is reimplemented.

## One Tool, End to End

`query` is representative. It is three pieces in two files.

**The declaration**, `tools.ts`. A name, a description and a JSON Schema. No behavior.

```ts
export const queryTool: ToolDef = {
  name: 'query',
  description: 'Query a RESO OData server. Returns records from the specified resource with ...',
  scope: 'all',
  inputSchema: { type: 'object', properties: { url, resource, filter, select, orderby, top, skip,
                 count, expand }, required: ['url', 'resource'] }
};
```

The snippet elides four optional credential properties that the real schema spreads in, which eight
of the ten tools carry. Each is documented there as optional, with the reason to omit it, and no flow
in this documentation fills one. They exist for a multi-tenant host with no single environment to
read. What matters for reading the handler below is that **nothing requires** a caller to supply a
credential.

**The handler**, `handlers.ts`. Resolve a credential, marshal arguments into OData query options,
hand the request to the SDK, return the body.

```ts
export const handleQuery = async (args) => {
  const authToken = await resolveAuthToken(args);        // credential resolution, below
  const { url, resource, filter, select, ... } = args;

  const params = new URLSearchParams();
  if (filter) params.set('$filter', filter);             // the whole "translation" layer
  if (select) params.set('$select', select);
  // ... five more of the same

  const requestUrl = `${buildResourceUrl(url, resource)}?${params}`;   // SDK
  const response = await odataRequest({ method: 'GET', url: requestUrl, authToken });  // SDK

  return response.status !== 200
    ? errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`)
    : textResult(response.body);
};
```

That is the entire tool. Thirty-four lines, a quarter of them just the argument type, and the only
domain logic is deciding that `filter` becomes `$filter`.

**What the SDK did that you do not see here:** built a conformant resource URL, resolved a bearer
token from whichever credential mode is configured, issued the request
with correct OData headers, parsed the response, and surfaced a typed error for a non-2xx. Every one
of those is somewhere a hand-rolled client gets OData subtly wrong.

The proportions hold across the file. `handlers.ts` is 530 lines and the first handler starts at line
280, so **the ten handlers share only the last 250 lines and everything above them is setup** -
imports, result helpers, and credential resolution, which is the bulk of it and the one part that is
genuinely this package's own work.

## The Part Worth Copying

If you take one thing from this package into your own, take the credential design rather than the
tool wiring.

**Credentials live in the server's environment, never in a tool call.** An argument passed to a tool
travels inside the call, so it becomes part of the agent's conversation history and of every
transcript, log and replay of it. A credential the server holds never appears in a message. That is
the whole reason `auth-env.ts` exists.

Four rules make it hold, and each one exists because the obvious implementation gets it wrong:

1. **Arguments win as a complete set.** If a call carries any credential argument, the environment is
   not consulted at all. No field is ever taken from one channel and combined with the other, because
   a credential assembled from two sources is a credential nobody chose.
2. **A partial set is refused, never completed.** A client id and a token URI without a secret fails
   by name. It does not fall back to a bearer token and it does not borrow the missing field.
3. **An environment credential is bound to one server.** `RESO_BASE_URL` is required, not optional.
   An environment credential is ambient, because no caller chose it for the call being made, and the
   target `url` is a free-form argument a model fills in. Unbound, it would be sent to whatever host
   a call happened to name. This is the rule most likely to be left out of a reimplementation and the
   one that matters most.
4. **No error message contains a credential value.** Every refusal names variable names and argument
   names. There is a test for it.

The executable specification for all four is `tests/auth-resolution.test.ts` – 592 lines, 48 tests,
each named for the failure it would allow if the control were removed. Two of its describe blocks
are worth reading even if you implement none of this:

- `the environment credential is bound to one server` – cross-host refusal, refusal *before* minting
  a token, origin matching across paths and trailing slashes, http-versus-https, differing ports,
  and an unparseable target.
- `the binding holds at the handler, not just the resolver` – that no request is sent, on more than
  one tool, **and that it still reaches the bound server**. A control that refuses everything is not
  a control, so the negative case is asserted too.

## Adapting This to Your Own Tools

The shape generalizes. To expose a different capability:

1. Add a `ToolDef` to `tools.ts`. Name, description and schema. Remember that **tool names,
   descriptions and schemas are sent to the client's model**, so they are part of your public
   surface, not internal labels.
2. Add a handler to `handlers.ts` that resolves a credential, marshals arguments and calls into
   whatever does the real work.
3. Register it in the `handlers` record and the `allTools` array.

If your capability is not OData, replace the SDK import and keep everything else. The protocol layer,
the credential resolution and the tool-registration pattern are all domain-agnostic.

`--scope` is the existing precedent for exposing a subset: `toolsForScope` filters `allTools` by a
launch flag, which is how `--scope cert` publishes only the certification tools. MCP also supports
`notifications/tools/list_changed`, so a server can change its advertised set while running. This one
does not, because it builds its list once at startup.

## What Is Deliberately Not Here

- **It is not published to npm**, by design. It is a worked example to read and clone, not a
  dependency to install.
- **`validate` is a stub.** It is not covered in the guide and will be wired to
  `@reso-standards/reso-validation` separately.
- **No RESO service credentials.** The server reads the `RESO_`-prefixed provider variables only. The
  unprefixed `CLIENT_ID` and `CLIENT_SECRET` that the `reso-cert` CLI also reads are credentials for
  RESO's own services, and a test asserts this server never reads an unprefixed variable.

## Reaching RESO's Member Services

Running this server locally does not cut you off from RESO's hosted tooling. A local instance can
reach RESO member services with the credentials you already hold, and the hosted server exposes tools
this one does not. That path is in beta: contact **dev@reso.org** for access.
