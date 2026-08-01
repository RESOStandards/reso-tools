import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { generateJsonSchema } = require(resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js'));

const {
  collectionFields,
  enumFieldsAndLookups,
  expansionFields,
  fieldsWithImplicitNullable,
  fieldsWithMaxLength,
  nonNullableField,
  nullableCollectionFields,
  simpleNonEnumFields,
} = require(resolve(import.meta.dirname, './fixtures/metadata-samples.cjs'));

const {
  collectionFieldsSchema,
  enumFieldsAndLookupsSchema,
  expansionFieldsSchema,
  nonNullableSchema,
  nullableCollectionFieldsSchema,
  schemaWithImplicitNullable,
  schemaWithMaxLength,
  simpleNonEnumSchema,
} = require(resolve(import.meta.dirname, './fixtures/schema-samples.cjs'));

describe('Schema generation tests', () => {
  it('Should generate valid schema for simple non enum fields', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: simpleNonEnumFields });
    expect(generatedSchema).toEqual(simpleNonEnumSchema);
  });

  it('Should generate valid schema for collection fields', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: collectionFields });
    expect(generatedSchema).toEqual(collectionFieldsSchema);
  });

  it('Should generate valid schema for enum fields and lookups', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: enumFieldsAndLookups });
    // PORT-NOTE: reso-tools recently changed generate.js enum handling; expected value ported as-is from old cert-utils so the maintainer can see the intended diff.
    expect(generatedSchema).toEqual(enumFieldsAndLookupsSchema);
  });

  it('Should generate valid schema for expansion fields', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: expansionFields });
    expect(generatedSchema).toEqual(expansionFieldsSchema);
  });

  it('Should generate valid schema for fields with implicit nullable', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: fieldsWithImplicitNullable });
    expect(generatedSchema).toEqual(schemaWithImplicitNullable);
  });

  it('Should generate valid schema for fields with max length', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: fieldsWithMaxLength });
    expect(generatedSchema).toEqual(schemaWithMaxLength);
  });

  it('Should generate valid schema for non-nullable field', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: nonNullableField });
    expect(generatedSchema).toEqual(nonNullableSchema);
  });

  it('Should generate valid schema for nullable collection fields', async () => {
    const generatedSchema = await generateJsonSchema({ metadataReportJson: nullableCollectionFields });
    expect(generatedSchema).toEqual(nullableCollectionFieldsSchema);
  });
});
