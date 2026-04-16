'use strict';

const { readFile, writeFile, mkdir } = require('fs/promises');
const { join, normalize, resolve } = require('path');
const { existsSync } = require('fs');

const { REPLICATION_STRATEGIES, fetchTopLevelResourceCount } = require('./utils');
const { NOT_OK, getLoggers } = require('../../common');

const { replicationIterator } = require('./replication-iterator');

const authService = require('./services/auth/oauth2');

const { generateJsonSchema, validate, VALIDATION_CONFIG_FILE } = require('../schema');

const {
  DEFAULT_DD_VERSION,
  handleError,
  scorePayload,
  writeAnalyticsReports,
  writeSchemaValidationErrorReport,
  getSystemRuntimeInfo,
  prepareRequests,
  buildOutputFilePath
} = require('./utils');

const { createReplicationStateServiceInstance } = require('../../common');

const DEFAULT_RATE_LIMITED_WAIT_MINUTES = 60,
  DEFAULT_SECONDS_DELAY_BETWEEN_REQUEST = 1;

/**
 * Prepares a filter expression, accounting for OriginatingSystemName or ID
 * @param {String} filter filter expression to use
 * @param {Object} options object containing filter options
 * @returns adjusted filter with OriginatingSystemName or ID, when present
 */
const prepareFilterExpression = (filter, { originatingSystemId, originatingSystemName }) => {
  const filters = [];

  if (filter && filter?.length) {
    filters.push(filter);
  }

  if (originatingSystemName && originatingSystemName?.length) {
    filters.push(`OriginatingSystemName eq '${originatingSystemName}'`);
  } else if (originatingSystemId && originatingSystemId?.length) {
    filters.push(`OriginatingSystemID eq '${originatingSystemId}'`);
  }

  return filters && filters?.length ? filters.join(' and ') : null;
};

/**
 * Replicates data from the given OData request URL using the given strategy, credentials, and options
 *
 * @param {Object} args this function takes multiple parameters
 * @returns this function has no return value, but will produce side effects if outputPath is used (will write files)
 */
const replicate = async ({
  serviceRootUri,
  strategy,
  bearerToken,
  clientCredentials = {},
  outputPath,
  limit,
  maxPageSize,
  resourceName,
  expansions: expansionArrayOrCommaSeparatedString,
  metadataReportJson = {},
  pathToMetadataReportJson = '',
  filter,
  top,
  orderby,
  rateLimitedWaitTimeMinutes = DEFAULT_RATE_LIMITED_WAIT_MINUTES,
  secondsDelayBetweenRequests = DEFAULT_SECONDS_DELAY_BETWEEN_REQUEST,
  shouldGenerateReports = true,
  jsonSchemaValidation = false,
  fromCli = false,
  version = DEFAULT_DD_VERSION,
  strictMode = false,
  originatingSystemName,
  originatingSystemId,
  REPLICATION_STATE_SERVICE = createReplicationStateServiceInstance(),
  shouldSaveResults = false,
  batchExpand = false,
  throwOnError = false
}) => {

  const { LOG, LOG_ERROR } = getLoggers(fromCli);

  try {
    // error if unknown strategy is specified
    if (!Object.values(REPLICATION_STRATEGIES).includes(strategy)) {
      throw new Error(`Unknown strategy: '${strategy}'!`);
    }

    //TODO: switch to logger
    LOG(`\nReplicating data from '${serviceRootUri}' with strategy '${strategy}'!`);

    //initialize services, if needed
    REPLICATION_STATE_SERVICE.init();
    await authService.init({ bearerToken, clientCredentials });
    
    // expansions will be a comma-separated list if passed from the command line and array if called from a library
    const expansionsArray = Array.isArray(expansionArrayOrCommaSeparatedString)
      ? expansionArrayOrCommaSeparatedString
      : expansionArrayOrCommaSeparatedString?.split(',').map(x => x?.trim()) || [];

    // load metadata report if it's been passed in as a path
    const metadataReport =
      !pathToMetadataReportJson && !!metadataReportJson
        ? metadataReportJson
        : JSON.parse(await readFile(pathToMetadataReportJson, { encoding: 'utf8' }));

    // this needs to be done only once, and only if we're using schema validation
    // TODO: consider passing in when needed instead
    let generatedSchema, validationConfig;

    let schemaValidationResults = {};

    if (jsonSchemaValidation) {

      LOG('\nJSON Schema option passed. Generating schema...');

      generatedSchema = await generateJsonSchema({
        additionalProperties: false,
        metadataReportJson: metadataReport
      });

      validationConfig = JSON.parse(await readFile(VALIDATION_CONFIG_FILE)) || {};

      LOG('JSON Schema generation complete!');
      
    }

    REPLICATION_STATE_SERVICE.setMetadataMap(metadataReport);

    // TODO: if scoring, need to group by similar resources/expansions
    // so we only hold one set of record hashes in memory at a time
    const requests = await prepareRequests({
      serviceRootUri,
      metadataReportJson: metadataReport,
      resourceName,
      expansions: expansionsArray,
      filter: prepareFilterExpression(filter, { originatingSystemId, originatingSystemName }),
      top,
      orderby,
      batchExpand
    });

    const startTime = new Date(),
      startTimeIsoTimestamp = startTime.toISOString();

    if (shouldSaveResults) {
      const resolvedPath = resolve(normalize(outputPath));
      if (!existsSync(resolvedPath)) {
        await mkdir(resolvedPath, { recursive: true });
      }
    }

    // Each resource and expansion will have its separate set of requests
    for await (const request of requests) {
      const { requestUri: initialRequestUri, resourceName } = request;

      // each item queried has its own set of requests
      try {
        // get top-level resource count if needed
        if (!REPLICATION_STATE_SERVICE.checkIfTopLevelResourceCountExists(resourceName)) {
          REPLICATION_STATE_SERVICE.setTopLevelResourceCount(
            resourceName,
            await fetchTopLevelResourceCount({
              resourceName,
              serviceRootUri,
              filter: prepareFilterExpression(filter, { originatingSystemId, originatingSystemName }),
              authService
            })
          );
        }

        for await (const {
          hasResults = false,
          hasError = false,
          responseJson = {},
          totalRecordsFetched = 0,
          requestUri,
          ...otherIteratorInfo
        } of replicationIterator({
            initialRequestUri,
            strategy,
            limit,
            maxPageSize,
            secondsDelayBetweenRequests,
            authService
          })) {
          try {
            //handle errors
            if (hasError) {
              const { error } = otherIteratorInfo;
              // some errors, like HTTP 429, might be able to be handled
              await handleError({ error, rateLimitedWaitTimeMinutes });
            } else if (hasResults) {
              if (jsonSchemaValidation) {
                schemaValidationResults =
                  validate({
                    version,
                    jsonPayload: responseJson,
                    errorMap: schemaValidationResults,
                    jsonSchema: generatedSchema,
                    resourceName,
                    validationConfig
                  }) ?? {};

                const {
                  stats: { totalErrors = 0 }
                } = schemaValidationResults ?? {};

                const hasValidationErrors = totalErrors > 0;

                if (hasValidationErrors) {
                  LOG_ERROR(`Schema validation errors found in the ${resourceName} payload!`);
                  if (strictMode) {
                    await writeSchemaValidationErrorReport({ outputPath, errorMap: schemaValidationResults });
                    if (throwOnError) {
                      const err = new Error(`Schema validation errors found in the ${resourceName} payload`);
                      err.schemaValidationResults = schemaValidationResults;
                      throw err;
                    }
                    LOG_ERROR('Exiting!');
                    process.exit(NOT_OK);
                  }
                }
              }

              // Yield to the event loop after validation so progress messages can be delivered
              await new Promise(resolve => setImmediate(resolve));

              if (shouldGenerateReports) {
                scorePayload({
                  ...request,
                  ...otherIteratorInfo,
                  requestUri,
                  jsonData: responseJson,
                  hasError,
                  replicationStateServiceInstance: REPLICATION_STATE_SERVICE
                });
              }

              if (shouldSaveResults) {
                REPLICATION_STATE_SERVICE.incrementResourcePageCount(resourceName);

                const resultsPath = buildOutputFilePath({ outputPath, isoTimestamp: startTimeIsoTimestamp, resourceName });
                await mkdir(resultsPath, { recursive: true });
                await writeFile(
                  resolve(normalize(join(resultsPath, `page-${REPLICATION_STATE_SERVICE.getResourcePageCount(resourceName)}.json`))),
                  JSON.stringify(responseJson)
                );
              }
            }

            if (!!limit && totalRecordsFetched >= limit) {
              LOG(`Reached specified record limit of ${limit}\n`);
              break;
            }
          } catch (err) {
            LOG_ERROR(err);
            return;
          }
        }
      } catch (err) {
        LOG_ERROR(err);
        return;
      }
    }

    if (shouldGenerateReports) {
      try {
        if (jsonSchemaValidation && schemaValidationResults?.stats?.totalErrors > 0) {
          await writeSchemaValidationErrorReport({ outputPath, errorMap: schemaValidationResults });
        } else {
          await writeAnalyticsReports({
            outputPath,
            version,
            serviceRootUri,
            replicationStateService: REPLICATION_STATE_SERVICE
          });
        }
      } catch (err) {
        LOG_ERROR(`Could not write report! ${err}`);
        if (throwOnError) throw err;
        process.exit(NOT_OK);
      }
    }

    if (fromCli) {
      getSystemRuntimeInfo({
        version,
        startTime,
        resourceAvailabilityMap: REPLICATION_STATE_SERVICE.getResourceAvailabilityMap()
      });
    }
  } catch (err) {
    LOG_ERROR(err);
    if (throwOnError) throw err;
    process.exit(NOT_OK);
  }
};

module.exports = {
  replicate
};
