'use strict';

const { buildMetadataMap } = require('../../common');
const { writeFile } = require('./utils');

/**
 *
 * @param {Object} resources
 * @param {Array} lookups
 * @param {Boolean} additionalProperties
 * @returns Definitions created from the fields ans lookups in the metadata
 */
const createDefinitions = async (resources, lookups, additionalProperties = false) => {
  const typeMappings = {
    'Edm.String': 'string',
    'Edm.Boolean': 'boolean',
    'Edm.Int16': 'integer',
    'Edm.Int32': 'integer',
    'Edm.Int64': 'integer',
    'Edm.Decimal': 'number',
    'Edm.Single': 'number',
    'Edm.Double': 'number',
    'Edm.DateTimeOffset': 'string',
    'Edm.Date': 'string'
  };

  /**
   * True when a field is a DECIMAL whose scale is explicitly zero, which has no fractional digits
   * and so is an integer.
   *
   * Narrow on purpose, in two ways that previously were not.
   *
   * It requires `Edm.Decimal`. The old guard ran for everything mapping to `number`, which also
   * catches `Edm.Single` and `Edm.Double`. Scale is a Decimal facet; on a Double it means nothing,
   * and `Precision` there is significant floating-point digits rather than a decimal scale. Both
   * RESO specs name `Edm.Double` as a sanctioned way to express decimal values, so typing one as
   * an integer fails a provider for declaring what the spec permits.
   *
   * It requires scale to be explicitly 0 rather than merely absent. The old guard, `!field.scale`,
   * cannot tell those apart, because `!0` is true as well. The Data Dictionary says decimals "MAY
   * contain Precision and Scale attributes ... which also MAY be omitted", so an omission is not a
   * statement about the value and must not be read as one. The serializer drops the key entirely
   * when the XML carries no Scale, so the two cases are genuinely distinguishable here.
   *
   * Found on a live run against metadata with 71 `Edm.Double` properties and no Scale anywhere:
   * every one was typed integer, and $expand scenarios failed with "MUST be integer or null but
   * found decimal" on Latitude, Longitude and LotSizeAcres among others.
   *
   * `precision` is still required, because it bounds the value and because keeping that condition
   * means this change can only ever REMOVE a false failure, never introduce a new one.
   */
  const isScaleZeroDecimal = field => field.type === 'Edm.Decimal' && field.scale === 0 && !!field.precision;

  const EDM_DATE_TIME_OFFSET = typeMappings['Edm.DateTimeOffset'];
  const EDM_DATE = typeMappings['Edm.Date'];

  // Preprocess the lookups data to create a hashmap
  const lookupsMap = {};
  lookups.forEach(lookup => {
    if (!lookupsMap[lookup.lookupName]) {
      lookupsMap[lookup.lookupName] = new Set();
    }
    lookupsMap[lookup.lookupName].add(lookup.lookupValue);
  });

  const getPossibleLookupValues = lookupName => {
    const possibleValues = lookupsMap[lookupName];
    return possibleValues ? [...possibleValues] : [];
  };

  const isSimpleType = type => type?.startsWith('Edm.');

  // A field is a lookup (enumeration) field if it advertises values, carries the LookupName annotation
  // (Edm.String representation), or is flagged isEnumeration (nominal EnumType representation). A nominal
  // (non-Edm) type with none of these is an unhandled ComplexType, NOT an enumeration — mirroring
  // common.js's isLookupField/isComplexType split. Only lookup fields get an enum (the advertised set,
  // or a fail-closed empty enum when nothing is advertised); ComplexTypes keep their object typing.
  const LOOKUP_NAME_TERM = 'RESO.OData.Metadata.LookupName';
  const hasLookupNameAnnotation = field => (field?.annotations ?? []).some(a => a?.term === LOOKUP_NAME_TERM);
  const isLookupField = (field, possibleValues) =>
    possibleValues.length > 0 || hasLookupNameAnnotation(field) || field?.isEnumeration === true;

  const definitions = {};

  // This can be expanded to add more custom errors where the error value doesn't need to be known before running the schema. For eg. length in this case.
  const customErrorsMapping = {
    maxLength: length => ['maxLength', `SHOULD have a maximum suggested length of ${length} characters`]
  };

  for (const [resourceName, resourceFields] of Object.entries(resources)) {
    // Yield to the event loop between resources so IPC messages can flush
    await new Promise(resolve => setImmediate(resolve));
    const properties = {};
    resourceFields.forEach(field => {
      const customErrors = [];
      const { fieldName } = field;
      let schema = {};
      if (field?.isComplexType) {
        // to be handled in DD v2.1
      } else if (field.isExpansion || field.isCollection) {
        const itemTypeSchema = {};

        if (field.isExpansion) {
          itemTypeSchema['$ref'] = `#/definitions/${field.typeName}`;
        } else {
          const mappedType = typeMappings[field.type] || 'object';
          itemTypeSchema['type'] = mappedType;
          if (field.maxLength) {
            if (field.type === 'Edm.String') {
              itemTypeSchema['maxLength'] = field.maxLength;
              customErrors.push(customErrorsMapping['maxLength'](field.maxLength));
            }
          }
          if (field.type === 'Edm.Int16') {
            itemTypeSchema.maximum = 2 ** 16 - 1;
          }
          if (field.type === 'Edm.Int32') {
            itemTypeSchema.maximum = 2 ** 32 - 1;
          }
          if (field.type === 'Edm.Int64') {
            itemTypeSchema.maximum = 2 ** 64 - 1;
          }
          if (field.type === EDM_DATE_TIME_OFFSET) itemTypeSchema['format'] = 'date-time';
          if (field.type === EDM_DATE) itemTypeSchema['format'] = 'date';
          if (mappedType === 'number') {
            if (isScaleZeroDecimal(field)) {
              // A DECIMAL whose scale is explicitly 0 has no fractional digits, so it is an integer.
              // Type it as JSON integer to reject fractional values, and cap it at the precision max.
              itemTypeSchema['type'] = 'integer';
              itemTypeSchema['maximum'] = Number('9'.repeat(field.precision));
            }
          }

          if (!isSimpleType(field.type)) {
            const possibleValues = getPossibleLookupValues(field.type);
            if (isLookupField(field, possibleValues)) {
              // Enum enforcement is INDEPENDENT of additionalProperties: additionalProperties permits extra
              // *fields*, but enum *values* must always be advertised. Attach the advertised set, or fail
              // closed when a lookup field advertises NOTHING — an empty enum rejects any real value that
              // shows up. [null] is the smallest valid enum; the nullable block below seeds null for nullable
              // fields (so [] there), leaving [null] for the non-nullable case. Whether null is ACCEPTED is
              // governed by `type` (nullable -> ['string','null'], non-nullable -> ['string']).
              itemTypeSchema['enum'] =
                possibleValues.length > 0 ? possibleValues : field.nullable === false ? [null] : [];
              itemTypeSchema['type'] =
                possibleValues.length > 0 ? Array.from(new Set(possibleValues.map(v => typeof v))) : ['string'];
            }
            // A nominal non-lookup type (unhandled ComplexType) keeps its object typing — no enum applied.
          }
        }

        if (customErrors.length) {
          itemTypeSchema.errorMessage = Object.fromEntries(customErrors);
        }

        if (field.isCollection) {
          schema['type'] = 'array';
          schema['items'] = itemTypeSchema;
        } else {
          schema = itemTypeSchema;
        }

        if (!('nullable' in field) || field.nullable) {
          let type = [];
          if (Array.isArray(schema.type)) {
            type.push(...schema.type, 'null');
          } else {
            type.push(schema.type, 'null');
          }
          type = type.filter(Boolean);
          if (!field.isCollection) {
            if (schema.enum) {
              schema.enum?.push(null);
            }
            if (!field.isExpansion) {
              schema.type = type;
            }
          } else {
            if (schema.items.enum) {
              schema.items.enum?.push(null);
            }
          }
        }
      } else {
        const fieldType = typeMappings[field.type] || 'object';
        schema['type'] = fieldType;
        if (field.maxLength) {
          if (field.type === 'Edm.String') {
            schema['maxLength'] = field.maxLength;
            customErrors.push(customErrorsMapping['maxLength'](field.maxLength));
          }
        }
        if (field.type === 'Edm.Int16') {
          schema.maximum = 2 ** 16 - 1;
        }
        if (field.type === 'Edm.Int32') {
          schema.maximum = 2 ** 32 - 1;
        }
        if (field.type === 'Edm.Int64') {
          schema.maximum = 2 ** 64 - 1;
        }
        if (field.type === EDM_DATE_TIME_OFFSET) schema['format'] = 'date-time';
        if (field.type === EDM_DATE) schema['format'] = 'date';
        if (fieldType === 'number') {
          if (isScaleZeroDecimal(field)) {
            // A DECIMAL whose scale is explicitly 0 has no fractional digits, so it is an integer.
            // Type it as JSON integer to reject fractional values, and cap it at the precision max.
            schema['type'] = 'integer';
            schema['maximum'] = Number('9'.repeat(field.precision));
          }
        }

        if (!isSimpleType(field.type)) {
          const possibleValues = getPossibleLookupValues(field.type);
          if (isLookupField(field, possibleValues)) {
            // Enum enforcement is INDEPENDENT of additionalProperties (see the collection branch above):
            // extra fields may be allowed, but enum values must always be advertised. Attach the advertised
            // set, or fail closed with an empty enum when a lookup field advertises NOTHING. [null] is the
            // smallest valid enum; the nullable block seeds null for nullable fields (so [] there), leaving
            // [null] for the non-nullable case. Null ACCEPTANCE is governed by `type`.
            schema['enum'] =
              possibleValues.length > 0 ? possibleValues : field.nullable === false ? [null] : [];
            schema['type'] =
              possibleValues.length > 0 ? Array.from(new Set(possibleValues.map(v => typeof v))) : ['string'];
          }
          // A nominal non-lookup type (unhandled ComplexType) keeps its object typing — no enum applied.
        }

        if (customErrors.length) {
          schema.errorMessage = Object.fromEntries(customErrors);
        }

        if (!('nullable' in field) || field.nullable) {
          let type = [];
          if (Array.isArray(schema.type)) {
            type.push(...schema.type, 'null');
          } else {
            type.push(schema.type, 'null');
          }
          type = type.filter(Boolean);
          if (schema.enum) {
            schema.enum?.push(null);
          }
          schema.type = type;
        }
      }
      properties[fieldName] = schema;
    });

    definitions[resourceName] = {
      type: 'object',
      properties,
      additionalProperties
    };
  }

  return definitions;
};

/**
 *
 * @param {Object} resources
 * @param {Array} lookups
 * @param {Boolean} additionalProperties
 * @returns A schema that can be used by the validation tool.
 *
 * This schema is incomplete as the definitions are not attached
 * to the properties inside `oneOf`. The validation tool can adjust this schema
 * according to the payload type.
 */
const createSchema = async (resources, lookups, additionalProperties) => {
  const definitions = await createDefinitions(resources, lookups, additionalProperties);

  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    oneOf: [
      {
        properties: {
          '@reso.context': {
            type: 'string'
          }
        },
        additionalProperties
      },
      {
        properties: {
          '@reso.context': {
            type: 'string'
          },
          value: {
            type: 'array'
          }
        },
        additionalProperties
      }
    ],
    definitions: definitions
  };

  return schema;
};

/**

 * @param {Object} metadata 
 * @returns Fields grouped by resources
 */
const getResourcesFromMetadata = metadata => {
  const resources = {};

  metadata.fields.forEach(field => {
    const { resourceName } = field;

    if (!resources[resourceName]) {
      resources[resourceName] = [];
    }

    resources[resourceName].push(field);
  });

  return resources;
};

/** CSDL's collection form: `Collection(<element type>)`. */
const COLLECTION_TYPE = /^Collection\((.+)\)$/;

/**
 * A report's `type` is a field's ELEMENT type, with collection-ness only in `isCollection`. Everything below tests
 * `type` against a bare `Edm.*`, so a wrapped `Collection(Edm.String)` falls through `typeMappings[field.type] ||
 * 'object'` and every string in the array fails "MUST be object but found string".
 *
 * The engine normalizes reports where they enter (src/sdk/report-field-types.ts), but a report can also reach this
 * generator straight from a file, through the replicate and schema commands, written by any tool or version. This
 * is the one place every schema is built, so it holds the line here too. On 2026-10-21 an install with
 * reso-metadata-utils 0.1.3 turned a provider's MlgCanUse, a plain array of strings, into 2,779 false errors.
 * Returns the same object when no field is wrapped.
 */
const withElementTypes = metadataJson => {
  const fields = Array.isArray(metadataJson?.fields) ? metadataJson.fields : null;
  const isWrapped = field => typeof field?.type === 'string' && COLLECTION_TYPE.test(field.type);
  if (!fields || !fields.some(isWrapped)) return metadataJson;
  return {
    ...metadataJson,
    fields: fields.map(field =>
      isWrapped(field) ? { ...field, type: COLLECTION_TYPE.exec(field.type)[1], isCollection: true } : field
    )
  };
};

const generateSchema = async (reportJson, additionalProperties) => {
  try {
    const metadataJson = withElementTypes(reportJson);
    const resources = getResourcesFromMetadata(metadataJson);
    const schema = await createSchema(resources, metadataJson?.lookups, additionalProperties);
    const { metadataMap = {} } = buildMetadataMap(metadataJson) || {};
    schema.definitions.MetadataMap = metadataMap;
    return schema;
  } catch (err) {
    console.log(err);
    return null;
  }
};

const generateJsonSchema = async ({
  metadataReportJson = { fields: [], lookups: [] },
  outputFilePath = '',
  additionalProperties = false
} = {}) => {
  const schema = await generateSchema(metadataReportJson, additionalProperties);
  if (schema && outputFilePath) {
    const success = await writeFile(outputFilePath, JSON.stringify(schema));
    if (!success) console.log(`Error writing schema to path ${outputFilePath}`);
  }
  return schema;
};

module.exports = {
  generateSchema,
  withElementTypes,
  generateJsonSchema
};
