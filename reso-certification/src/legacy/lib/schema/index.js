'use strict';

const { generateSchema, generateJsonSchema } = require('./generate');
const path = require('path');
const { validatePayload, validate, combineErrors, VALIDATION_ERROR_MESSAGES } = require('./validate');
const { getErrorHandler, DATA_DICTIONARY_VERSIONS } = require('../../common');
const { getReferenceMetadata } = require('@reso/reso-certification-etl');
const { processFiles, createDirectoryIfNotPresent, writeFile, readFile } = require('./utils');

const ERROR_REPORT = 'schema-validation-report.json';
const VALIDATION_CONFIG_FILE = 'schema-validation-settings.json';

/**
 * @param {Object} obj
 * @param {boolean} obj.additionalProperties
 * @param {boolean} obj.generate
 * @param {boolean} obj.validate
 * @param {string} obj.metadataPath
 * @param {string} obj.outputPath
 * @param {string} obj.version
 * @param {string} obj.payloadPath
 * @param {string} obj.resourceName
 *
 * @description Action handler for the commander CLI `schema` command.
 */
const schema = async ({
  metadataPath = '',
  outputPath = '.',
  additionalProperties = false,
  generate,
  validate,
  version,
  payloadPath,
  resourceName,
  fromCli = false,
  disableKeys = false
}) => {
  const handleError = getErrorHandler(fromCli);
  try {
    if (fromCli) {
      if ((!generate && !validate) || (generate && validate)) {
        handleError('Only one of --generate (-G) or --validate (-V) should be passed');
      }
    }

    if (generate) {
      let metadataReport = null;
      if (!metadataPath) {
        metadataReport = getReferenceMetadata(version);
        if (!metadataReport) {
          handleError(`Invalid version ${version}`);
        }
      }

      try {
        const result = await generateSchemaFromMetadata({
          metadataPath,
          metadataReport,
          additionalProperties
        });

        if (result?.schema) {
          const { schema } = result;

          // write schema to the output path
          const fileName = 'schema-' + (metadataPath?.split('/')?.at(-1) || 'metadata.json');
          const success = await writeFile(path.join(outputPath, fileName), JSON.stringify(schema));
          if (!success) {
            handleError('Error writing generated schema to the given location');
          }

          if (fromCli) {
            console.log(`Schema successfully generated and saved in ${outputPath}/${fileName}`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    } else if (validate) {
      if (!payloadPath) {
        handleError('Invalid path to payloads');
      }

      const validationConfig = JSON.parse(await readFile(VALIDATION_CONFIG_FILE)) || {};

      try {
        const fileContentsMap = {};
        await processFiles({ inputPath: payloadPath, fileContentsMap });
        await validatePayloads({
          metadataPath,
          fileContentsMap,
          additionalProperties,
          version,
          resourceName,
          validationConfig,
          disableKeys
        });
      } catch (err) {
        handleError(err);
      }
    }
  } catch (err) {
    handleError(`Something went wrong! Error: ${err}`);
  }
};

/**
 * Generates JSON schema from the given metadata
 * @param {Object} obj
 * @param {boolean} obj.additionalProperties
 * @param {string} obj.metadataPath
 * @param {{}} obj.metadataReport
 * @returns generated schema
 */
const generateSchemaFromMetadata = async ({ metadataPath = '', additionalProperties = false, metadataReport }) => {
  try {
    const metadataReportJson = metadataPath ? JSON.parse((await readFile(metadataPath)) || null) : metadataReport;
    if (!metadataReportJson) {
      throw new Error('Invalid metadata file!');
    }

    const schema = generateSchema(metadataReportJson, additionalProperties);
    if (!schema) {
      throw new Error('Error generating JSON schema from the given metadata report');
    }

    return { schema };
  } catch (err) {
    throw new Error(`Something went wrong while generating the schema! Error: ${err}`);
  }
};

/**
 *
 * @param {Object} obj
 * @param {boolean} obj.additionalProperties
 * @param {string} obj.metadataPath
 * @param {{}} obj.fileContentsMap
 * @param {string} obj.version
 * @param {string} obj.resourceName
 * @param {Object} obj.validationConfig
 * @param {boolean} obj.disableKeys
 *
 * @description Reads the directory with the flattened JSON files and sends them for validation.
 */
const validatePayloads = async ({
  metadataPath = '',
  fileContentsMap = {},
  additionalProperties = false,
  version,
  resourceName,
  validationConfig = {},
  disableKeys
}) => {
  if (!Object.keys(fileContentsMap).length) throw new Error('No JSON files found');

  await validatePayloadAndGenerateResults({
    errorPath: '.',
    fileContentsMap,
    version,
    metadataPath,
    additionalProperties,
    resourceName,
    validationConfig,
    disableKeys
  });
};

/**
 *
 * @param {Object} obj
 * @param {boolean} obj.additionalProperties
 * @param {string} obj.errorPath
 * @param {string} obj.version
 * @param {string} obj.metadataPath
 * @param {string} obj.resourceName
 * @param {Object} obj.fileContentsMap
 * @param {Object} obj.validationConfig
 * @param {boolean} obj.disableKeys
 *
 * @description Processes the input from the CLI and writes the final error report into the given path.
 */
const validatePayloadAndGenerateResults = async ({
  fileContentsMap,
  errorPath,
  version,
  metadataPath,
  additionalProperties,
  resourceName,
  validationConfig = {},
  disableKeys
}) => {
  try {
    let schemaJson = null;

    const metadataJson = metadataPath ? JSON.parse((await readFile(metadataPath)) || null) : null;
    if (!metadataJson) {
      // use RESO metadata reports instead
      const metadataReports = Object.values(DATA_DICTIONARY_VERSIONS).map(v => ({ version: v, metadata: getReferenceMetadata(v) }));
      schemaJson = new Map();
      metadataReports.forEach(r => schemaJson.set(r.version, generateSchema(r.metadata, additionalProperties)));
    } else {
      schemaJson = generateSchema(metadataJson, additionalProperties);
    }

    if (!schemaJson) {
      throw new Error('Unable to generate a schema file. Pass the schema/metadata file in the options or check for invalid DD version.');
    }

    const result = validatePayload({
      payloads: fileContentsMap,
      schema: schemaJson,
      resourceNameFromArgs: resourceName,
      versionFromArgs: version,
      validationConfig,
      disableKeys
    });

    if (result?.errors) {
      const errorDirectoryExists = await createDirectoryIfNotPresent(errorPath);
      if (!errorDirectoryExists) throw new Error('Unable to create error directory');

      const success = await writeFile(
        path.join(errorPath, ERROR_REPORT),
        JSON.stringify({
          ...(result.errors || {})
        })
      );

      if (!success) {
        throw new Error('Error writing error data to the given location');
      } else {
        console.log(`Validation errors written to: ${errorPath}/${ERROR_REPORT}`);
      }
    } else {
      console.log('The payload was successfully validated against the provided schema');
    }
  } catch (err) {
    throw new Error(`Something went wrong while validating the payload! Error: ${err}`);
  }
};

module.exports = {
  schema,
  generateJsonSchema,
  validate,
  combineErrors,
  VALIDATION_ERROR_MESSAGES,
  VALIDATION_CONFIG_FILE
};
