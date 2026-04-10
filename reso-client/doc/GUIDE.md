# RESO Client SDK – User Guide

A task-oriented walkthrough of the RESO Client SDK. Each section is shaped around a real thing you might want to do – fetch a listing, page through a search, validate metadata, swap auth modes – and shows the smallest amount of code that makes it work.

The examples in this guide are the same ones in **[`reso-client/examples/`](https://github.com/RESOStandards/reso-tools/tree/main/reso-client/examples)**. Every snippet runs against the **[RESO Reference Server](../reso-reference-server/)** when seeded with the bundled fixtures, so you can paste anything from this page into a TypeScript file and it will work.

> **New here?** If you have never touched OData before, the short version is: it is a REST flavor where the URL itself describes the query. `GET /Property?$filter=ListPrice gt 200000&$top=10` is a complete, valid query – no body needed. The SDK gives you a typed builder so you do not hand-write those URLs, plus helpers for the things URLs cannot express: auth, paging, error handling and metadata parsing.

## Audience

Developers building applications that consume RESO-compliant OData servers – listing aggregators, agent tools, MLS dashboards, market analytics, data sync jobs and AI assistants. If you are calling a RESO Web API from TypeScript or JavaScript, this is your SDK.

## Install

```bash
npm install @reso-standards/reso-client
```

Requires Node.js 22 or later. Works in any ESM environment – no platform-specific dependencies.

---

## Connecting to a Server

The SDK is built around a `client` object you create once and reuse for the lifetime of your process. The client owns the base URL, authentication state and (for OAuth2) the token cache.

### Bearer Token (Simplest)

If you already have a token – from your IdP, your environment or a config file – pass it directly:

```typescript
import { createClient } from '@reso-standards/reso-client';

const client = await createClient({
  baseUrl: 'http://localhost:8080',
  auth: { mode: 'token', authToken: 'your-bearer-token' }
});
```

That is it. Every call from this client now sends `Authorization: Bearer your-bearer-token`.

### OAuth2 Client Credentials

For servers that issue short-lived tokens via the OAuth2 client credentials grant. The SDK fetches a token on first use, caches it, refreshes proactively at 90% of its TTL and retries once on a 401.

```typescript
const client = await createClient({
  baseUrl: 'https://api.example.com',
  auth: {
    mode: 'client_credentials',
    clientId: 'my-client-id',
    clientSecret: 'my-client-secret',
    tokenUrl: 'https://auth.example.com/oauth/token',
    scope: 'api'
  }
});
```

You write zero token-management code. If your server prefers HTTP Basic auth on the token endpoint instead of form parameters, set `credentialTransport: 'header'`. If it expects credentials in the query string, set `credentialTransport: 'query'`. Defaults to `'body'` because that is what most servers expect.

### Configuring from Environment Variables

Hardcoding credentials is a bad idea. The SDK ships with a helper that reads them from `process.env` – the same code path whether the user supplied a bearer token or client credentials:

```typescript
import { createClient, configFromEnv } from '@reso-standards/reso-client';

const client = await createClient(configFromEnv());
```

The helper looks for these variables, in this order:

| Variable | Meaning |
|---|---|
| `RESO_BASE_URL` | Server base URL – required |
| `RESO_CLIENT_ID` + `RESO_CLIENT_SECRET` + `RESO_TOKEN_URI` | Client credentials mode (preferred if all three set) |
| `RESO_AUTH_TOKEN` | Bearer token (used if client credentials environment variables are not set) |
| `RESO_SCOPE` | OAuth2 scope, optional |

Combined with Node 22's native `--env-file` flag, you get a complete config-from-file workflow with no extra dependencies:

```bash
# .env
RESO_BASE_URL=https://api.example.com
RESO_CLIENT_ID=my-client-id
RESO_CLIENT_SECRET=my-client-secret
RESO_TOKEN_URI=https://auth.example.com/oauth/token
RESO_SCOPE=api
```

```bash
node --env-file=.env your-script.js
```

---

## Reading Data

### Fetch a Single Record by Key

```typescript
import { readEntity, extractEntityData } from '@reso-standards/reso-client';

const response = await readEntity(client, 'Property', 'ABC123');

if (response.status === 200) {
  const property = extractEntityData(response.body);
  console.log(`${property.City} – $${property.ListPrice}`);
}
```

`extractEntityData` strips the `@odata.*` annotations off the response so you get a clean object with just the field values. If you need the annotations (e-tag, edit link, and so on) use `extractAnnotations` instead.

### Query with `$filter`, `$select`, `$orderby` and `$top`

The most common pattern. `queryEntities` takes the resource name and a typed object of OData system query options.

```typescript
import { queryEntities, isODataCollection } from '@reso-standards/reso-client';

const response = await queryEntities(client, 'Property', {
  $filter: "ListPrice gt 200000 and City eq 'Austin'",
  $select: 'ListPrice,City,BedroomsTotal',
  $orderby: 'ListPrice desc',
  $top: 10
});

if (response.status === 200 && isODataCollection(response.body)) {
  for (const property of response.body.value) {
    console.log(`  ${property.City} – $${property.ListPrice} – ${property.BedroomsTotal} BR`);
  }
}
```

`isODataCollection` is a type guard – after it returns true, TypeScript knows `response.body` has a `value: T[]` array.

### Build URLs Without Firing the Request

If you want the URL but not the call – for logging, deep links or debugging – use the chainable URI builder:

```typescript
import { buildUri } from '@reso-standards/reso-client';

const url = buildUri('http://localhost:8080', 'Property')
  .filter("ListPrice gt 200000")
  .select('ListPrice', 'City', 'BedroomsTotal')
  .orderby('ListPrice desc')
  .top(10)
  .build();

// → http://localhost:8080/Property?$filter=ListPrice%20gt%20200000&$select=ListPrice,City,BedroomsTotal&$orderby=ListPrice%20desc&$top=10
```

The builder supports every OData system query option: `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`, `$search`, `$compute` and `$format`. It also handles compound keys for resources whose primary key spans multiple fields:

```typescript
const url = buildUri('http://localhost:8080', 'OrderItem')
  .compoundKey({ OrderId: 'O1', ItemId: 'I1' })
  .build();

// → http://localhost:8080/OrderItem(OrderId='O1',ItemId='I1')
```

### Page Through a Large Result Set

Server-side paging in OData uses `@odata.nextLink`. The straightforward way is to read it yourself and build a loop. The SDK has a helper that does it for you:

```typescript
import { queryEntities, followAllPages } from '@reso-standards/reso-client';

const firstPage = await queryEntities(client, 'Property', {
  $filter: "City eq 'Austin'",
  $top: 100
});

const allProperties = await followAllPages(client, firstPage);
console.log(`Fetched ${allProperties.length} properties across all pages`);
```

`followAllPages` walks the `@odata.nextLink` chain until there is not one, performs no deduplication (the server is responsible for that) and returns a flat array. **Use it carefully** – for resources with millions of records, you almost certainly want streaming or batching instead. A 100,000-row listing dump is not the right use of this helper.

For incremental pulls, fetch one page at a time and check `getNextLink` yourself:

```typescript
import { getNextLink } from '@reso-standards/reso-client';

let response = await queryEntities(client, 'Property', { $top: 100 });
while (response.status === 200 && isODataCollection(response.body)) {
  for (const property of response.body.value) {
    await processProperty(property);
  }
  const next = getNextLink(response.body);
  if (!next) break;
  response = await client.request({ method: 'GET', url: next });
}
```

---

## Writing Data

The SDK exposes the four standard mutation verbs as helpers. Each one composes the URI builder, sets the right HTTP method and headers and parses the response.

### Create a Record

```typescript
import { createEntity, extractAnnotations } from '@reso-standards/reso-client';

const response = await createEntity(
  client,
  'Property',
  {
    ListPrice: 250000,
    City: 'Austin',
    BedroomsTotal: 3
  },
  { prefer: 'representation' }
);

if (response.status === 201) {
  const annotations = extractAnnotations(response.body);
  console.log('Created with key:', annotations.id);
}
```

The `prefer: 'representation'` option tells the server to return the created entity in the response body. Drop it (or pass `prefer: 'minimal'`) if you only need the status and you do not care about the post-create state.

### Update a Record (PATCH)

```typescript
import { updateEntity } from '@reso-standards/reso-client';

await updateEntity(
  client,
  'Property',
  'ABC123',
  { ListPrice: 275000 },
  { prefer: 'representation', ifMatch: '"e-tag-value"' }
);
```

The `ifMatch` option sends an `If-Match` header for optimistic concurrency control. Pass the e-tag you got from a prior read; the server returns 412 Precondition Failed if the record changed in between.

### Replace a Record (PUT)

```typescript
import { replaceEntity } from '@reso-standards/reso-client';

await replaceEntity(client, 'Property', 'ABC123', fullBody);
```

`replaceEntity` is the full-replacement verb – anything not in `fullBody` becomes null on the server. In practice you almost always want `updateEntity` instead.

### Delete a Record

```typescript
import { deleteEntity } from '@reso-standards/reso-client';

const response = await deleteEntity(client, 'Property', 'ABC123');
console.log('Delete status:', response.status); // 204 on success
```

---

## Working with Metadata

OData servers expose their schema at `/$metadata` as a CSDL (XML) document. The SDK parses it into typed JavaScript objects so you can introspect resources, fields, navigation properties, enum types and bound functions without touching XML.

### Fetch and Parse Server Metadata

```typescript
import { fetchAndParseMetadata, getEntityType } from '@reso-standards/reso-client';

const schema = await fetchAndParseMetadata('http://localhost:8080', 'your-token');

const propertyType = getEntityType(schema, 'Property');
console.log('Property has', propertyType?.properties.length, 'fields');

for (const field of propertyType?.properties ?? []) {
  console.log(`  ${field.name}: ${field.type}${field.nullable ? '?' : ''}`);
}
```

Parsed types you can work with: `CsdlEntityType`, `CsdlProperty`, `CsdlNavigationProperty`, `CsdlComplexType`, `CsdlEnumType`, `CsdlEntityContainer`, `CsdlEntitySet`, `CsdlSingleton`, `CsdlAction` and `CsdlFunction`. Use them to drive UI generators, build query validators or sanity-check that a server actually exposes the resources your code assumes.

### Validate Metadata Before Trusting It

```typescript
import { validateCsdl } from '@reso-standards/reso-client';

const result = validateCsdl(schema);
if (!result.valid) {
  for (const err of result.errors) {
    console.error(`${err.path}: ${err.message}`);
  }
}
```

Useful for compliance work and for verifying a server's metadata before relying on it in production. A schema that does not validate is worth investigating before round-tripping data through it.

### Validate Query Options Against the Schema

Catch typos and bad field references *before* sending the request:

```typescript
import { validateQueryOptions } from '@reso-standards/reso-client';

const result = validateQueryOptions(
  {
    $select: 'ListPrice,City,NonExistentField',
    $filter: "ListPrice gt 200000",
    $orderby: 'ListPrice desc',
    $top: 10
  },
  propertyType
);

if (!result.valid) {
  console.log('Invalid query options:', result.errors);
  // → [{ path: '$select', message: 'Field "NonExistentField" does not exist on Property' }]
}
```

This is what makes a server-aware client UI possible: parse the metadata once, validate the user's input against the entity type and surface field-level errors before any HTTP traffic.

---

## Handling Errors

OData errors have a structured shape. The SDK gives you a type guard and a parser so you do not have to write defensive checks everywhere.

```typescript
import { isODataError, parseODataError } from '@reso-standards/reso-client';

const response = await readEntity(client, 'Property', 'NONEXISTENT');

if (isODataError(response.body)) {
  const error = parseODataError(response);
  console.log('Code:', error.error.code);          // "ResourceNotFound"
  console.log('Message:', error.error.message);    // "Property with key 'NONEXISTENT' was not found"
  console.log('Target:', error.error.target);      // optional – the field/path the error points at
}
```

A common pattern is to centralize this in a small helper that turns OData errors into a result type your application understands:

```typescript
const tryRead = async (key: string) => {
  const response = await readEntity(client, 'Property', key);
  if (isODataError(response.body)) {
    const err = parseODataError(response);
    return { ok: false as const, error: err.error };
  }
  return { ok: true as const, data: extractEntityData(response.body) };
};
```

---

## Parsing OData Filter Expressions

The SDK re-exports `parseFilter` from **[`@reso-standards/odata-expression-parser`](../odata-expression-parser/)** so you do not need a second dependency to work with `$filter` strings as ASTs.

```typescript
import { parseFilter } from '@reso-standards/reso-client';

const ast = parseFilter("ListPrice gt 200000 and City eq 'Austin'");
// → typed AST you can walk, transform or pretty-print
```

This is what `validateQueryOptions` uses internally to check that filter property references are real. You can use it directly if you are building query UIs, translating between dialects or feeding `$filter` expressions to a query planner.

---

## Putting It All Together

A complete end-to-end script: connect with client credentials, query the reference server, page through results and handle errors properly.

```typescript
import {
  createClient,
  configFromEnv,
  queryEntities,
  followAllPages,
  isODataCollection,
  isODataError,
  parseODataError,
  extractEntityData
} from '@reso-standards/reso-client';

const main = async () => {
  const client = await createClient(configFromEnv());

  const firstPage = await queryEntities(client, 'Property', {
    $filter: "City eq 'Austin' and ListPrice gt 200000",
    $select: 'ListPrice,City,BedroomsTotal,ListingKey',
    $orderby: 'ListPrice desc',
    $top: 100
  });

  if (isODataError(firstPage.body)) {
    const err = parseODataError(firstPage);
    console.error('Query failed:', err.error.message);
    process.exit(1);
  }

  if (!isODataCollection(firstPage.body)) {
    console.error('Unexpected response shape');
    process.exit(1);
  }

  const allProperties = await followAllPages(client, firstPage);

  console.log(`Found ${allProperties.length} Austin properties over $200k:`);
  for (const property of allProperties) {
    const data = extractEntityData(property);
    console.log(`  ${data.ListingKey} – $${data.ListPrice} – ${data.BedroomsTotal} BR`);
  }
};

main().catch(console.error);
```

Save it as `query-austin.ts`, drop your credentials in a `.env` file and run:

```bash
node --env-file=.env npx tsx query-austin.ts
```

---

## Runnable Examples

Every snippet in this guide is also available as a complete, runnable example file:

| File | Section |
|---|---|
| **[fetch-property.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-client/examples/fetch-property.ts)** | Read a single record by key |
| **[query-with-filter.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-client/examples/query-with-filter.ts)** | Query with `$filter`, `$select`, `$orderby` and `$top` |
| **[create-and-update.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-client/examples/create-and-update.ts)** | Create a Property, update it, read it back |
| **[validate-metadata.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-client/examples/validate-metadata.ts)** | Fetch and validate CSDL metadata |
| **[oauth-flow.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-client/examples/oauth-flow.ts)** | OAuth2 Client Credentials flow |

To run them locally:

```bash
# Start the reference server first
cd reso-reference-server && docker compose up -d

# Run an example with bearer token
RESO_AUTH_TOKEN=test npx tsx reso-client/examples/query-with-filter.ts

# Or with client credentials via .env
node --env-file=.env npx tsx reso-client/examples/oauth-flow.ts
```

---

## Where to Next

* **Querying a server interactively** – the **[RESO Desktop Client](../reso-desktop-client/)** and **[RESO Web Client](../reso-web-client/)** use this SDK under the hood and give you a point-and-click UI for exploring any RESO server.
* **Validating records before send** – pair this guide with the **[reso-validation](../reso-validation/)** library to check field types and enums before round-tripping a record to the server.
* **Standing up a test server** – the **[RESO Reference Server](../reso-reference-server/)** is a full RESO-compliant OData server you can run locally with Docker or SQLite. Every example in this guide runs against it.
* **Running compliance tests** – once your server works with the SDK, the **[RESO Certification](../reso-certification/)** CLI runs the same tests RESO uses for official certification.

## Reference

* **[Package README](../)** – full API surface and type reference
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-client)**
* **[npm Package](https://www.npmjs.com/package/@reso-standards/reso-client)**
* **[OData 4.01 Part 1: Protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html)** – the underlying spec
