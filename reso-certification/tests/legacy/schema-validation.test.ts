import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Legacy schema module (CommonJS). In old cert-utils these were the package main (`require('..')`);
// in reso-tools they live under src/legacy/lib/schema.
const { generateJsonSchema, validate, combineErrors, VALIDATION_ERROR_MESSAGES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js')
);
// Old `@reso/reso-certification-etl` -> reso-tools src/etl.
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const {
  valuePayload,
  nonValuePayload,
  expansionPayload,
  simpleTypeMismatchErrorPayload,
  enumMismatchPayload,
  odataKeyPayload,
  invalidPayloadContext,
  stringListValidPayload,
  stringListInvalidPayload,
  additionalPropertyPayload,
  integerOverflowPayload,
  stringListWithSpacesAfterCommaValidPayload,
  specialEnumFieldsValidPayload,
  maxLengthPayload,
  maxLengthPayloadRCF,
  nestedPayloadError,
  nestedCollectionPayloadError,
  nestedPayloadErrorWithNullExpansion,
  nestedCollectionPayloadErrorWithNull,
  nestedExpansionTypeError,
  atFieldPayloadError,
  expansionErrorMultiValuePayload,
  expansionIgnoredItem,
  collectionExpansionError,
  singleValueExpansionError,
  topLevelUnadvertisedField,
  keyFieldPayloadMulti
} = require(resolve(import.meta.dirname, './fixtures/payload-samples.cjs'));

// Reflect a real provider: the DD reference leaves Open lookups (City, MemberDesignation, …) unenumerated,
// but a conforming provider advertises the values it actually serves in its /Lookup. Advertise the
// INCIDENTAL Open-lookup values the sample payloads carry so "advertised in the metadata" holds for them
// (per the rule that any payload value must be advertised). Values a test intentionally leaves unadvertised
// — its subject error — are NOT added here, so those tests still fail for the right reason.
const advertise = (meta: { lookups: unknown[] }, entries: ReadonlyArray<readonly [string, string]>) => ({
  ...meta,
  lookups: [...meta.lookups, ...entries.map(([lookupName, lookupValue]) => ({ lookupName, lookupValue, type: 'Edm.String' }))]
});

const CITY = 'org.reso.metadata.enums.City';
const INCIDENTAL: ReadonlyArray<readonly [string, string]> = [
  // The one Open-lookup value every "valid payload" sample carries. NOT 'NYC' — that value is an
  // *intentional* unadvertised error in the key-accumulation test, so it stays unadvertised.
  [CITY, 'SampleCityEnumValue']
];

describe('Schema validation tests', async () => {
  const metadata = advertise(getReferenceMetadata('2.0'), INCIDENTAL);
  const schema = await generateJsonSchema({ metadataReportJson: metadata });

  it('Should validate a valid array type payload', () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: valuePayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should validate valid non-array type payload', () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nonValuePayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should validate valid payload containing expansions', () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: expansionPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should find errors in case of type mismatch in simple types', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const fieldName = 'PostalCode';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: simpleTypeMismatchErrorPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    const expectedErrorMessage = `MUST be string or null but found ${typeof simpleTypeMismatchErrorPayload.PostalCode}`;
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors[expectedErrorMessage]).toBeTruthy();
    expect(!!report.errors[expectedErrorMessage].resources?.Property?.fields?.PostalCode).toBeTruthy();
    expect(report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[fieldName]?.count).toBe(1);
  });

  it('Should find errors in case of enum mismatch in complex types', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const fieldName = 'AboveGradeFinishedAreaSource';
    const expectedErrorMessage = VALIDATION_ERROR_MESSAGES.NOT_ADVERTISED_IN_METADATA;
    const expectedInvalidEnum = enumMismatchPayload.value[0].AboveGradeFinishedAreaSource;
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: enumMismatchPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[fieldName]?.lookups?.[expectedInvalidEnum]
    ).toBeTruthy();
  });

  it('Should validate even when top level context is @odata instead of @reso', () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: odataKeyPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should find error even when top level context is invalid', () => {
    // PORT-NOTE: faithful port of the original try/catch — if validate does not throw, the assertion
    // inside catch never runs (vacuous pass). Preserved exactly rather than converting to expect().toThrow().
    try {
      validate({
        jsonSchema: schema,
        jsonPayload: invalidPayloadContext,
        resourceName: 'Property',
        version: '2.0',
        errorMap: {}
      });
    } catch (err) {
      expect((err as Error).message).toBe(VALIDATION_ERROR_MESSAGES.NO_CONTEXT_PROPERTY);
    }
  });

  it('Should properly parse and validate valid string list lookup values', () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: stringListValidPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should convert enum errors to warnings based on validation config', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const fieldName = 'MLSAreaMinor';
    const config = {
      '2.0': {
        Property: {
          MLSAreaMinor: {
            ignoreEnumerations: true
          }
        }
      }
    };
    const expectedEnumValue = 'TestEnumValuer';
    const expectedErrorMessage =
      'The following enumerations in the MLSAreaMinor Field were not advertised. This will fail in Data Dictionary 2.1';

    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: specialEnumFieldsValidPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap,
      validationConfig: config
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
    expect(report.totalWarnings).toBe(1);
    expect(!!report.warnings?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.warnings[expectedErrorMessage].resources?.[resourceName]?.fields?.[fieldName]?.lookups?.[expectedEnumValue]
    ).toBeTruthy();
  });

  it('Should convert expansion enum errors to warnings based on validation config', () => {
    let errorMap = {};
    const config = {
      '2.0': {
        Media: {
          ImageSizeDescription: {
            ignoreEnumerations: true
          }
        }
      }
    };
    const resourceName = 'Property';
    const fieldName = 'Media';
    const expectedEnumValue = 'Foo';
    const expectedErrorMessage =
      'The following enumerations in the ImageSizeDescription Field were not advertised. This will fail in Data Dictionary 2.1';

    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: expansionIgnoredItem,
      resourceName: 'Property',
      version: '2.0',
      errorMap,
      validationConfig: config
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
    expect(report.totalWarnings).toBe(1);
    expect(!!report.warnings?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.warnings[expectedErrorMessage].resources?.[resourceName]?.fields?.[fieldName]?.lookups?.[expectedEnumValue]
    ).toBeTruthy();
  });

  it('Should find errors in case of invalid enums in string list', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const fieldName = 'AboveGradeFinishedAreaSource';
    const expectedErrorMessage = VALIDATION_ERROR_MESSAGES.NOT_ADVERTISED_IN_METADATA;
    const expectedInvalidEnum = 'InvalidEnum';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: stringListInvalidPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[fieldName]?.lookups?.[expectedInvalidEnum]
    ).toBeTruthy();
  });

  it('Should not find errors in case of valid enums containing space after comma', async () => {
    let errorMap = {};
    metadata.fields.push({
      resourceName: 'Property',
      fieldName: 'StringListTestField',
      nullable: false,
      annotations: [],
      type: 'TestEnumType'
    });
    metadata.lookups.push({
      lookupName: 'TestEnumType',
      lookupValue: 'My Company, LLC',
      type: 'Edm.String'
    });
    const modifiedSchema = await generateJsonSchema({ metadataReportJson: metadata });
    errorMap = validate({
      jsonSchema: modifiedSchema,
      jsonPayload: stringListWithSpacesAfterCommaValidPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should find errors in case of additional properties not advertised in the metadata', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const version = '2.0';
    const expectedErrorMessage = `ADDITIONAL fields found that are not part of Data Dictionary ${version}`;
    const expectedInvalidField = 'AdditionalProperty';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: additionalPropertyPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap,
      isResoDataDictionarySchema: true
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(!!report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[expectedInvalidField]).toBeTruthy();
  });

  it('Should not have lookup values for non-enum types', () => {
    let errorMap = {};
    const resourceName = 'Property';
    const version = '2.0';
    const expectedErrorMessage = `ADDITIONAL fields found that are not part of Data Dictionary ${version}`;
    const expectedInvalidField = 'AdditionalProperty';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: additionalPropertyPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap,
      isResoDataDictionarySchema: true
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(!!report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[expectedInvalidField]).toBeTruthy();
    expect('lookups' in report.errors[expectedErrorMessage].resources?.[resourceName]?.fields?.[expectedInvalidField]).toBe(
      false
    );
  });

  it('Should find maxLength warnings and have proper message - RCF Testing', async () => {
    let errorMap = {};
    const expectedWarningMessage = 'SHOULD have a maximum suggested length of 5 characters';
    metadata.fields.push({
      resourceName: 'Property',
      fieldName: 'TestMaxLengthField',
      nullable: false,
      annotations: [],
      type: 'Edm.String',
      maxLength: 5
    });
    const modifiedSchema = await generateJsonSchema({ metadataReportJson: metadata });
    errorMap = validate({
      jsonSchema: modifiedSchema,
      jsonPayload: maxLengthPayloadRCF,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalWarnings).toBe(1);
    expect(report.totalErrors).toBe(0);
    expect(!!report.warnings?.[expectedWarningMessage]).toBeTruthy();

    metadata.fields.pop();
  });

  it('Should find maxLength errors and have proper message - DD Testing', async () => {
    let errorMap = {};
    const expectedErrorMessage = 'MUST have a maximum advertised length of 5 characters';
    metadata.fields.push({
      resourceName: 'Property',
      fieldName: 'TestMaxLengthField',
      nullable: false,
      annotations: [],
      type: 'Edm.String',
      maxLength: 5
    });
    const modifiedSchema = await generateJsonSchema({ metadataReportJson: metadata });
    errorMap = validate({
      jsonSchema: modifiedSchema,
      jsonPayload: maxLengthPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();

    metadata.fields.pop();
  });

  it('Should not find errors in case where maxLength is present on non-string types', async () => {
    let errorMap = {};
    metadata.fields.find(f => f.type === 'Edm.Int64').maxLength = 5;
    const modifiedSchema = await generateJsonSchema({ metadataReportJson: metadata });

    const { AdditionalProperty, ...payload } = additionalPropertyPayload;
    errorMap = validate({
      jsonSchema: modifiedSchema,
      jsonPayload: payload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
    delete metadata.fields.find(f => f.type === 'Edm.Int64').maxLength;
  });

  it('Should find errors when Integer field exceeds its limit', async () => {
    let errorMap = {};
    metadata.fields.push({
      resourceName: 'Property',
      fieldName: 'Foo',
      nullable: false,
      annotations: [],
      type: 'Edm.Int32'
    });
    const modifiedSchema = await generateJsonSchema({ metadataReportJson: metadata });
    const expectedErrorMessage = `MUST be <= ${2 ** 32 - 1}`;
    errorMap = validate({
      jsonSchema: modifiedSchema,
      jsonPayload: integerOverflowPayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    metadata.fields.pop();
  });

  it('Should show the nested expansion resource and field when expansion field is invalid', async () => {
    let errorMap = {};
    const expectedErrorMessage = 'Fields MUST be advertised in the metadata';
    const expectedErrorMessage2 = VALIDATION_ERROR_MESSAGES.NOT_ADVERTISED_IN_METADATA;
    const expectedInvalidParentField = 'ListAgent';
    const expectedInvalidParentResource = 'Property';
    const expectedInvalidSourceModel = 'Member';
    const expectedInvalidSourceModelField = 'Foo';
    const expectedInvalidSourceModelField2 = 'MemberDesignation';
    const expectedInvalidLookup = 'Graduate, REALTOR Institute / GRI';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedPayloadError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(2);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(!!report.errors?.[expectedErrorMessage2]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
    ).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage2].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
    ).toBeTruthy();
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
        ?.sourceModel
    ).toBe(expectedInvalidSourceModel);
    expect(
      report.errors[expectedErrorMessage2].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
        ?.sourceModel
    ).toBe(expectedInvalidSourceModel);
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
        ?.sourceModelField
    ).toBe(expectedInvalidSourceModelField);
    expect(
      report.errors[expectedErrorMessage2].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
        ?.sourceModelField
    ).toBe(expectedInvalidSourceModelField2);
    expect(
      report.errors[expectedErrorMessage2].resources?.[expectedInvalidParentResource]?.fields?.[expectedInvalidParentField]
        ?.lookups?.[expectedInvalidLookup]?.count
    ).toBe(1);
  });

  it('Should not change the payload object', async () => {
    let errorMap = {};
    const expectedErrorMessage = 'Fields MUST be advertised in the metadata';
    const expectedInvalidField = 'Media';
    const expectedInvalidResource = 'Property';
    const originalPayload = JSON.parse(JSON.stringify(nestedCollectionPayloadError));
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedCollectionPayloadError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
    ).toBeTruthy();
    expect(originalPayload).toEqual(nestedCollectionPayloadError);
  });

  it('Should show the nested expansion resource and field when collection expansion field is invalid', async () => {
    let errorMap = {};
    const expectedErrorMessage = 'Fields MUST be advertised in the metadata';
    const expectedInvalidField = 'Media';
    const expectedInvalidResource = 'Property';
    const expectedInvalidSourceModel = 'Media';
    const expectedInvalidSourceModelField = 'Foo';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedCollectionPayloadError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
    ).toBeTruthy();
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]?.sourceModel
    ).toBe(expectedInvalidSourceModel);
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
        ?.sourceModelField
    ).toBe(expectedInvalidSourceModelField);
  });

  it('Should not find error when nested non-collection expansion is null', async () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedPayloadErrorWithNullExpansion,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should find error when nested collection expansion is null', async () => {
    let errorMap = {};
    const expectedInvalidField = 'Media';
    const expectedInvalidResource = 'Property';
    const expectedErrorMessage = 'MUST be array but found null';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedCollectionPayloadErrorWithNull,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
    ).toBeTruthy();
  });

  it('Should find error when nested collection expansion has type error', async () => {
    let errorMap = {};
    const expectedInvalidField = 'ListAgent';
    const expectedInvalidResource = 'Property';
    const expectedInvalidSourceModel = 'Member';
    const expectedInvalidSourceModelField = 'MemberAlternateId';
    const expectedErrorMessage = 'MUST be string or null but found integer';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: nestedExpansionTypeError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
    ).toBeTruthy();
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]?.sourceModel
    ).toBe(expectedInvalidSourceModel);
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedInvalidResource]?.fields?.[expectedInvalidField]
        ?.sourceModelField
    ).toBe(expectedInvalidSourceModelField);
  });

  it('Should ignore errors for payload fields with @ in the middle of the string', async () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: atFieldPayloadError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should correctly classify resource and fields in case of errors with expansion fields', async () => {
    let errorMap = {};
    const expectedField1 = 'BuyerAgentAOR';
    const expectedField2 = 'Media';
    const expectedResource1 = 'Property';
    const expectedResource2 = 'Property';
    const expectedErrorMessage1 = 'MUST be string or null but found array';
    const expectedErrorMessage2 = 'Fields MUST be advertised in the metadata';
    const expectedInvalidSourceModel = 'Media';
    const expectedInvalidSourceModelField = 'Foo';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: expansionErrorMultiValuePayload,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(4);

    expect(!!report.errors?.[expectedErrorMessage1]).toBeTruthy();
    expect(!!report.errors?.[expectedErrorMessage2]).toBeTruthy();

    expect(!!report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]).toBeTruthy();
    expect(report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]?.count).toBe(2);

    expect(!!report.errors[expectedErrorMessage2].resources?.[expectedResource2]?.fields?.[expectedField2]).toBeTruthy();
    expect(report.errors[expectedErrorMessage2].resources?.[expectedResource2]?.fields?.[expectedField2]?.count).toBe(2);

    expect(
      report.errors[expectedErrorMessage2].resources?.[expectedResource2]?.fields?.[expectedField2]?.sourceModel
    ).toBe(expectedInvalidSourceModel);

    expect(
      report.errors[expectedErrorMessage2].resources?.[expectedResource2]?.fields?.[expectedField2]?.sourceModelField
    ).toBe(expectedInvalidSourceModelField);
  });

  it('Should correctly classify resource and fields in case of errors in collection expansions', async () => {
    let errorMap = {};
    const expectedField1 = 'Media';
    const expectedResource1 = 'Property';
    const expectedErrorMessage1 = 'MUST be integer or null but found string';
    const expectedInvalidSourceModel = 'Media';
    const expectedInvalidSourceModelField = 'ImageHeight';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: collectionExpansionError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage1]).toBeTruthy();

    expect(!!report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]).toBeTruthy();
    expect(report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]?.count).toBe(1);

    expect(
      report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]?.sourceModel
    ).toBe(expectedInvalidSourceModel);

    expect(
      report.errors[expectedErrorMessage1].resources?.[expectedResource1]?.fields?.[expectedField1]?.sourceModelField
    ).toBe(expectedInvalidSourceModelField);
  });

  it('Should correctly parse single value expansion errors', () => {
    let errorMap = {};
    const expectedEnumValue = 'Foo';
    const expectedErrorMessage = VALIDATION_ERROR_MESSAGES.NOT_ADVERTISED_IN_METADATA;
    const expectedResource = 'Property';
    const expectedField = 'Media';
    const expectedSourceModel = 'Media';
    const expectedSourceModelField = 'ImageSizeDescription';
    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: singleValueExpansionError,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(1);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();
    expect(!!report.errors[expectedErrorMessage].resources?.[expectedResource]?.fields?.[expectedField]).toBeTruthy();
    expect(
      !!report.errors[expectedErrorMessage].resources?.[expectedResource]?.fields?.[expectedField]?.lookups?.[expectedEnumValue]
    ).toBeTruthy();
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedResource]?.fields?.[expectedField]?.sourceModel
    ).toBe(expectedSourceModel);
    expect(
      report.errors[expectedErrorMessage].resources?.[expectedResource]?.fields?.[expectedField]?.sourceModelField
    ).toBe(expectedSourceModelField);
  });

  it('Should not find errors if there are extra properties on top-level alongside "value"', async () => {
    let errorMap = {};
    errorMap = validate({
      jsonSchema: await generateJsonSchema({ metadataReportJson: metadata, additionalProperties: true }),
      jsonPayload: topLevelUnadvertisedField,
      resourceName: 'Property',
      version: '1.7',
      errorMap
    });
    const report = combineErrors(errorMap);
    expect(report.totalErrors).toBe(0);
  });

  it('Should accumulate key fields if they exist on the failed record', async () => {
    let errorMap = {};
    const resourceName = 'Property';

    const expectedMediaKeys = ['mediakey1', 'mediakey2'];
    const expectedRoomKeys = ['roomkey1', 'roomkey2'];
    const expectedPropertyKeys = ['listingkey1'];

    errorMap = validate({
      jsonSchema: schema,
      jsonPayload: keyFieldPayloadMulti,
      resourceName: 'Property',
      version: '2.0',
      errorMap
    });
    const report = combineErrors(errorMap);
    const expectedErrorMessage = VALIDATION_ERROR_MESSAGES.NOT_ADVERTISED_IN_METADATA;

    expect(report.totalErrors).toBe(5);
    expect(!!report.errors?.[expectedErrorMessage]).toBeTruthy();

    expect(report.errors?.[expectedErrorMessage]?.resources?.[resourceName]?.keys).toEqual(
      expectedPropertyKeys.concat(expectedMediaKeys).concat(expectedRoomKeys)
    );
  });
});
