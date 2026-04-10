# RESO Client SDK

OData 4.01 client SDK for TypeScript. Provides URI building, CRUD helpers, CSDL metadata parsing and validation, query option validation, and response parsing.

> **[User Guide](doc/GUIDE.md)** – a task-oriented walkthrough with realistic examples.

## Install

```bash
npm install @reso-standards/reso-client
```

## Quick Start

```typescript
import {
  createClient,
  createEntity,
  readEntity,
  queryEntities,
  buildUri,
  isODataCollection,
} from "@reso-standards/reso-client";

// Create a client with OAuth2 Client Credentials
const client = await createClient({
  baseUrl: "http://localhost:8080",
  auth: {
    mode: "client_credentials",
    clientId: "my-client-id",
    clientSecret: "my-client-secret",
    tokenUrl: "https://auth.example.com/oauth/token",
    scope: "api",
  },
});

// Create a record
const created = await createEntity(client, "Property", {
  ListPrice: 250000,
  City: "Austin",
  BedroomsTotal: 3,
}, { prefer: "representation" });

// Read a record by key
const record = await readEntity(client, "Property", "ABC123");

// Query with $filter, $select, $orderby, $top
const response = await queryEntities(client, "Property", {
  $filter: "ListPrice gt 200000 and City eq 'Austin'",
  $select: "ListPrice,City,BedroomsTotal",
  $orderby: "ListPrice desc",
  $top: 10,
});

if (response.status === 200 && isODataCollection(response.body)) {
  console.log(`Found ${response.body.value.length} properties`);
}
```

## Features

### Authentication

The client supports two authentication modes.

#### OAuth2 Client Credentials

Tokens are managed automatically – fetched on first use, refreshed proactively at 90% of TTL, and retried once on 401 responses.

```typescript
const client = await createClient({
  baseUrl: "http://localhost:8080",
  auth: {
    mode: "client_credentials",
    clientId: "my-client-id",
    clientSecret: "my-client-secret",
    tokenUrl: "https://auth.example.com/oauth/token",
    scope: "api",                  // optional
    defaultExpiresIn: 3600,        // optional, default 1 hour
    credentialTransport: "body",   // optional: "body" (default), "header", "query"
  },
});
```

Credential transport options:
- **`body`** (default): Client ID and secret sent as form parameters
- **`header`**: Basic auth header (`Authorization: Basic base64(id:secret)`)
- **`query`**: Client ID and secret appended as URL query parameters

#### Bearer Token

For static tokens or when managing token lifecycle externally.

```typescript
const client = await createClient({
  baseUrl: "http://localhost:8080",
  auth: { mode: "token", authToken: "my-bearer-token" },
});
```

#### Environment Variables

Build auth configuration from environment variables – no code changes needed to switch between token and client credentials.

```typescript
import { authConfigFromEnv, configFromEnv } from "@reso-standards/reso-client";

// Auth config only
const auth = authConfigFromEnv();
const client = await createClient({ baseUrl: "http://localhost:8080", auth });

// Full config (base URL + auth)
const config = configFromEnv();
const client = await createClient(config);
```

| Variable | Description |
|----------|-------------|
| `RESO_BASE_URL` | Server base URL (required for `configFromEnv`) |
| `RESO_AUTH_TOKEN` | Bearer token (token mode) |
| `RESO_CLIENT_ID` | OAuth2 client ID (client credentials mode) |
| `RESO_CLIENT_SECRET` | OAuth2 client secret |
| `RESO_TOKEN_URI` | OAuth2 token endpoint URL |
| `RESO_SCOPE` | OAuth2 scope (optional) |
| `RESO_EXPIRES_IN` | Default token TTL in seconds (optional, default 3600) |

When `RESO_CLIENT_ID`, `RESO_CLIENT_SECRET` and `RESO_TOKEN_URI` are all set, client credentials mode is used. Otherwise falls back to `RESO_AUTH_TOKEN`.

**Using a `.env` file** (Node 22+):

```bash
# .env
RESO_BASE_URL=http://localhost:8080
RESO_CLIENT_ID=my-client-id
RESO_CLIENT_SECRET=my-client-secret
RESO_TOKEN_URI=https://auth.example.com/oauth/token
RESO_SCOPE=api
```

```bash
node --env-file=.env script.js
```

### URI Builder

Chainable functional API for constructing OData URLs with system query options.

```typescript
import { buildUri } from "@reso-standards/reso-client";

const url = buildUri("http://localhost:8080", "Property")
  .key("ABC123")
  .select("ListPrice", "City")
  .filter("ListPrice gt 200000")
  .expand("Media")
  .orderby("ListPrice desc")
  .top(10)
  .skip(20)
  .count()
  .build();

// Compound keys
const url2 = buildUri("http://localhost:8080", "OrderItem")
  .compoundKey({ OrderId: "O1", ItemId: "I1" })
  .build();
```

Supported query options: `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`, `$search`, `$compute`, `$format`.

### CRUD Helpers

High-level functions that compose the URI builder and HTTP client.

```typescript
import {
  createEntity,
  readEntity,
  updateEntity,
  replaceEntity,
  deleteEntity,
  queryEntities,
} from "@reso-standards/reso-client";

// POST /{Resource}
await createEntity(client, "Property", body, { prefer: "representation" });

// GET /{Resource}('{key}')
await readEntity(client, "Property", "ABC123");

// PATCH /{Resource}('{key}')
await updateEntity(client, "Property", "ABC123", patch, {
  prefer: "representation",
  ifMatch: '"etag-value"',
});

// PUT /{Resource}('{key}')
await replaceEntity(client, "Property", "ABC123", fullBody);

// DELETE /{Resource}('{key}')
await deleteEntity(client, "Property", "ABC123");

// GET /{Resource}?$filter=...&$top=...
await queryEntities(client, "Property", {
  $filter: "City eq 'Austin'",
  $top: 25,
});
```

### CSDL Metadata Parsing

Parse and validate EDMX/CSDL XML metadata documents.

```typescript
import {
  fetchAndParseMetadata,
  parseCsdlXml,
  validateCsdl,
  getEntityType,
} from "@reso-standards/reso-client";

// Fetch and parse from a server
const schema = await fetchAndParseMetadata("http://localhost:8080", "my-token");

// Or parse raw XML
const schema = parseCsdlXml(xmlString);

// Look up entity types
const propertyType = getEntityType(schema, "Property");

// Validate the schema
const result = validateCsdl(schema);
if (!result.valid) {
  console.log("Validation errors:", result.errors);
}
```

Parsed types include: `CsdlEntityType`, `CsdlProperty`, `CsdlNavigationProperty`, `CsdlComplexType`, `CsdlEnumType`, `CsdlEntityContainer`, `CsdlEntitySet`, `CsdlSingleton`, `CsdlAction`, `CsdlFunction`, and more.

### Query Validation

Validate query options against CSDL metadata to catch errors before sending requests.

```typescript
import { validateQueryOptions } from "@reso-standards/reso-client";

const result = validateQueryOptions(
  {
    $select: "ListPrice,City,NonExistentField",
    $filter: "ListPrice gt 200000",
    $orderby: "ListPrice desc",
    $top: 10,
  },
  entityType,
);

if (!result.valid) {
  console.log("Invalid query options:", result.errors);
}
```

Validates `$select` and `$orderby` field references against the entity type, `$filter` property references by walking the parsed AST (using `@reso-standards/odata-expression-parser`), and `$top`/`$skip` value constraints.

### Response Parsing

Extract annotations, detect errors, and handle paging.

```typescript
import {
  extractAnnotations,
  extractEntityData,
  isODataError,
  parseODataError,
  isODataCollection,
  getNextLink,
  followAllPages,
} from "@reso-standards/reso-client";

// Extract @odata annotations
const annotations = extractAnnotations(entity);
// → { context, id, editLink, etag }

// Strip annotations to get raw data
const data = extractEntityData(entity);

// Check for OData errors
if (isODataError(response.body)) {
  const error = parseODataError(response);
  console.log(error.error.message);
}

// Auto-page through all results
const allEntities = await followAllPages(client, firstResponse);
```

### Filter Parser (re-exported)

The `parseFilter` function and AST types from [`@reso-standards/odata-expression-parser`](../odata-expression-parser/) are re-exported for convenience.

```typescript
import { parseFilter } from "@reso-standards/reso-client";

const ast = parseFilter("ListPrice gt 200000 and City eq 'Austin'");
```

## Examples

Runnable examples are in the [examples/](examples/) directory. Each requires the reference server running at `http://localhost:8080`.

| Example | Description |
|---------|-------------|
| [fetch-property.ts](examples/fetch-property.ts) | Read a Property by key |
| [query-with-filter.ts](examples/query-with-filter.ts) | Query with `$filter`, `$select`, `$orderby`, `$top` |
| [create-and-update.ts](examples/create-and-update.ts) | Create a Property, update it, read it back |
| [validate-metadata.ts](examples/validate-metadata.ts) | Fetch and validate CSDL metadata |
| [oauth-flow.ts](examples/oauth-flow.ts) | OAuth2 Client Credentials flow |

```bash
# Start the reference server first
cd ../reso-reference-server && docker compose up -d

# Run an example with bearer token
RESO_AUTH_TOKEN=test npx tsx examples/query-with-filter.ts

# Run with client credentials via .env file
node --env-file=.env npx tsx examples/oauth-flow.ts
```

## Development

```bash
npm install
npm run build
npm test        # 118 tests
```

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
