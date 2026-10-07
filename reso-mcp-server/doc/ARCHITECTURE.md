# How This Server Works

This package puts RESO's published SDK behind the Model Context Protocol, so an AI agent can read
and write RESO data without being handed a credential or allowed to make its own HTTP requests.

Ten tools. Every one of them resolves a credential, hands the work to the SDK, and returns the
result. Nothing in this package speaks HTTP, mints a token, or builds an OData URL by hand.

The [User Guide](GUIDE.md) covers using the server. This covers how it is built, and is written for
someone deciding whether to build their own.

## The Ten Tools

| Tool | What it does | How |
|---|---|---|
| `authenticate` | Confirms the configured credential works | `resolveToken` |
| `query` | Reads records from a resource | `GET` via `odataRequest` |
| `create` | Adds a record | `POST` via `odataRequest` |
| `update` | Changes a record | `PATCH` via `odataRequest` |
| `delete` | Removes a record | `DELETE` via `odataRequest` |
| `metadata` | Fetches and parses the server's schema | `fetchMetadata`, `parseMetadataXml` |
| `parse-filter` | Explains an OData `$filter` expression | `parseFilter` |
| `validate` | Stub, not yet wired | not yet |
| `run-compliance` | Runs certification tests | `runComplianceTests` |
| `metadata-report` | Builds a metadata report | `generateMetadataReport` |

The last two are published only under `--scope cert`. The `scope` flag filters the advertised list at
startup, which is the pattern to copy if you want to expose a subset.

## Reading Data

`query` is the shape every tool follows. Three pieces, in two files.

**The declaration** lives in `tools.ts`: a name, a description and a JSON Schema. No behavior.

```ts
export const queryTool: ToolDef = {
  name: 'query',
  description: 'Query a RESO OData server. Returns records from the specified resource with ...',
  scope: 'all',
  inputSchema: { type: 'object', properties: { url, resource, filter, select, orderby, top, skip,
                 count, expand }, required: ['url', 'resource'] }
};
```

Tool names, descriptions and schemas are sent to the client's model, so they are a public surface,
not internal labels.

**The handler** lives in `handlers.ts`. It resolves a credential, turns arguments into OData query
options, and hands the request to the SDK.

```ts
export const handleQuery = async (args) => {
  const authToken = await resolveAuthToken(args);        // credential resolution, below
  const { url, resource, filter, select, ... } = args;

  const params = new URLSearchParams();
  if (filter) params.set('$filter', filter);             // the whole translation layer
  if (select) params.set('$select', select);
  // ... five more of the same

  const requestUrl = `${buildResourceUrl(url, resource)}?${params}`;                 // SDK
  const response = await odataRequest({ method: 'GET', url: requestUrl, authToken }); // SDK

  return response.status !== 200
    ? errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`)
    : textResult(response.body);
};
```

That is the entire tool, and the only domain logic in it is deciding that `filter` becomes `$filter`.

**What the SDK did that is not visible here:** built a conformant resource URL, resolved a bearer
token from whichever credential mode is configured, issued the request with correct OData headers,
parsed the response, and surfaced a typed error for a non-2xx. Each of those is a place a
hand-rolled client gets OData subtly wrong.

## Writing Data

Writes are the same shape with a different verb. `buildResourceUrl` takes an optional key, which is
the only structural difference between adding a record and changing one.

```ts
// create: no key, the record is the body
const requestUrl = buildResourceUrl(url, resource);
const response = await odataRequest({ method: 'POST', url: requestUrl, body: record, authToken });

// update: keyed, and a partial record
const requestUrl = buildResourceUrl(url, resource, key);
const response = await odataRequest({ method: 'PATCH', url: requestUrl, body: record, authToken });

// delete: keyed, no body
const requestUrl = buildResourceUrl(url, resource, key);
const response = await odataRequest({ method: 'DELETE', url: requestUrl, authToken });
```

`update` uses `PATCH`, so it merges the fields supplied rather than replacing the record, and its
tool declaration carries `idempotentHint: true` on that basis.

All three accept any 2xx, through one shared `writeOk` predicate, because a conformant server may
answer a write with `200`, `201` or `204` depending on whether it returns the record. A reader who
checks only for `200` will report successful writes as failures.

## Authorization and Security

This section is the part worth copying, and it is worth being exact about what it is.

It is **authorization, not authentication.** The server does not establish who a user is and has no
sign-in flow. It proves that it is a client the data provider has authorized, and it does that on
behalf of whoever configured it.

It is **OAuth2, not OIDC.** The RESO Web API authorizes with the OAuth2 client-credentials grant: a
client id and secret are exchanged at a token endpoint for a bearer token. There is no identity
layer, no ID token and no user. If you are reaching for an OIDC library here, you are solving a
different problem.

### The AI never holds a token, and never makes a request

Both halves matter, and they are enforced in different places.

The model cannot make its own request because there is nothing in this package that would let it. The
protocol layer in `index.ts` imports `McpServer`, `StdioServerTransport` and `zod`, and nothing about
real estate or HTTP. Every outbound call goes through `odataRequest` and `resolveToken` in the SDK.
A tool call names a resource and a filter; it does not name a URL to fetch with headers of its
choosing.

The model never sees a token because no result contains one. `authenticate` is the tool most likely
to leak one, and it does not: it performs the exchange and then reports the mode, the channel it came
from, and a label for the token endpoint. No credential, and not the token it just minted. A user
confirms the setup works without putting a secret in the conversation. The test suite asserts both
halves directly, in describe blocks named `authenticate does not return a token` and `no credential
is required by any tool argument`.

### Credentials live in the environment, never in a tool call

An argument passed to a tool travels inside the call, which makes it part of the agent's conversation
history and of every transcript, log and replay of that conversation. A credential the server holds
in its own environment never appears in a message at all. That is why `auth-env.ts` exists: it
declares the five environment names in one place, and both the reader and the tool-schema
descriptions import them, so a schema cannot come to describe a variable the reader does not read.

Eight of the ten tools do accept optional credential arguments, for a multi-tenant host with no
single environment to read. None of them require one, and no flow in this documentation fills one.

### Four rules

Each exists because the obvious implementation gets it wrong.

1. **Arguments win as a complete set.** If a call carries any credential argument, the environment is
   not consulted at all. No field is ever taken from one channel and combined with the other, because
   a credential assembled from two sources is a credential nobody chose.
2. **A partial set is refused, never completed.** A client id and a token URI without a secret fails
   by name. It does not fall back to a bearer token and it does not borrow the missing field.
3. **An environment credential is bound to one server.** `RESO_BASE_URL` is required, not optional.
   An environment credential is ambient, since no caller chose it for the call being made, and the
   target `url` is a free-form argument a model fills in. Unbound, it would be sent to whatever host
   a call happened to name. This is the rule most likely to be left out of a reimplementation and the
   one that matters most.
4. **No error message contains a credential value.** Every refusal names variable names and argument
   names. There is a test for it.

The executable specification is `tests/auth-resolution.test.ts`: 592 lines, 48 tests, each named for
the failure it would allow if the control were removed. Two describe blocks are worth reading even if
you implement none of the rest:

- `the environment credential is bound to one server` covers cross-host refusal, refusal *before*
  minting a token, origin matching across paths and trailing slashes, http against https, differing
  ports, and an unparseable target.
- `the binding holds at the handler, not just the resolver` asserts that no request is sent, on more
  than one tool, **and that a request to the bound server still succeeds**. A control that refuses
  everything is not a control, so the negative case is asserted too.

## The Four Files

Each has one job.

| File | Lines | Job | RESO imports |
|---|---|---|---|
| `src/index.ts` | 111 | MCP protocol wiring | **none** |
| `src/tools.ts` | 302 | tool schemas, declarations only | the credential *names* |
| `src/handlers.ts` | 530 | credential resolution and ten handlers | ten symbols |
| `src/auth-env.ts` | 59 | the credential names, declared once | none |

The borrowed surface is eleven symbols for ten tools, ten of them static:

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

In `handlers.ts` the first handler starts at line 280, so the ten handlers share the last 250 lines
and everything above them is imports, result helpers and credential resolution. Credential
resolution is the bulk of it, and the one part that is genuinely this package's own work.

## Adapting This to Your Own Tools

1. Add a `ToolDef` to `tools.ts`: name, description, schema.
2. Add a handler to `handlers.ts` that resolves a credential, marshals arguments and calls into
   whatever does the real work.
3. Register it in the `handlers` record and the `allTools` array.

If your capability is not OData, replace the SDK import and keep everything else. The protocol layer,
the credential resolution and the tool-registration pattern are all domain-agnostic.

MCP also supports `notifications/tools/list_changed`, so a server can change its advertised set while
running. This one does not, because it builds its list once at startup.

## What Is Deliberately Not Here

- **It is not published to npm**, by design. It is a worked example to read and clone, not a
  dependency to install.
- **`validate` is a stub.** It is not covered in the guide and will be wired to
  `@reso-standards/reso-validation` separately.
- **No RESO service credentials.** This server reads the `RESO_`-prefixed provider variables only.
  The unprefixed `CLIENT_ID` and `CLIENT_SECRET` that the `reso-cert` CLI also reads are credentials
  for RESO's own services, and a test asserts this server never reads an unprefixed variable.

## Reaching RESO's Member Services

Running this server locally does not cut you off from RESO's hosted tooling. A local instance can
reach RESO member services with the credentials you already hold, and the hosted server exposes tools
this one does not. That path is in beta: contact **dev@reso.org** for access.

## Appendix: How Little Code This Is

Counted as every `.ts`, `.js`, `.cjs` and `.mjs` file under each package's `src/`, excluding test
files.

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

The adapter is 1,002 lines over the 41,218 it draws on, about 2.4%, and the dependency closure really
is all six packages: `reso-certification` pulls `reso-client`, `reso-common`, `reso-metadata-utils`
and `reso-validation`, and `reso-client` pulls `odata-expression-parser`.

The number only means something against the SDK a thing actually uses. `reso-reference-server` is
5,992 lines, but it imports three packages totalling 2,941 lines, so it is two lines of server for
every line of SDK rather than a thin layer over all of it. Counting it against the full 41,218 would
credit it with `reso-certification`'s 33,266 lines, which it never touches.

So the claim is the narrow one: a protocol adapter over a good SDK is almost all SDK. A full OData
server is not, and nothing here shows otherwise.
