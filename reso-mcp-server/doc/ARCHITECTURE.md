# How the RESO MCP Server Works

The RESO MCP server wraps the same client SDK used for certification. As a result there's not much code required to make it work, but it allows users to search, input, and edit data using natural language with no knowledge of RESO, the Web API, or OData.

AI agents can read and write RESO data without managing credentials or being allowed to make their own HTTP requests. It leverages 
existing Web API authorization (OAuth 2.0), which has been proven in production.

> **Data Access Is Based on a User's Credentials**: if a user is authorized to read 100 IDX fields through the RESO Web API, their AI can only see those data elements, and can only access the data using standard authorization, queries, and API capabilities. What it can do with with that data once it's accessed depends on the data licensing agreement between the end user and data provider. It's up to end users to follow those terms. 

The [User Guide](GUIDE.md) covers using the server. This covers how it is built.

## Ten Tools
The RESO MCP server offers 10 tools.

| Tool | What it does | How |
|---|---|---|
| `authorize` | Confirms the configured credential works | `resolveToken` |
| `query` | Reads records from a resource | `queryEntities` |
| `create` | Adds a record | `createEntity` |
| `update` | Changes a record | `updateEntity` |
| `delete` | Removes a record | `deleteEntity` |
| `metadata` | Fetches and parses the server's schema | `fetchMetadata`, `parseMetadataXml` |
| `parse-filter` | Explains an OData `$filter` expression | `parseFilter` |
| `validate` | Validates a record according to a server's business rules | RESO Validation Expressions (Coming Soon) |
| `run-compliance` | Runs certification tests | `runComplianceTests` |
| `metadata-report` | Builds a metadata report | `generateMetadataReport` |

The last two are published only under `--scope cert`. The `scope` flag filters the advertised list at
startup, which is a pattern to follow if you want to extend the MCP server with your own tools. 

## Reading Data

`query` is a good place to start. It has three pieces that live in two different files.

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

Tool names, descriptions and schemas are sent to the client's AI, so they are public.

**The handler** lives in `handlers.ts`. It resolves a credential, turns arguments into OData query options, and hands the request to the SDK.

```ts
export const handleQuery = async (args) => {
  const { url, resource, filter, select, ... } = args;

  const client = await clientFor(url, args);   // resolves the credential, then binds a client to it

  const response = await queryEntities(client, resource, {
    ...(filter ? { $filter: filter } : {}),
    ...(select ? { $select: select } : {}),
    // ... five more of the same
  });

  return response.status !== 200
    ? errorResult(`Server returned HTTP ${response.status}: ${response.rawBody}`)
    : textResult(response.body);
};
```

That is the entire tool. There is no domain logic in it at all: it names the options and the SDK does the rest.

An earlier version of this handler assembled the query string itself, with a `URLSearchParams` and one `if` per option. It worked, and it was the one place this adapter duplicated something the SDK already did. `queryEntities` builds the same URI through the client's own builder, so the duplication is gone.

**What the SDK does that is not visible here:** builds a conformant resource URL, escapes what belongs escaped and omits what was not asked for, resolves a bearer token from whichever credential mode is configured, issues the request with correct OData headers, parses the response, and surfaces a typed error for a non-2xx. Each of those is a place a hand-rolled client gets OData subtly wrong.

## Writing Data

Writes are similar to reads but with a different verb, and each has its own SDK helper.

```ts
// create: no key, the record is the body
const response = await createEntity(client, resource, record);

// update: keyed, a partial record, and an optional etag
const response = await updateEntity(client, resource, key, record, ifMatch ? { ifMatch } : undefined);

// delete: keyed, no body
const response = await deleteEntity(client, resource, key, ifMatch ? { ifMatch } : undefined);
```

`update` uses `PATCH`, so it merges the fields supplied rather than replacing the record, and its
tool declaration carries `idempotentHint: true` on that basis.

`ifMatch` is the reason the writes go through these helpers rather than a raw request. Passing the
record's `@odata.etag` as it was last read turns a blind overwrite into a conditional one: if someone
edited the record in between, the server refuses instead of silently discarding their change. Without
it, an assistant editing a listing can lose a person's edit with nothing to show it happened. The
etag comes back on a single-record read, and omitting the argument is still allowed, for the case
where overwriting whatever is there is what you meant.

All three accept any 2xx, through one shared `writeOk` predicate, because a conformant server may
answer a write with `200`, `201` or `204` depending on whether it returns the record. A reader who
checks only for `200` will report successful writes as failures.

## Authorization and Security

It's important to keep credentials isolated from the rest of the system, including AI assistants. The MCP server
uses OAuth 2.0 to grant authorization through bearer tokens or client credentials (which resolve to bearer tokens). 
The server handles this behind the scenes so the user's AI cannot access sensitive information. 

Authorization determines what a user can access and do on an API, but it doesn't establish their identity, 
so end users should be careful to protect their credentials and treat them like passwords. Anyone who 
gets ahold of them has access. 

### AI Agents Don't Store Tokens and Don't Make Requests

Both matter, and they are enforced in different places.

The model cannot make its own request because there is nothing in this package that would let it. The
protocol layer in `index.ts` imports `McpServer`, `StdioServerTransport` and `zod`, and nothing about
real estate or HTTP. Every outbound call goes through the SDK's own client, which the handlers reach
only through `queryEntities`, `createEntity`, `updateEntity`, `deleteEntity` and `resolveToken`. A
tool call names a resource and a filter; it does not name a URL to fetch with headers of its
choosing.

The model never sees a token because no result contains one. `authorize` is the tool most likely
to leak one, and it does not: it performs the exchange and then reports the mode, the channel it came
from, and a label for the token endpoint. No credential, and not the token it just minted. A user
confirms the setup works without putting a secret in the conversation. The test suite asserts both
halves directly, in describe blocks named `authorize does not return a token` and `no credential
is required by any tool argument`.

### Credentials Live In The Environment

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

## What the Server Tells the AI

Tool schemas say what each tool accepts. Two other things say how to behave, and both are part of the
design rather than decoration.

**The register, declared once.** `src/instructions.ts` holds the server's MCP `instructions`, sent
once when a client connects. It names who is being talked to: someone who knows real estate and knows
their own data, and not necessarily more than that. It tells the AI to answer in the terms the person
used, and to keep field names, filters and query syntax out of an answer unless they ask how
something works. It forbids stating a number no query produced. And it says not to ask a person for a
token or put one in a tool call.

Sending it at connect time rather than putting it in each tool description matters: a description is
charged to every client on every call, and this is said once.

**When a search finds nothing.** A filtered query that matches nothing is the one result a person
cannot act on, and "no listings found" is the least useful honest answer. The criteria are joined
with `and`, so which one emptied the set is recoverable by counting again with each one removed. The
server tells the AI to do exactly that, report the breakdown, and ask whether to widen or change the
criteria, taking every number from a real query rather than estimating.

It offers this once per session, and again after three empty searches in a row, which is the signal
that someone is having a hard time finding things. Advice repeated on every miss stops being advice.

## The Five Files

Each has one job.

| File | Lines | Job | RESO imports |
|---|---|---|---|
| `src/index.ts` | 115 | MCP protocol wiring | **none** |
| `src/tools.ts` | 316 | tool schemas, declarations only | the credential *names* |
| `src/handlers.ts` | 641 | credential resolution and ten handlers | eleven symbols |
| `src/auth-env.ts` | 59 | the credential names, declared once | none |
| `src/instructions.ts` | 25 | what to tell the AI, declared once | none |

The borrowed surface is eleven symbols for ten tools, all but one of them static:

```ts
import {
  fetchMetadata, getEntityType, parseMetadataXml, runComplianceTests
} from '@reso-standards/reso-certification';
import type { AuthConfig, ComplianceConfig } from '@reso-standards/reso-certification';
import {
  createClient, createEntity, deleteEntity, queryEntities, resolveToken, updateEntity
} from '@reso-standards/reso-client';
import type { ODataClient } from '@reso-standards/reso-client';
import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
```

Plus `parseFilter`, loaded dynamically inside `handleParseFilter`. Roughly one SDK function per tool,
and nothing is reimplemented.

In `handlers.ts` the first handler starts at line 361, so the ten handlers share the last 280 lines
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
| `reso-certification` | 32,786 |
| **shared SDK total** | **40,738** |
| `reso-mcp-server` | **1,156** |

The adapter is 1,156 lines over the 40,738 it draws on, about 2.8%, and the dependency closure really
is all six packages: `reso-certification` pulls `reso-client`, `reso-common`, `reso-metadata-utils`
and `reso-validation`, and `reso-client` pulls `odata-expression-parser`.

The number only means something against the SDK a thing actually uses. `reso-reference-server` is
5,992 lines, but it imports three packages totalling 2,941 lines, so it is two lines of server for
every line of SDK rather than a thin layer over all of it. Counting it against the full 40,738 would
credit it with `reso-certification`'s 32,786 lines, which it never touches.

So the claim is the narrow one: a protocol adapter over a good SDK is almost all SDK. A full OData
server is not, and nothing here shows otherwise.
