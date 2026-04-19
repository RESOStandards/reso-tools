'use strict';

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const chalk = require('chalk');
const ajvErrors = require('ajv-errors');
const { DEFAULT_DD_VERSION } = require('../../common');
const {
  parseNestedPropertyForResourceAndField,
  addCustomValidationForEnum,
  addPayloadError,
  determineType,
  normalizeAtField,
  getValidDataDictionaryVersions,
  isValidDataDictionaryVersion,
  combineErrors,
  updateCacheAndStats,
  getResourceAndVersion,
  getMaxLengthMessage,
  VALIDATION_ERROR_MESSAGES,
  SCHEMA_ERROR_KEYWORDS,
  getKeyFieldForResource,
  getValueForKeyField,
  chunkPayload
} = require('./utils');
const { validationContext } = require('./context');

/**
 * @typedef {import('ajv').ValidateFunction} ValidateFunction
 */

const ajv = new Ajv({ allErrors: true, coerceTypes: false, strict: true });

// support types like date
addFormats(ajv);
// better structure for errors
ajvErrors(ajv);

// add custom handling for enums
addCustomValidationForEnum(ajv);

// cache of schemas
const schemaCache = new Map();
const ORIGINAL_SCHEMA = 'original_schema';

/**
 *
 * @param {Object} obj
 * @param {string} obj.resourceName
 * @param {string} obj.fileName
 * @param {string} obj.version
 * @param {{}} obj.jsonSchema
 * @param {{}} obj.jsonPayload
 * @param {{}} obj.errorMap
 * @param {Boolean?} obj.isResoDataDictionarySchema
 * @param {Object} obj.validationConfig
 * @param {boolean} obj.disableKeys
 * @param {boolean} obj.chunk
 *
 * @returns Intermediate error and warning caches along with stats. Can be combined later using `combineErrors`
 */
const validate = ({
  jsonSchema: schema = {},
  resourceName = 'Property',
  jsonPayload: payload,
  errorMap = {},
  fileName = '',
  version,
  isResoDataDictionarySchema = false /*CLI only */,
  validationConfig = {},
  disableKeys,
  chunk = false
} = {}) => {
  const { stats = { totalErrors: 0, totalWarnings: 0 }, errorCache = {}, warningsCache = {}, payloadErrors = {} } = errorMap;

  const oldOneOf = structuredClone(schema.oneOf);
  let schemaId;

  validationContext.setValidationConfig(validationConfig);
  validationContext.setSchema(schema);
  validationContext.setPayloadType(payload.value ? 'MULTI' : 'SINGLE');
  validationContext.setKeysDisabled(disableKeys);

  const contextData = getResourceAndVersion({
    payload,
    resource: resourceName,
    version
  });

  const formattedResourceName = Object.keys(schema?.definitions ?? {}).find(r => r.toLowerCase() === contextData?.resource?.toLowerCase());

  validationContext.setActiveResource(formattedResourceName || contextData?.resource);
  validationContext.setVersion(version || contextData.version);
  validationContext.setRCF(!!payload['@reso.context']);

  const ddVersion = validationContext.getVersion();

  /**
   * Step 1 - Analyze the payload and parse out the relevant data like the version, resourceName, etc.
   *
   * Using this additional info we can improve our generated schema by providing a resource against which
   * the payload should be validated.
   */
  let validPayload = true;
  if (!payload['@reso.context']) {
    if (!ddVersion) {
      validPayload = false;
      throw new Error('Version is required for payloads without "@reso.context" property');
    }
  }

  try {
    if (!isValidDataDictionaryVersion(ddVersion)) {
      throw new Error(`Found invalid DD version ${ddVersion}. Supported versions: ${getValidDataDictionaryVersions()}`);
    }

    const { definitions } = schema;
    const singleValueSchema = schema?.oneOf?.find(s => !s.properties.value);
    const multiValueSchema = schema?.oneOf?.find(s => s.properties.value);

    if (!formattedResourceName) {
      console.log(chalk.redBright(`Found invalid resource: ${formattedResourceName}`));
      addPayloadError(formattedResourceName, fileName, 'Invalid resource', payloadErrors);
      return errorMap;
    }
    resourceName = formattedResourceName;
    if (!payload.value) {
      schema.oneOf = [singleValueSchema];
      schemaId = `single-${formattedResourceName}`;
      // extend the generated schema with new info from the specific payload
      Object.assign(singleValueSchema.properties, definitions[formattedResourceName].properties);
    } else {
      schema.oneOf = [multiValueSchema];
      multiValueSchema.properties.value.items = {
        $ref: `#/definitions/${formattedResourceName}`
      };
      schemaId = `multi-${formattedResourceName}`;
    }
  } catch (error) {
    validPayload = false;
    console.error(chalk.redBright.bold('ERROR: ' + error.message));
    addPayloadError(resourceName, fileName, error.message, payloadErrors);
  }

  if (!validPayload)
    return {
      stats,
      errorCache,
      warningsCache,
      payloadErrors
    };

  // Step 2 - Validate with AJV and generate error report
  const [selectedSchema] = schema.oneOf;
  const additionalPropertiesAllowed = selectedSchema.properties.value
    ? schema.definitions[Object.keys(schema.definitions)[0]].additionalProperties
    : selectedSchema.additionalProperties;

  const originalSchema = schemaCache.get(ORIGINAL_SCHEMA);
  if (originalSchema !== schema) {
    schemaCache.clear();
    schemaCache.set(ORIGINAL_SCHEMA, schema);
  }

  let cachedSchema = schemaCache.get(schemaId);
  if (!cachedSchema) {
    cachedSchema = { ...schema };
    schemaCache.set(schemaId, cachedSchema);
  }

  const validate = ajv.compile(cachedSchema);

  let chunkedPayload = [payload];
  if (chunk) {
    chunkedPayload = chunkPayload(payload);
  }
  
  for (const p of chunkedPayload) {
    const valid = validate(p);
    if (!valid) {
      generateErrorReport({
        validate,
        json: p,
        additionalPropertiesAllowed,
        resourceName,
        errorCache,
        warningsCache,
        stats,
        fileName,
        isResoDataDictionarySchema,
        version: ddVersion,
        isRCF: validationContext.isRCF(),
        metadataMap: schema?.definitions?.MetadataMap || {}
      });
    }
  }

  schema.oneOf = oldOneOf;
  validationContext.reset();
  return {
    ...errorMap,
    errorCache,
    warningsCache,
    stats,
    payloadErrors,
    version: ddVersion
  };
};

/**
 * TODO
 * @param {Object} obj
 * @param {Record<string, {}>} obj.payloads
 * @param {{}} obj.schema
 * @param {string} obj.resourceNameFromArgs
 * @param {string} obj.versionFromArgs
 * @param {Object} obj.validationConfig
 * @param {boolean} obj.disableKeys
 *
 * @returns The processed error report
 */
const validatePayload = ({ payloads = {}, schema, resourceNameFromArgs = '', versionFromArgs, validationConfig = {}, disableKeys }) => {
  const payloadErrors = {};
  const errorCache = {};
  const warningsCache = {};
  const stats = {
    totalErrors: 0,
    totalWarnings: 0
  };

  let errorMap = {
    payloadErrors,
    errorCache,
    warningsCache,
    stats
  };

  const isResoDataDictionarySchema = schema instanceof Map;

  Object.entries(payloads).forEach(([fileName, payload]) => {
    const { version } = getResourceAndVersion({ payload, version: DEFAULT_DD_VERSION });
    errorMap = validate({
      version: versionFromArgs,
      jsonPayload: payload,
      fileName,
      errorMap,
      jsonSchema: isResoDataDictionarySchema ? schema.get(version) : schema,
      resourceName: resourceNameFromArgs,
      isResoDataDictionarySchema,
      validationConfig,
      disableKeys
    });
  });

  const errorReport = combineErrors(errorMap);

  if (stats?.totalErrors || stats?.totalWarnings) {
    return {
      errors: errorReport
    };
  }
};
/**
 * @param {Object} obj
 * @param {boolean} obj.isRCF
 * @param {string} obj.resourceName
 * @param {string} obj.fileName
 * @param {string} obj.version
 * @param {Boolean} obj.isResoDataDictionarySchema
 * @param {{}} obj.errorCache
 * @param {{}} obj.warningsCache
 * @param {ValidateFunction} obj.validate
 * @param {{totalWarnings: Number, totalErrors: Number}} obj.stats
 *
 * Processes the raw validation results from AJV.
 */
const generateErrorReport = ({
  validate,
  json,
  resourceName,
  errorCache,
  warningsCache,
  stats,
  fileName,
  version,
  isResoDataDictionarySchema,
  isRCF,
  metadataMap
}) => {
  validate.errors.reduce((acc, { instancePath, message, keyword, params, failedItemValue: value, isWarning, transformedValue, failedEnum }) => {
    if (!instancePath && keyword !== SCHEMA_ERROR_KEYWORDS.ADDITIONAL_PROPERTIES) return acc;
    const nestedPayloadProperties = instancePath?.split('/')?.slice(1) || [];
    let failedItemValue = '';

    const schema = validationContext.getSchema();

    if (value !== undefined && value !== null) {
      failedItemValue = value;
    } else {
      // grab the nested value of the failed item from the payload
      failedItemValue = nestedPayloadProperties.reduce((val, curr) => {
        if (!val && json[curr] !== undefined) return json[curr];
        return val?.[curr] !== undefined ? val?.[curr] : val;
      }, null);
    }

    if (keyword === SCHEMA_ERROR_KEYWORDS.TYPE) {
      const schemaType = params?.type;
      const schemaTypeFormatted = Array.isArray(schemaType) ? schemaType.join(' or ') : schemaType;
      message = `MUST be ${schemaTypeFormatted} but found ${determineType(failedItemValue)}`;
      transformedValue = determineType(failedItemValue);
      failedItemValue = '';
    }

    const { fieldName, sourceModel, sourceModelField: modelField, index, expansionIndex } = parseNestedPropertyForResourceAndField({
      arr: nestedPayloadProperties,
      metadataMap: schema?.definitions?.MetadataMap,
      parentResourceName: resourceName
    });
    let sourceModelField = modelField;

    if (
      keyword === SCHEMA_ERROR_KEYWORDS.TYPE &&
      params?.type === SCHEMA_ERROR_KEYWORDS.OBJECT &&
      metadataMap?.[resourceName]?.[fieldName]?.nullable &&
      transformedValue === SCHEMA_ERROR_KEYWORDS.NULL
    ) {
      return acc;
    }

    let failedItemName = fieldName;
    if (params?.additionalProperty) {
      if (sourceModel) {
        sourceModelField = params?.additionalProperty;
      } else {
        failedItemName = params?.additionalProperty;
      }
    }

    if (keyword === SCHEMA_ERROR_KEYWORDS.ADDITIONAL_PROPERTIES) {
      if (!failedItemName) failedItemName = params?.additionalProperty;
      failedItemValue = '';
      message = isResoDataDictionarySchema
        ? `Additional fields found that are not part of Data Dictionary ${version}`
        : 'Fields MUST be advertised in the metadata';
    }

    if (['@odata', '@reso'].some(c => failedItemName?.startsWith(c))) {
      // we don't want to error out on these fields
      return acc;
    }

    // ignore fields with '@' in the middle or start of the string
    const normalizedField = normalizeAtField(failedItemName);
    const normalizedExpansionField = sourceModelField ? normalizeAtField(sourceModelField) : null;
    if (normalizedField !== failedItemName || (sourceModelField && sourceModelField !== normalizedExpansionField)) {
      return acc;
    }

    let resolvedKeyword = keyword;
    if (keyword === SCHEMA_ERROR_KEYWORDS.ERROR_MESSAGE) {
      resolvedKeyword = params?.errors?.[0]?.keyword || keyword;
    }

    if (failedItemValue?.['constructor'] === Object && resolvedKeyword === SCHEMA_ERROR_KEYWORDS.ADDITIONAL_PROPERTIES) {
      failedItemValue = SCHEMA_ERROR_KEYWORDS.ADDITIONAL_PROPERTIES;
    }

    if (resolvedKeyword === SCHEMA_ERROR_KEYWORDS.MAX_LENGTH) {
      failedItemValue = '';
      if (isRCF) {
        isWarning = true;
      } else {
        message = getMaxLengthMessage(
          params?.errors?.find(e => e?.params?.limit),
          isRCF
        );
      }
    }

    const keysDisabled = validationContext.keysDisabled();
    const multiPayload = validationContext.getPayloadType() === 'MULTI';
    const payload = multiPayload ? json : { value: [json] };
    const keyField = isWarning || keysDisabled ? null : getKeyFieldForResource(sourceModel ?? resourceName);

    const keyFieldValue = isWarning || keysDisabled
      ? null
      : getValueForKeyField({
        keyField,
        payload,
        index: multiPayload ? index : 0,
        expansionIndex: multiPayload ? expansionIndex : index,
        expansionField: failedItemName,
        isExpansion: !!sourceModel
      });

    updateCacheAndStats({
      cache: isWarning ? warningsCache : errorCache,
      resourceName: resourceName,
      failedItemName,
      message,
      fileName,
      stats,
      failedItemValue,
      isWarning,
      sourceModel,
      sourceModelField,
      keyField,
      keyFieldValue,
      failedEnum
    });
    return acc;
  }, {});
};

module.exports = {
  validatePayload,
  isValidDataDictionaryVersion,
  validate,
  combineErrors,
  VALIDATION_ERROR_MESSAGES
};
