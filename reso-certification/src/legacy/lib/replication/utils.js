'use strict';

const humanizeDuration = require('humanize-duration');
const { writeFile } = require('fs/promises');
const { resolve, join } = require('path');
const { createHash } = require('node:crypto');
const queryString = require('node:querystring');

// custom libs
const { sleep, NOT_OK, resolveFilePathSync } = require('../../common');

const { combineErrors } = require('../schema');

const REPLICATION_DIRECTORY_NAME = 'reso-replication-output',
  AVAILABILITY_REPORT_FILENAME = 'data-availability-report.json',
  AVAILABILITY_RESPONSES_FILENAME = 'data-availability-responses.json',
  SCHEMA_VALIDATION_REPORT_FILENAME = 'data-availability-schema-validation-errors.json';

const REPLICATION_STRATEGIES = Object.freeze({
  TOP_AND_SKIP: 'TopAndSkip',
  TIMESTAMP_ASC: 'TimestampAsc',
  TIMESTAMP_DESC: 'TimestampDesc',
  NEXT_LINK: 'NextLink'
});

const ERROR_TYPES = Object.freeze({
  HTTP: 'http',
  GENERAL: 'general'
});

const ERROR_CODES = Object.freeze({
  HTTP: {
    RATE_LIMITED: 429,
    UNAUTHORIZED: 401
  }
});

const DEFAULT_PAGE_SIZE = 100;

const NUM_SHORT_HASH_CHARACTERS = 16;

const UNKNOWN_ERROR_STRING = '<unknown>';

const DEFAULT_DD_VERSION = '2.0',
  POSTAL_CODE_FIELD_NAME = 'PostalCode',
  DEFAULT_TIMESTAMP_FIELD = 'ModificationTimestamp',
  ODATA_COUNT_PAYLOAD_KEY = '@odata.count';

/**
 * Hashes JSON data
 * @param {Object} jsonData data to hash
 * @returns hash of jsonData
 */
const hashJsonData = (jsonData, useFullHashes = false) => {
  try {
    // Use sha256 instead of sha3-256 for compatibility with Electron's BoringSSL
    const hash = createHash('sha256').update(JSON.stringify(jsonData)).digest('hex');

    //use shortened hashes by default
    return useFullHashes ? hash : hash.slice(0, NUM_SHORT_HASH_CHARACTERS - 1);
  } catch (err) {
    console.log(err);
    return null;
  }
};

/**
 * Extracts values from JSON Data
 *
 * @param {Object} jsonData
 * @returns an array of records
 */
const extractValues = (jsonData = {}) => {
  if (jsonData) {
    // try parsing as OData value collection with optional context properties
    const { value = [] } = jsonData;

    if (value && Array.isArray(value)) {
      return value;
    } else if (Object.values(jsonData)?.length) {
      // if data is a single item, return as array
      return [jsonData];
    } else {
      return [];
    }
  } else {
    return [];
  }
};

/**
 * Gets type metadata information from the given data
 * @param {Object} fieldData metadata information for the given field
 * @returns an object with various type information populated
 */
const getFieldTypeInfo = (fieldData = {}) => {
  return {
    isLookupField: !!fieldData?.lookupValues,
    isComplexType: !!fieldData?.isComplexType,
    isCollection: !!fieldData?.isCollection,
    type: fieldData?.type
  };
};

/**
 * Gets the timestamp bounds for a page of records
 * @param {Object} jsonData data to find timestamps for
 * @param {*} timestampFieldName timestamp field
 * @returns min and max timestamps
 * @throws if the timestamps in the records cannot be parsed
 */
const getTimestampBounds = (jsonData = {}, timestampFieldName) => {
  const { value: records = [] } = jsonData;

  return records.reduce(
    (acc, record) => {
      if (record?.[timestampFieldName]) {
        try {
          const timestamp = new Date(record[timestampFieldName]).toISOString();
          if (new Date(timestamp) < new Date(acc.minIsoTimestamp)) {
            acc.minIsoTimestamp = timestamp;
          }

          if (new Date(timestamp) > new Date(acc.maxIsoTimestamp)) {
            acc.maxIsoTimestamp = timestamp;
          }
          return acc;
        } catch {
          throw new Error('Could not parse timestamp!');
        }
      }
    },
    {
      minIsoTimestamp: new Date().toISOString(),
      maxIsoTimestamp: new Date(0).toISOString()
    }
  );
};

/**
 * Computes the last ISO timestamp with the given data
 * @param {Object} params things needed to compute the timestamp
 * @returns timestamp used to compute the last timestamp
 */
const computeLastIsoTimestamp = ({ jsonData = {}, lastIsoTimestamp, strategy, timestampFieldName }) => {
  // update timestamps if strategy uses timestamps
  const { minIsoTimestamp = null, maxIsoTimestamp = null } = getTimestampBounds(jsonData, timestampFieldName) ?? {};

  if (strategy === REPLICATION_STRATEGIES.TIMESTAMP_ASC) {
    if (lastIsoTimestamp === maxIsoTimestamp) {
      //timestamp collision - add a little time to the timestamp
      return new Date(new Date(maxIsoTimestamp) + 1).toISOString();
    } else {
      return maxIsoTimestamp;
    }
  }

  if (strategy === REPLICATION_STRATEGIES.TIMESTAMP_DESC) {
    if (lastIsoTimestamp === minIsoTimestamp) {
      // timestamp collision - subtract a little time from the timestamp
      return new Date(new Date(minIsoTimestamp) - 1).toISOString();
    } else {
      return minIsoTimestamp;
    }
  }
};

/**
 * Ensures that keys exist and are inserted into the map with the correct defaults
 * @param {Object} modelMapOptions resource map and model information
 */
const ensureModelAvailabilityMapIsInitialized = ({ resourceAvailabilityMap, modelName, parentModelName, dateField }) => {
  const isExpansion = !!modelName && !!parentModelName;

  if (isExpansion) {
    if (!resourceAvailabilityMap?.[parentModelName]) {
      resourceAvailabilityMap[parentModelName] = {
        resourceName: parentModelName,
        dateField,
        dateHigh: null,
        dateLow: null,
        // field availability map is fieldName and frequency
        fieldAvailabilityMap: {},
        expandedResourceMap: {}
      };
    }

    if (!resourceAvailabilityMap?.[parentModelName]?.expandedResourceMap?.[modelName]) {
      resourceAvailabilityMap[parentModelName].expandedResourceMap[modelName] = {
        resourceName: modelName,
        parentResourceName: parentModelName,
        dateField,
        dateHigh: null,
        dateLow: null,
        fieldAvailabilityMap: {}
      };
    }
  } else {
    // add item to resource availability map if not present
    if (!resourceAvailabilityMap?.[modelName]) {
      resourceAvailabilityMap[modelName] = {
        resourceName: modelName,
        dateField,
        dateHigh: null,
        dateLow: null,
        // field availability map is fieldName and frequency
        fieldAvailabilityMap: {},
        expandedResourceMap: {}
      };
    }
  }
};

/**
 * Increments the frequency for the given fieldName and lookupValue
 * @param {Object} availabilityMapOptions availability map and data element info
 */
const incrementLookupValueFrequency = ({ availabilityMap = {}, fieldName, lookupValue }) => {
  if (availabilityMap && Object.values(availabilityMap) && !availabilityMap?.fieldAvailabilityMap?.[fieldName]?.lookupMap?.[lookupValue]) {
    availabilityMap.fieldAvailabilityMap[fieldName].lookupMap[lookupValue] = {
      lookupValue,
      frequency: 0
    };
  }

  availabilityMap.fieldAvailabilityMap[fieldName].lookupMap[lookupValue].frequency++;
};

/**
 * Normalizes records to process so that all expansions are on the same level as the main resource
 *
 * Takes a hash that allows parent resources to not be duplicated when fetched with multiple child expansions
 *
 * @param {Object} params Contains a record with potentially multiple expanded records to process
 * @returns a flattened list of all resources and expansions to process
 */
const normalizeRecords = ({ expansionInfo = [], record, resourceName: parentModelName }) => {
  if (!record || !parentModelName) return [];

  try {
    const recordsToProcess = [];
    if (expansionInfo && expansionInfo?.length) {
      // flatten expansions into main records
      recordsToProcess.push(
        ...expansionInfo.reduce((acc, { fieldName, modelName }) => {
          const { [fieldName]: expandedData, ...remainingData } = record;

          if (expandedData) {
            const expandedRecords = Array.isArray(expandedData) ? [...expandedData] : [expandedData];
            expandedRecords.map(expandedRecord => {
              acc.push({
                modelName,
                parentModelName,
                fieldName,
                isExpansion: true,
                record: expandedRecord
              });
            });
          }

          acc.push({
            modelName: parentModelName,
            isExpansion: false,
            record: remainingData
          });

          return acc;
        }, [])
      );
    } else {
      recordsToProcess.push({
        modelName: parentModelName,
        isExpansion: false,
        record
      });
    }

    return recordsToProcess;
  } catch (err) {
    console.error(err);
  }

  return [];
};

/**
 * Scores a payload with the given data
 * @param {Object} data options to be extracted from the caller
 *
 * Note that this function mutates the resourceAvailabilityMap, which
 * the caller would pass in and have declared in the calling function
 */
const scorePayload = ({
  requestUri,
  jsonData,
  resourceName,
  responseTimeMs,
  startTime,
  stopTime,
  responseBytes,
  dateField = DEFAULT_TIMESTAMP_FIELD,
  expansionInfo,
  hasError,
  strategy,
  replicationStateServiceInstance: REPLICATION_STATE_SERVICE
}) => {
  
  if (!REPLICATION_STATE_SERVICE) throw new Error('Replication state service instance is null or undefined!');
  const { hashExists, addOrIncrementHashValue, getResourceAvailabilityMap, getMetadataMap } = REPLICATION_STATE_SERVICE;

  const records = extractValues(jsonData);

  // return if there's nothing to process
  if (!(records && Array.isArray(records) && records?.length)) return;

  let recordCount = 0,
    expandedRecordCount = 0;

  // Score records
  records.forEach(record => {
    // process both parent record and expanded data
    (
      normalizeRecords({ expansionInfo, record, resourceName }) || []
    ).forEach(({ isExpansion = false, modelName, parentModelName, record: normalizedRecord = {} } = {}) => {

      // duplicate detection - necessary for both parent resources and their expansions as we can
      // resample both resources and their expansions in testing using different replication strategies
      const normalizedRecordHash = hashJsonData({ modelName, parentModelName, normalizedRecord });
      if (!hashExists(normalizedRecordHash)) {
        addOrIncrementHashValue(normalizedRecordHash);

        ensureModelAvailabilityMapIsInitialized({
          resourceAvailabilityMap: getResourceAvailabilityMap(),
          modelName,
          parentModelName,
          dateField
        });

        const availabilityMap = isExpansion
          ? getResourceAvailabilityMap()[parentModelName].expandedResourceMap[modelName]
          : getResourceAvailabilityMap()[modelName];

        Object.entries(normalizedRecord).forEach(([fieldName, value]) => {
          // init if the field if it doesn't exist
          if (!availabilityMap?.fieldAvailabilityMap?.[fieldName]) {
            availabilityMap.fieldAvailabilityMap[fieldName] = {
              resourceName: modelName,
              fieldName,
              frequency: 0
            };
          }

          // if there's a value, it can either be a primitive, or array/object
          const { isPrimitive, isArray, isObject } = isObjectOrArrayOrPrimitive(value);
          const { isLookupField = false, type: fieldDataType } = getFieldTypeInfo(
            getMetadataMap()?.[modelName]?.[fieldName]
          );

          if (value) {
            // increment parent field availability
            availabilityMap.fieldAvailabilityMap[fieldName].frequency++;

            if (isLookupField) {
              /*
                  resourceName and fieldName are already contained
                  in the map, so we'll omit them at this point to save space
                  and reconstitute them in the consolidateResults function

                  {
                    "resourceName": "Property",
                    "fieldName": "FireplaceFeatures",
                    "lookupValue": "Pellet Stove",
                    "frequency": 206
                  },
                */
              if (!availabilityMap?.fieldAvailabilityMap?.[fieldName]) {
                // init if the lookup map for the field if it doesn't exist yet for some reason
                availabilityMap.fieldAvailabilityMap[fieldName] = {
                  resourceName: modelName,
                  fieldName,
                  frequency: 0,
                  lookupMap: {}
                };
              } else if (!availabilityMap?.fieldAvailabilityMap?.[fieldName]?.lookupMap) {
                // otherwise just init a new lookup map
                availabilityMap.fieldAvailabilityMap[fieldName].lookupMap = {};
              }

              // lookup values can either be single items, arrays, or comma-separated strings
              // the metadata validation process will enforce the correct format in each case
              if (isArray) {
                // arrays are for collections of string or Edm.EnumType enumerations
                // which can be processed as-is
                value.forEach(lookupValue => incrementLookupValueFrequency({ availabilityMap, fieldName, lookupValue }));
              } else if (fieldDataType !== 'Edm.String' && typeof value === 'string' && value?.includes(',')) {
                // Process OData isFlags enumeration
                value.split(',').forEach(lookupValue => incrementLookupValueFrequency({ availabilityMap, fieldName, lookupValue }));
              } else {
                // otherwise, process single value
                incrementLookupValueFrequency({ availabilityMap, fieldName, lookupValue: value });
              }
            } else if (isArray) {
              //console.debug('TODO: need to process arrays! value: ' + JSON.stringify(value));
            } else if (isPrimitive || isObject) {
              // some fields need additional treatments
              processSpecialFields({ availabilityMap, fieldName, dateField, value });
            } else {
              console.debug('Found data with a type other than primitive, object, or array!');
            }
          }
        });

        if (!availabilityMap?.numUniqueRecordsFetched) {
          availabilityMap.numUniqueRecordsFetched = 0;
        }

        availabilityMap.numUniqueRecordsFetched++;
      } else {
        addOrIncrementHashValue(normalizedRecordHash);
      }

      if (isExpansion) {
        expandedRecordCount++;
      } else {
        recordCount++;
      }
    });
  });

  // handle responses
  if (!hasError) {
    REPLICATION_STATE_SERVICE.getResponses().push({
      requestUri,
      startTime,
      stopTime,
      responseTimeMs,
      responseBytes,
      resourceName,
      recordCount,
      expandedRecordCount: expansionInfo ? expandedRecordCount : undefined,
      expansionInfo,
      strategy,
      hasError: hasError || undefined
    });
  }
};

/**
 * Updates various properties in the given availabilityMap depending on whether
 * the current field is something that needs to be processed
 *
 * @param {Object} args an object containing the availabilityMap to update, as well as other related params
 *
 */
const processSpecialFields = ({ availabilityMap, fieldName, dateField, value } = {}) => {
  if (!value) return;

  // Update resource max and min dates
  if (fieldName === dateField) {
    const dateValue = new Date(value),
      currentDateLowValue = availabilityMap?.dateLow ? new Date(availabilityMap.dateLow) : null,
      currentDateHighValue = availabilityMap?.dateHigh ? new Date(availabilityMap.dateHigh) : null;

    if (dateValue) {
      if (currentDateLowValue) {
        availabilityMap.dateLow = new Date(Math.min(currentDateLowValue, dateValue)).toISOString();
      } else {
        availabilityMap.dateLow = dateValue.toISOString();
      }

      if (currentDateHighValue) {
        availabilityMap.dateHigh = new Date(Math.max(currentDateHighValue, dateValue)).toISOString();
      } else {
        availabilityMap.dateHigh = dateValue.toISOString();
      }
    }
  }

  if (value?.length && fieldName === POSTAL_CODE_FIELD_NAME) {
    if (!availabilityMap?.postalCodes) {
      availabilityMap.postalCodes = new Set();
    }
    availabilityMap.postalCodes.add(value);
  }
};

/**
 * Determines whether the given value is an object, array, or primitive
 * @param {Object} value to test
 * @returns object with misc. properties set
 */
const isObjectOrArrayOrPrimitive = value => {
  const isObject = typeof value === 'object',
    isArray = Array.isArray(value),
    isPrimitive = value === null || !(isObject || isArray);

  return {
    isObject,
    isArray,
    isPrimitive
  };
};

/*

   "averageResponseBytes": 1731342,
      "medianResponseBytes": 1731342,
      "stdDevResponseBytes": 0,
      "averageResponseTimeMs": 573,
      "medianResponseTimeMs": 573,
      "stdDevResponseTimeMs": 0,
      "numRecordsFetched": 100,
      "pagesFetched": 1,

*/

/**
 * Processes data, keyed by resources, fields, and enumerations, into its
 * first round of aggregation
 *
 *       Current Resource Aggregation
 *
 *       {
 *         "resourceName": "Office",
 *         "recordCount": 1751,
 *         "numRecordsFetched": 1709,
 *         "numSamples": 18,
 *         "pageSize": 100,
 *         "averageResponseBytes": 106953,
 *         "averageResponseTimeMillis": 547,
 *         "dateField": "ModificationTimestamp",
 *         "dateLow": "2019-08-14T13:59:06Z",
 *         "dateHigh": "2023-08-28T13:46:24Z",
 *         "keyFields": [
 *           "OfficeKey"
 *         ]
 *       }, ...
 *
 *
 * @param {Map} resourceAvailabilityMap map containing availability data
 * @returns consolidated availability data set in canonical resources, fields, lookups format
 */
const consolidateResults = ({ resourceAvailabilityMap = {}, responses = [], topLevelResourceCounts = {} }) => {
  const consolidatedResourceAvailabilityMap = Object.values(resourceAvailabilityMap ?? {}).reduce(
    (acc, { resourceName, fieldAvailabilityMap = {}, expandedResourceMap = {}, postalCodes, ...remainingResourceData }) => {
      const resourceData = { resourceName, ...remainingResourceData };

      // get top-level record count for the item
      resourceData.recordCount = topLevelResourceCounts?.[resourceName]?.count ?? 0;

      if (postalCodes?.size) {
        resourceData.postalCodes = [...postalCodes];
      }

      // handle fields
      Object.values(fieldAvailabilityMap).forEach(({ lookupMap = {}, ...remainingFieldData } = {}) => {
        acc.fields.push(remainingFieldData);

        if (lookupMap && Object.values(lookupMap)?.length) {
          const { resourceName: fieldResourceName, fieldName } = remainingFieldData;
          Object.values(lookupMap).forEach(lookupValueData => {
            acc.lookupValues.push({
              resourceName: fieldResourceName,
              fieldName,
              ...lookupValueData
            });
          });
        }
      });

      // handle expansions
      Object.values(expandedResourceMap).forEach(
        ({
          resourceName: expandedResourceName,
          parentResourceName,
          fieldAvailabilityMap: expandedFieldAvailabilityMap,
          postalCodes: expandedPostalCodes,
          ...remainingExpandedFieldData
        }) => {
          if (!resourceData?.expansions?.length) {
            resourceData.expansions = [];
          }

          const expandedData = {
            ...remainingExpandedFieldData,
            resourceName: expandedResourceName
          };

          if (expandedPostalCodes?.size) {
            expandedData.postalCodes = [...expandedPostalCodes];
          }

          resourceData.expansions.push(expandedData);

          Object.values(expandedFieldAvailabilityMap).forEach(({ lookupMap = {}, ...remainingFieldData } = {}) => {
            acc.fields.push({ ...remainingFieldData, parentResourceName });

            if (lookupMap && Object.values(lookupMap)?.length) {
              const { resourceName, fieldName } = remainingFieldData;
              Object.values(lookupMap).forEach(lookupValueData => {
                acc.lookupValues.push({
                  resourceName,
                  parentResourceName,
                  fieldName,
                  ...lookupValueData
                });
              });
            }
          });
        }
      );

      acc.resources.push(resourceData);

      return acc;
    },
    {
      resources: [],
      fields: [],
      lookupValues: []
    }
  );

  return calculateResponseStats({ resourceAvailabilityMap: consolidatedResourceAvailabilityMap, responses });
};

/**
 * Calculates stats on the set of responses from the testing run
 * @param {Array} responses set of responses to consolidate
 * @returns aggregated responses
 */
const calculateResponseStats = ({ resourceAvailabilityMap = {}, responses = [] }) => {
  const tallies = responses.reduce(
    (acc, { responseTimeMs, responseBytes, resourceName, recordCount, expandedRecordCount, expansionInfo = [] }) => {
      const [expandedItem = {}] = expansionInfo,
        isExpansion = !!(expandedItem && expandedItem?.modelName);

      //initialize top-lever resource item if not present
      if (!acc[resourceName]) {
        acc[resourceName] = {
          responseTimes: [],
          responseBytes: [],
          recordCounts: []
        };
      }

      if (isExpansion) {
        const expandedModelName = expandedItem.modelName;

        if (expandedModelName && !acc[resourceName]?.expansions?.[expandedModelName]) {
          if (!acc?.[resourceName]?.expansions) {
            acc[resourceName].expansions = {};
          }

          if (!acc?.[resourceName]?.expansions?.[expandedModelName]) {
            acc[resourceName].expansions[expandedModelName] = {
              responseTimes: [],
              responseBytes: [],
              recordCounts: [],
              expandedRecordCounts: []
            };
          }
        }

        acc[resourceName].expansions[expandedModelName].responseTimes.push(responseTimeMs);
        acc[resourceName].expansions[expandedModelName].responseBytes.push(responseBytes);
        acc[resourceName].expansions[expandedModelName].recordCounts.push(recordCount);
        acc[resourceName].expansions[expandedModelName].expandedRecordCounts.push(expandedRecordCount);
      } else {
        acc[resourceName].responseTimes.push(responseTimeMs);
        acc[resourceName].responseBytes.push(responseBytes);
        acc[resourceName].recordCounts.push(recordCount);
      }

      return acc;
    },
    {}
  );

  const { resources = [], fields = [], lookupValues = [], ...remainingReport } = resourceAvailabilityMap;

  const processedResources = resources.map(({ resourceName, expansions = [], ...remainingResourceInfo }) => {
    const resourceResponseBytes = tallies?.[resourceName]?.responseBytes ?? [],
      resourceResponseTimes = tallies?.[resourceName]?.responseTimes ?? [],
      resourceRecordCounts = tallies?.[resourceName]?.recordCounts ?? [],
      resourcePagesFetched = tallies?.[resourceName]?.recordCounts?.length ?? 0;

    const resourceStats = {
      // payload size
      averageResponseBytes: calculateMean(resourceResponseBytes),
      medianResponseBytes: calculateMedian(resourceResponseBytes),
      stdDevResponseBytes: calculateStdDev(resourceResponseBytes),

      // response times
      averageResponseTimeMs: calculateMean(resourceResponseTimes),
      averageResponseTimeMillis: calculateMean(resourceResponseTimes) /* support old value for now */,
      medianResponseTimeMs: calculateMedian(resourceResponseTimes),
      stdDevResponseTimeMs: calculateStdDev(resourceResponseTimes),

      // record count
      numRecordsFetched: calculateSum(resourceRecordCounts),

      // pages fetched
      numSamples: resourcePagesFetched,

      // page size
      pageSize: Math.max(...resourceRecordCounts) ?? 0
    };

    const expansionStats = expansions?.length
      ? expansions.map(({ resourceName: expandedResourceName, ...remainingExpandedData }) => {
        const expandedResponseBytes = tallies?.[resourceName]?.expansions?.[expandedResourceName]?.responseBytes ?? [],
          expandedResponseTimes = tallies?.[resourceName]?.expansions?.[expandedResourceName]?.responseTimes ?? [],
          expandedRecordCounts = tallies?.[resourceName]?.expansions?.[expandedResourceName]?.expandedRecordCounts ?? [];

        return {
          resourceName: expandedResourceName,
          ...remainingExpandedData,

          // payload size
          averageResponseBytes: calculateMean(expandedResponseBytes),
          medianResponseBytes: calculateMedian(expandedResponseBytes),
          stdDevResponseBytes: calculateStdDev(expandedResponseBytes),

          // response times
          averageResponseTimeMs: calculateMean(expandedResponseTimes),
          averageResponseTimeMillis: calculateMean(resourceResponseTimes) /* support old value for now */,
          medianResponseTimeMs: calculateMedian(expandedResponseTimes),
          stdDevResponseTimeMs: calculateStdDev(expandedResponseTimes),

          // record counts
          numRecordsFetched: calculateSum(resourceRecordCounts),
          numExpandedRecordsFetched: calculateSum(expandedRecordCounts),

          // pages fetched - expanded is the same as the parent resource
          numSamples: resourcePagesFetched
        };
      })
      : undefined;

    return {
      resourceName,
      ...remainingResourceInfo,
      ...resourceStats,
      expansions: expansionStats || undefined
    };
  });

  //return a new report with the familiar order preserved
  return { ...remainingReport, resources: processedResources, fields, lookupValues };
};

/**
 * Creates a pleasing report when running on the command line
 * @param {Object} resourceAvailabilityMap availability stats collected during run
 * @returns high-level stats for reporting
 */
const createRuntimeAvailabilityStats = (resourceAvailabilityMap = {}) =>
  Object.entries(resourceAvailabilityMap).reduce(
    (acc, [, { isExpansion = false, responses = [], numRecordsFetched = 0 }]) => {
      if (isExpansion) {
        acc.expandedRecordCount += numRecordsFetched;
      } else {
        acc.totalRecordCount += numRecordsFetched;
      }

      responses.forEach(({ responseTimeMs = 0 }) => {
        if (!isExpansion) {
          acc.totalRequests++;
          acc.totalResponseTimeMs += responseTimeMs;
        }
        return acc;
      });
      return acc;
    },
    {
      totalRequests: 0,
      totalResponseTimeMs: 0,
      totalRecordCount: 0,
      expandedRecordCount: 0
    }
  );

/**
 * Writes a schema validation report to the filesystem
 * @param {Object} errorMap a map containing JSON Schema validation errors
 */
const writeSchemaValidationErrorReport = async ({ outputPath, errorMap = {} }) => {
  const {
    stats: { totalErrors = 0 }
  } = errorMap ?? {};
  if (totalErrors > 0) {
    const resolvedPath = resolveFilePathSync({ outputPath, filename: SCHEMA_VALIDATION_REPORT_FILENAME });
    await writeFile(resolvedPath, JSON.stringify(combineErrors(errorMap)));
    console.log(`Schema validation errors written to: ${resolvedPath}`);
  }
};

/**
 * Writes a data-availability-report.json file for the given version and availability data
 *
 * @param {Object} params
 */
const writeAnalyticsReports = async ({ outputPath, version, serviceRootUri, replicationStateService: REPLICATION_STATE_SERVICE }) => {
  try {
    const generatedOn = new Date().toISOString();

    // add additional line
    console.log();

    const resolvedPath = resolveFilePathSync({ outputPath, filename: AVAILABILITY_RESPONSES_FILENAME });

    // Compute summary stats from the request trace (Welford's online algorithm)
    const allResponses = REPLICATION_STATE_SERVICE.getResponses();
    let wCount = 0, wMean = 0, wM2 = 0;
    let totalBytes = 0, totalRecords = 0;
    // Per-resource Welford state for per-resource anomaly detection.
    // Parallel implementation in legacy/lib/replication/index.js
    // (streaming variant) — kept in sync. See #206.
    const byResource = {};
    for (const r of allResponses) {
      const rt = r.responseTimeMs ?? 0;
      totalBytes += r.responseBytes ?? 0;
      totalRecords += r.recordCount ?? 0;
      if (rt <= 0) continue;
      wCount++;
      const delta = rt - wMean;
      wMean += delta / wCount;
      wM2 += delta * (rt - wMean);
      const rn = r.resourceName ?? 'unknown';
      if (!byResource[rn]) byResource[rn] = { count: 0, mean: 0, M2: 0 };
      const s = byResource[rn];
      s.count++;
      const rDelta = rt - s.mean;
      s.mean += rDelta / s.count;
      s.M2 += rDelta * (rt - s.mean);
    }
    const stddev = wCount >= 2 ? Math.sqrt(wM2 / wCount) : 0;
    // Per-resource one-sided anomaly count. Resources with <3 samples
    // don't get flagged. anomalyCount is the rollup; anomaliesByResource
    // carries the per-resource breakdown for the items-screen / UI tooltip.
    let anomalyCount = 0;
    const anomaliesByResource = [];
    for (const rn of Object.keys(byResource)) {
      const s = byResource[rn];
      if (s.count < 3) continue;
      const rStddev = Math.sqrt(s.M2 / s.count);
      let resAnomalies = 0, maxMs = 0, maxDeltaMs = 0;
      for (const r of allResponses) {
        if ((r.resourceName ?? 'unknown') !== rn) continue;
        const rt = r.responseTimeMs ?? 0;
        if (rt <= 0) continue;
        if (rt - s.mean > 2 * rStddev) {
          resAnomalies++;
          if (rt > maxMs) {
            maxMs = rt;
            maxDeltaMs = rt - s.mean;
          }
        }
      }
      if (resAnomalies > 0) {
        anomaliesByResource.push({
          resourceName: rn,
          meanMs: Math.round(s.mean),
          count: resAnomalies,
          maxMs: Math.round(maxMs),
          maxDeltaMs: Math.round(maxDeltaMs),
        });
        anomalyCount += resAnomalies;
      }
    }

    // write responses report
    await writeFile(
      resolvedPath,
      JSON.stringify({
        description: 'RESO Data Availability Responses',
        version,
        generatedOn,
        serviceRootUri,
        stats: {
          totalRequests: wCount,
          totalRecords,
          totalBytes,
          meanResponseMs: Math.round(wMean),
          stddevMs: Math.round(stddev),
          anomalyCount,
          anomaliesByResource,
        },
        responses: allResponses.map(({ requestUri, ...otherResponseInfo }) => {
          return {
            requestUri: requestUri.replace(serviceRootUri, ''),
            ...otherResponseInfo
          };
        })
      })
    );

    console.log(`Response info written to ${resolvedPath}`);

    const resolvedAvailabilityPath = resolveFilePathSync({ outputPath, filename: AVAILABILITY_REPORT_FILENAME });

    // write DA report
    await writeFile(
      resolvedAvailabilityPath,
      JSON.stringify({
        description: 'RESO Data Availability Report',
        version,
        generatedOn,
        ...consolidateResults({
          resourceAvailabilityMap: REPLICATION_STATE_SERVICE.getResourceAvailabilityMap(),
          responses: REPLICATION_STATE_SERVICE.getResponses(),
          topLevelResourceCounts: REPLICATION_STATE_SERVICE.getTopLevelResourceCounts()
        })
      })
    );

    console.log(`Availability results written to ${resolvedAvailabilityPath}`);
  } catch (err) {
    console.error(err);
  }
};

/**
 * Displays info on the console when a job is run
 * @param {Object} resourceAvailabilityMap map from availability testing run
 */
const getSystemRuntimeInfo = ({ startTime, version, resourceAvailabilityMap = {} }) => {
  console.log(
    `\nRESO Replication Client completed in ${humanizeDuration(Date.now() - startTime, { round: false })}! DD Version: ${version}`
  );
  const runtimeStats = createRuntimeAvailabilityStats(resourceAvailabilityMap);
  return (
    `Total requests: ${runtimeStats.totalRequests}, ` +
    `Average response time: ${humanizeDuration(runtimeStats.totalResponseTimeMs / (runtimeStats.totalRequests || 1))}, ` +
    `Records fetched: ${runtimeStats.totalRecordCount}${
      runtimeStats.expandedRecordCount ? `, Expanded records: ${runtimeStats.expandedRecordCount}` : ''
    }\n`
  );
};

/**
 * Processes an HTTP error response from the Fetch API
 * @param {Response} response the HTTP error response from the Fetch API
 * @returns relevant error data
 */
const processHttpErrorResponse = ({ status, statusText }) => {
  return {
    statusCode: status,
    message: statusText
  };
};

/**
 *
 * Parses the OData resource name from the given URI
 *
 * Example: https://some.api.com/v2/Property
 *
 * @param {String} requestUri the string for the OData request URI
 * @returns OData resource name or null
 */
const parseResourceNameFromODataRequestUri = (requestUri = '') => {
  try {
    // This always works, because if the property is an expansion rather
    // than a top level resource, like a navigation property: e.g. /Property/Media or /Property('123')/Media
    // then the resource name is Media
    const [resourceName = null] = new URL(requestUri).pathname.split('/').slice(-1);
    return resourceName;
  } catch (err) {
    console.error(err);
    return null;
  }
};

/**
 * Calculates the size of the given JSON Data
 * @param {Object} jsonData JSON data
 * @returns size of given JSON Data or 0 if it couldn't be processed
 */
const calculateJsonSize = jsonData => {
  try {
    return Buffer.byteLength(JSON.stringify(jsonData));
  } catch {
    console.error('Could not calculate size of JSON Data');
    return 0;
  }
};

/**
 * Builds a path to use when saving results
 *
 * @param {String} outputPath the target directory in which to save results (current by default)
 * @param {String} resourceName the name of the Data Dictionary resource whose files are being saved
 * @returns an operating system dependent path to save replication data with
 */
const buildOutputFilePath = ({ outputPath, isoTimestamp = new Date().toISOString(), resourceName }) => {
  if (!outputPath) {
    throw new Error('Missing outputPath!');
  }

  if (!resourceName) {
    throw new Error('Missing resourceName!');
  }

  return resolve(join(outputPath, REPLICATION_DIRECTORY_NAME, resourceName, isoTimestamp.replaceAll(':', '-')));
};

/**
 * Calculates the mean for an array of numbers
 * @param {Array} numbers array of numbers
 * @returns the mean value
 */
const calculateMean = (numbers = []) => {
  if (!numbers || !Array.isArray(numbers) || !numbers?.length) {
    return 0;
  }
  const n = numbers.length;
  return numbers.reduce((a, b) => a + b) / n;
};

/**
 * Sums a list of numbers
 * @param {Array} numbers list of numbers to sum
 * @returns sum of list of numbers
 */
const calculateSum = (numbers = []) => {
  if (!numbers || !Array.isArray(numbers) || !numbers?.length) {
    return 0;
  }

  return numbers.reduce((acc, cur) => (acc += cur), 0);
};

/**
 * Calculates the standard deviation for an array of numbers
 * @param {Array} numbers array of numbers
 * @returns the standard deviation
 */
const calculateStdDev = (numbers = []) => {
  if (!numbers || !Array.isArray(numbers) || !numbers?.length) {
    return 0;
  }

  const n = numbers.length,
    mean = calculateMean(numbers);

  return Math.sqrt(numbers.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
};

/**
 * Calculates median of an array of numbers
 * @param {Array} numbers array of numbers
 * @returns median value
 */
const calculateMedian = (numbers = []) => {
  if (!numbers || !Array.isArray(numbers) || !numbers?.length) {
    return 0;
  }

  const sorted = Array.from(numbers).sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
};

/**
 * Handles error objects
 * @param {Object} error the error to process
 */
const handleError = async ({ error = {}, rateLimitedWaitTimeMinutes = 60 }) => {
  const { statusCode, message, errorType, error: errorData } = error;

  const getErrorMessage = (errorType, errorString) => `${errorType} error occurred! Error: ${errorString || UNKNOWN_ERROR_STRING}`;

  if (errorType === ERROR_TYPES.HTTP) {
    const statusCodeInt = parseInt(statusCode),
      errorMessage = `HTTP request error! Status code: ${statusCode}, message: '${message}'`;

    // some HTTP errors can potentially be handled
    console.error(errorMessage);

    if (statusCodeInt === ERROR_CODES.HTTP.UNAUTHORIZED) {
      process.exit(NOT_OK);
    }

    if (statusCodeInt === ERROR_CODES.HTTP.RATE_LIMITED) {
      console.warn(`  -> ${new Date().toISOString()} - Waiting ${rateLimitedWaitTimeMinutes}m before making the next request...`);
      await sleep(rateLimitedWaitTimeMinutes * 60 * 1000);
    }

    return { errorType, statusCode, message };
  } else {
    const UNKNOWN_ERROR_STRING = 'unknown';

    // throw an error for all other errors
    let errorString = null;
    try {
      if (errorData) {
        errorString = errorData?.length
          ? JSON.stringify(JSON.parse(errorData))
          : (errorData?.toString && errorData?.toString()) || UNKNOWN_ERROR_STRING;
      } else {
        errorString = UNKNOWN_ERROR_STRING;
        console.error(getErrorMessage(errorType, errorString));
      }
    } catch (err) {
      throw new Error(err);
    }
  }
};

/**
 * Creates a set of requests from a RESO metadata-report.json file
 *
 * TODO: allow resources and expansions to be passed in their own config
 *
 * @param {Object} config Service Root URL and metadata report, and some optional OData query options
 * @returns a list of requests, which consist of requestUri, resourceName, and expansionInfo
 */
const createRequestsFromMetadataReport = ({ serviceRootUri, metadataReportJson = {}, filter, top, orderby, batchExpand = false }) => {
  const { fields = [] } = metadataReportJson;

  // Collect resources and their expansions
  const resourceExpansions = fields.reduce(
    (acc, { resourceName, fieldName, isExpansion, typeName: modelName }) => {
      if (!acc.resources.has(resourceName)) {
        acc.resources.add(resourceName);
        acc.resourceList.push(resourceName);
      }

      if (isExpansion && !acc.expansionKeys.has(resourceName + fieldName)) {
        acc.expansionKeys.add(resourceName + fieldName);
        if (!acc.expansionsByResource[resourceName]) {
          acc.expansionsByResource[resourceName] = [];
        }
        acc.expansionsByResource[resourceName].push({ fieldName, modelName });
      }

      return acc;
    },
    {
      resources: new Set(),
      expansionKeys: new Set(),
      resourceList: [],
      expansionsByResource: {}
    }
  );

  const requests = [];

  // Top-level resource requests (no expansions)
  for (const resourceName of resourceExpansions.resourceList) {
    requests.push({
      requestUri: createODataRequestUri({ serviceRootUri, resourceName, filter, top, orderby }),
      resourceName,
      expansionInfo: undefined
    });
  }

  // Expansion requests: batched or one-at-a-time
  for (const resourceName of resourceExpansions.resourceList) {
    const expansions = resourceExpansions.expansionsByResource[resourceName] || [];
    if (expansions.length === 0) continue;

    if (batchExpand) {
      // All expansions in a single $expand request
      requests.push({
        requestUri: createODataRequestUri({ serviceRootUri, resourceName, expansionInfo: expansions, filter, top, orderby }),
        resourceName,
        expansionInfo: expansions
      });
    } else {
      // One request per expansion (original behavior)
      for (const expansion of expansions) {
        requests.push({
          requestUri: createODataRequestUri({ serviceRootUri, resourceName, expansionInfo: [expansion], filter, top, orderby }),
          resourceName,
          expansionInfo: [expansion]
        });
      }
    }
  }

  return requests;
};

/**
 * Creates a request from command-line params
 * @param {Object} params Command-line parameters such as serviceRootUri and resourceName
 * @returns a request, which consists of requestUri, resourceName, and expansionInfo
 */
const createRequestFromParameters = ({ serviceRootUri, resourceName, expansions = [], filter, top, orderby }) => {
  const expansionInfo =
    expansions && expansions?.length
      ? expansions.map(fieldName => {
        return {
          fieldName
          /* TODO: look up type info from reference metadata, when possible */
        };
      })
      : undefined;

  return {
    requestUri: createODataRequestUri({ serviceRootUri, resourceName, expansionInfo, filter, top, orderby }),
    resourceName,
    expansionInfo
  };
};

/**
 *  Creates an OData request url string with the given parameters
 *
 * @param {Object} args parts of the URL and query options
 * @returns an OData request URL as a string
 */
const createODataRequestUri = ({ serviceRootUri, resourceName, expansionInfo = [], filter, top, orderby }) => {
  // TODO: sanitize any existing parameters
  // const { $select, $top, $filter, $orderby } = odataQueryOptions;
  try {
    const url = new URL(serviceRootUri),
      searchParams = [];

    if (url?.searchParams?.length) {
      searchParams.push(url.searchParams);
    }

    if (!!resourceName && resourceName?.length) {
      url.pathname += `${url.pathname.endsWith('/') ? '' : '/'}${resourceName}`;
    }

    if (top && parseInt(top)) {
      searchParams.push(`$top=${top}`);
    }

    if (!!expansionInfo && expansionInfo?.length) {
      searchParams.push(`$expand=${expansionInfo.map(x => x?.fieldName?.trim()).join(',')}`);
    }

    if (!!filter && filter?.length) {
      searchParams.push(`$filter=${filter}`);
    }

    if (!!orderby && orderby?.length) {
      searchParams.push(`$orderby=${orderby}`);
    }

    url.search = searchParams.join('&');

    return url.toString();
  } catch (err) {
    console.error(err);
    throw new Error(err);
  }
};

/**
 * Creates requests from either a path to a metadata report, or by passing it in directly
 * in metadataReportJson
 *
 * @param {Object} options request options
 * @returns list of requests
 */
const prepareRequests = async ({ metadataReportJson, serviceRootUri, resourceName, expansions = [], top, filter, orderby, batchExpand = false }) => {
  const useConfigs = !!metadataReportJson && Object.values(metadataReportJson)?.length,
    useParams = serviceRootUri?.length && resourceName?.length && resourceName?.length;

  const requests = [];

  if (useConfigs) {
    requests.push(
      ...createRequestsFromMetadataReport({
        serviceRootUri,
        metadataReportJson,
        filter,
        top,
        orderby,
        batchExpand
      })
    );
  } else if (useParams) {
    requests.push(createRequestFromParameters({ serviceRootUri, resourceName, expansions, filter, top, orderby }));
  } else {
    throw new Error('Invalid request. Must provide valid paths, configs, or params!');
  }
  return requests;
};

/**
 * Builds a request URI given a set of params
 * @param {Object} params parameters use for URL construction
 * @returns appropriate URL constructed for the given params
 */
const buildRequestUrlString = ({
  requestUri,
  strategy,
  totalRecordsFetched = 0,
  pageSize,
  timestampField = 'ModificationTimestamp',
  lastIsoTimestamp,
  nextLink
}) => {
  const [baseUri = null, query = null] = requestUri.split('?');

  const queryParams = query !== null ? queryString.parse(query) : {};

  const { $top = pageSize ?? DEFAULT_PAGE_SIZE, $filter, $expand, $orderby, ...remainingParams } = queryParams;

  if (strategy === REPLICATION_STRATEGIES.TOP_AND_SKIP) {
    //$skip param from queryParams is always ignored
    delete remainingParams.$skip;
    const remainingQueryString = queryString.stringify(remainingParams) ?? '';

    return new URL(
      `${baseUri}?$top=${$top}&$skip=${totalRecordsFetched}${$filter?.length ? `&$filter=${$filter}` : ''}${
        $expand?.length ? `&$expand=${$expand}` : ''
      }${remainingQueryString?.length ? `&${remainingQueryString}` : ''}${$orderby?.length ? `&$orderby=${$orderby}` : ''}`
    ).toString();
  } else if (strategy === REPLICATION_STRATEGIES.TIMESTAMP_ASC) {
    const timestamp = lastIsoTimestamp ?? new Date(0).toISOString(),
      preparedFilter =
        $filter && $filter?.length
          ? $filter
            .split(' and ')
            .flatMap(part => (part?.includes(timestampField) ? [] : part.trim()))
            .join(' and ')
          : null;

    return new URL(
      `?$top=${$top}&$filter=${timestampField} ge ${timestamp}${preparedFilter?.length ? ` and ${preparedFilter}` : ''}${
        $expand?.length ? `&$expand=${$expand}` : ''
      }&$orderby=${timestampField} asc`,
      baseUri
    ).toString();
  } else if (strategy === REPLICATION_STRATEGIES.TIMESTAMP_DESC) {
    const timestamp = lastIsoTimestamp ?? new Date().toISOString(),
      preparedFilter =
        $filter && $filter?.length
          ? $filter
            .split(' and ')
            .flatMap(part => (part?.includes(timestampField) ? [] : part.trim()))
            .join(' and ')
          : null;

    return new URL(
      `?$top=${$top}&$filter=${timestampField} lt ${timestamp}${preparedFilter?.length ? ` and ${preparedFilter}` : ''}${
        $expand?.length ? `&$expand=${$expand}` : ''
      }&$orderby=${timestampField} desc`,
      baseUri
    ).toString();
  } else if (strategy === REPLICATION_STRATEGIES.NEXT_LINK) {
    return new URL(nextLink ? nextLink : requestUri).toString();
  } else {
    throw new Error(`Unsupported replication strategy '${strategy}'!`);
  }
};

/**
 * Fetches top-level resource counts similar to DD 1.7 testing
 * @param {Object} params relevant params including resource name and service root
 * @returns the count returned from the server or 0 if nothing could be fetched
 */
const fetchTopLevelResourceCount = async ({ resourceName, serviceRootUri, filter, authService }) => {
  const errorMessage = `Could not fetch top-level resource count for resource '${resourceName}'. Defaulting to 0.`;

  try {
    const baseUrl = `${serviceRootUri}${serviceRootUri?.endsWith('/') ? '' : '/'}`,
      query = new URL(`${resourceName}?$count=true${filter ? `&$filter=${filter}` : ''}`, baseUrl).toString();

    console.log(`\nFetching top-level resource count for '${resourceName}': '${query}'...`);

    const response = await fetch(query, { headers: { ...(await authService.getOAuth2BearerTokenHeader()) } });

    if (response.ok) {
      const responseJson = await response.json(),
        count = parseInt(responseJson?.[ODATA_COUNT_PAYLOAD_KEY]) ?? 0;

      console.log(`Record count: ${count}\n`);

      return count;
    } else {
      console.log(errorMessage);
    }
  } catch {
    console.error(errorMessage);
  }

  // default to 0 if the request wasn't successful
  return 0;
};

/**
 * Generates a random integer.
 * @param {number} max default is 0-9. Pass larger max to sample from more.
 * @returns A random integer between 0 and max.
 */
const getRandomInt = (max = 9) => Math.floor(Math.random() * max);

module.exports = {
  ERROR_TYPES,
  REPLICATION_DIRECTORY_NAME,
  REPLICATION_STRATEGIES,
  DEFAULT_DD_VERSION,
  DEFAULT_TIMESTAMP_FIELD,
  DEFAULT_PAGE_SIZE,
  computeLastIsoTimestamp,
  getRandomInt,
  scorePayload,
  writeAnalyticsReports,
  writeSchemaValidationErrorReport,
  processHttpErrorResponse,
  parseResourceNameFromODataRequestUri,
  buildOutputFilePath,
  calculateJsonSize,
  getSystemRuntimeInfo,
  handleError,
  prepareRequests,
  consolidateResults,
  buildRequestUrlString,
  fetchTopLevelResourceCount,
  getTimestampBounds
};
