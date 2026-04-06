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
const createDefinitions = (resources, lookups, additionalProperties = false) => {
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

  const definitions = {};

  // This can be expanded to add more custom errors where the error value doesn't need to be known before running the schema. For eg. length in this case.
  const customErrorsMapping = {
    maxLength: length => ['maxLength', `SHOULD have a maximum suggested length of ${length} characters`]
  };

  for (const [resourceName, resourceFields] of Object.entries(resources)) {
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
            if (!field.scale && field.precision) {
              if (field.precision) itemTypeSchema['maximum'] = Number('9'.repeat(field.precision));
            }
          }

          if (!isSimpleType(field.type)) {
            const possibleValues = getPossibleLookupValues(field.type);
            if (possibleValues.length > 0) {
              if (!additionalProperties) {
                itemTypeSchema['enum'] = possibleValues;
              }
            }
            if (!possibleValues.length) {
              possibleValues.push('');
            }
            itemTypeSchema['type'] = Array.from(new Set(possibleValues.map(v => typeof v)));
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
          if (!field.scale && field.precision) {
            if (field.precision) schema['maximum'] = Number('9'.repeat(field.precision));
          }
        }

        if (!isSimpleType(field.type)) {
          const possibleValues = getPossibleLookupValues(field.type);
          if (possibleValues.length > 0) {
            if (!additionalProperties) {
              schema['enum'] = possibleValues;
            }
          }
          if (!possibleValues.length) {
            possibleValues.push('');
          }
          schema['type'] = Array.from(new Set(possibleValues.map(v => typeof v)));
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
const createSchema = (resources, lookups, additionalProperties) => {
  const definitions = createDefinitions(resources, lookups, additionalProperties);

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

const generateSchema = (metadataJson, additionalProperties) => {
  try {
    const resources = getResourcesFromMetadata(metadataJson);
    const schema = createSchema(resources, metadataJson?.lookups, additionalProperties);
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
  const schema = generateSchema(metadataReportJson, additionalProperties);
  if (schema && outputFilePath) {
    const success = await writeFile(outputFilePath, JSON.stringify(schema));
    if (!success) console.log(`Error writing schema to path ${outputFilePath}`);
  }
  return schema;
};

module.exports = {
  generateSchema,
  generateJsonSchema
};
