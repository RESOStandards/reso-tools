# @reso-standards/reso-metadata-utils

RESO OData metadata processing utilities: CSDL parsing, validation, EDMX → metadata-report serialization, and live metadata fetching. This is the dependency-requiring side of the RESO metadata split ([reso-tools #221](https://github.com/RESOStandards/reso-tools)) — a sibling to [`@reso-standards/reso-common`](../reso-common/), which holds the zero-dependency metadata model and EDMX generation. Nothing here imports reso-common; the two are meant to be used together.

Its one runtime dependency is [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser).

## Install

```bash
npm install @reso-standards/reso-metadata-utils
```

Or work from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools && npm install
```

## What it does

Four capabilities, all exported from the package root.

### 1. Parse and inspect CSDL

Turn an OData 4.01 `$metadata` (CSDL/EDMX) document into a typed `CsdlSchema`, then walk it.

```typescript
import { parseCsdlXml, discoverResources, getFieldsForResource } from '@reso-standards/reso-metadata-utils';

const schema = parseCsdlXml(edmxXml);
const resources = discoverResources(schema);                    // ReadonlyArray<CsdlResourceInfo>
const propertyFields = getFieldsForResource(schema, 'Property'); // ReadonlyArray<FieldInfo>
```

| Export | Purpose |
|--------|---------|
| `parseCsdlXml(xml)` | CSDL/EDMX XML → typed `CsdlSchema` |
| `discoverResources(schema)` | Entity sets exposed as resources |
| `getEntityType` / `getEnumType` / `getComplexType` | Look up a named type |
| `getFieldsForResource(schema, name)` / `getFieldsForEntityType` / `getAllFields` | Field enumeration |

### 2. Validate CSDL

```typescript
import { validateCsdl } from '@reso-standards/reso-metadata-utils';

const result = validateCsdl(schema, '4.01'); // CsdlValidationResult; odataVersion defaults to '4.0'
if (!result.valid) console.error(result.errors);
```

XSD validation lands later under a Node-only subpath.

### 3. Serialize to a metadata report

Produce the canonical RESO `metadata-report.json` shape from EDMX XML or an already-parsed schema.

```typescript
import { generateMetadataReport, serializeMetadataReport } from '@reso-standards/reso-metadata-utils';

const report = generateMetadataReport(edmxXml, '2.1');  // MetadataReport — parse + serialize in one call
const report2 = serializeMetadataReport(schema, '2.1'); // MetadataReport — from a parsed CsdlSchema
```

### 4. Fetch metadata from a live server

```typescript
import { fetchAndParseMetadata, fetchRawMetadataWithVersion } from '@reso-standards/reso-metadata-utils';

const schema = await fetchAndParseMetadata(baseUrl, token);              // CsdlSchema
const { xml, version } = await fetchRawMetadataWithVersion(baseUrl, token);
```

| Export | Purpose |
|--------|---------|
| `fetchRawMetadata(baseUrl, token, opts?)` | Raw `$metadata` XML |
| `fetchRawMetadataWithVersion(baseUrl, token, opts?)` | XML plus the detected DD version |
| `fetchAndParseMetadata(baseUrl, token, opts?)` | Fetch and parse to `CsdlSchema` |

Fetch failures throw `MetadataFetchError`.

## Types

The package ships full TypeScript declarations: the `Csdl*` model (`CsdlSchema`, `CsdlEntityType`, `CsdlProperty`, `CsdlEnumType`, …), the `MetadataReport*` report shapes, and `FieldInfo` / `FieldAnnotation`.

## Development

```bash
npm install
npm run build
npm test
```

## License

See [LICENSE](./LICENSE) — the RESO End-user License Agreement.
