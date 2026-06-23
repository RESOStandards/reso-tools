# @reso-standards/reso-common

Universal RESO metadata model and projections — the shared building blocks that the RESO certification tooling, the reference server and the browser clients all build on, so there is one source of truth for the RESO metadata shape instead of each tool carrying its own copy.

Zero runtime dependencies. The main entry point uses no Node or DOM APIs, so it runs unchanged in the browser and on the server.

## Install

```bash
npm install @reso-standards/reso-common
```

## What's inside

- **Metadata model** — the `ResoMetadata` shape (`ResoField`, `ResoLookup`, `ResoAnnotation`, …) describing resources, fields, lookups and annotations.
- **Pure helpers** — `isEnumType`, `getFieldsForResource`, `getLookupsForType`, `getKeyFieldForResource`.
- **EDMX generation** — `generateEdmx`, producing OData CSDL (EDMX) from a metadata report, in both the EnumType and the string / Lookup Resource representations.
- **Metadata map** — `buildMetadataMap`, projecting a metadata report into the nested `resource → field → entry` map used by the variations and validation passes.
- **Data Dictionary reference metadata** — the DD reference JSON for 1.7, 2.0 and 2.1, available via the `reference-metadata` subpath.

## Usage

```ts
import { generateEdmx, buildMetadataMap, getFieldsForResource } from '@reso-standards/reso-common';

const edmx = generateEdmx(metadataReport);
const { metadataMap } = buildMetadataMap(metadataReport);
const propertyFields = getFieldsForResource(metadataReport, 'Property');
```

Data Dictionary reference metadata is a deep import:

```ts
import dd21 from '@reso-standards/reso-common/reference-metadata/dd-2.1.json' with { type: 'json' };
```

## License

Real Estate Standards Organization End-user License Agreement (EULA). By using this package you agree to the RESO EULA: https://www.reso.org/eula/. See [LICENSE](./LICENSE).
