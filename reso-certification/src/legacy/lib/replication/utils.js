'use strict';

const humanizeDuration = require('humanize-duration');
const { writeFile, rm } = require('fs/promises');
const { resolve, join } = require('path');
const { createHash } = require('node:crypto');
const queryString = require('node:querystring');

// custom libs
const { sleep, NOT_OK, resolveFilePathSync, DEFAULT_DD_VERSION } = require('../../common');

const { combineErrors } = require('../schema');

const REPLICATION_DIRECTORY_NAME = 'reso-replication-output',
  AVAILABILITY_REPORT_FILENAME = 'data-availability-report.json',
  AVAILABILITY_RESPONSES_FILENAME = 'data-availability-responses.json',
  SCHEMA_VALIDATION_REPORT_FILENAME = 'data-availability-schema-validation-errors.json',
  SCHEMA_VALIDATION_WARNINGS_FILENAME = 'data-availability-schema-validation-warnings.json';

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

const POSTAL_CODE_FIELD_NAME = 'PostalCode',
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
      // Timestamp collision (a whole page shares this timestamp): nudge forward 1ms so the next `ge` page
      // doesn't re-fetch it. Use getTime() for explicit numeric math — `new Date(dateObj + 1)` coerces the
      // Date to a string and yields Invalid Date, so .toISOString() throws (the bug this replaced).
      return new Date(new Date(maxIsoTimestamp).getTime() + 1).toISOString();
    } else {
      return maxIsoTimestamp;
    }
  }

  if (strategy === REPLICATION_STRATEGIES.TIMESTAMP_DESC) {
    if (lastIsoTimestamp === minIsoTimestamp) {
      // Timestamp collision: nudge backward 1ms (symmetric to ASC; explicit getTime() for the same reason).
      return new Date(new Date(minIsoTimestamp).getTime() - 1).toISOString();
    } else {
      return minIsoTimestamp;
    }
  }
};

/**
 * A timestamp walk's page without the records the walk itself fetched twice, for schema validation only.
 *
 * WHY. The timestamp walks page inclusively: `buildRequestUrlString` asks for `le <last timestamp>` going down and
 * `ge <last timestamp>` going up, so each page after the first opens with the records the page before returned at
 * that boundary timestamp. That repeat is deliberate, and availability drops it by the record hash in `scorePayload`.
 * Schema validation runs on the raw page, so a violation on a boundary record was counted twice, and a count must
 * never be high.
 *
 * WHAT. A window of one page, in a timestamp walk only. From each page it remembers the records at the timestamp the
 * next request will start from. On the next page of the same walk, a record is left out of validation only when its
 * JSON, exactly as served and with its expanded data, is identical to a remembered one. Each remembered record
 * excuses one repeat.
 *
 * WHAT IT MUST NOT BECOME. Do not widen this, and do not copy it elsewhere:
 *   - Not a set for the call or the run. The reported error totals are occurrence counts by design: a record is
 *     validated once per request shape (alone, and once with each expansion), and report tools divide by one plus
 *     the number of expansions. Skipping a record seen under another shape changes a published number. Counting
 *     distinct violations is #17, with DD 2.2.
 *   - Not keyed on the availability hash. `normalizeRecords` takes the expanded data out of the parent before
 *     hashing, so a record has the same hash alone and in each of its expansion walks.
 *   - Not a set that can fill. A set that answers "seen" once full would skip validation, and a skipped error is a
 *     false pass.
 *   - Not for TopAndSkip or NextLink. Those walks never ask for a record twice, so a repeat there is the server's
 *     pager at fault, which the run is meant to show, not hide.
 *   - Never the availability guard. Its hash set is global to the run on purpose; windowing it to a page lets a
 *     server re-serve dense records on later pages and be counted again.
 * A record whose content changed between the two fetches is not identical, so it is validated again: its values may
 * differ, and when in doubt the record is validated.
 *
 * WHEN IT GOES. Paging by (timestamp, key) (#254, phase 4 of the 0.14.0 plan) removes the repeat at its source, and
 * this function goes with it.
 *
 * The next request's starting timestamp is worked out with `computeLastIsoTimestamp`, the function the iterator uses,
 * so the window follows the walk: when the walk steps one millisecond past a timestamp (a page that did not move the
 * boundary), no record of this page is at the new starting point and nothing is remembered.
 *
 * @param {Object} obj
 * @param {Object} obj.jsonData the page as the server returned it
 * @param {String} obj.strategy the walk's replication strategy
 * @param {{lastIsoTimestamp?: String, records?: Map<String, Number>}} [obj.window] what the page before left
 * @param {String} [obj.timestampFieldName] the field the walk pages on
 * @returns {{jsonData: Object, window: Object}} the page to validate (the same object when nothing was left out),
 *   and the window for the next page of this walk
 */
const withoutBoundaryRepeats = ({ jsonData, strategy, window = {}, timestampFieldName = DEFAULT_TIMESTAMP_FIELD }) => {
  const isTimestampWalk = strategy === REPLICATION_STRATEGIES.TIMESTAMP_ASC || strategy === REPLICATION_STRATEGIES.TIMESTAMP_DESC;
  if (!isTimestampWalk || !Array.isArray(jsonData?.value)) return { jsonData, window: {} };

  const excusable = new Map(window.records ?? []);
  const value = jsonData.value.filter(record => {
    const served = JSON.stringify(record);
    const remaining = excusable.get(served) ?? 0;
    if (remaining === 0) return true;
    excusable.set(served, remaining - 1);
    return false;
  });

  const isoOf = timestamp => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  // A page whose timestamps cannot be read gives the next page nothing to skip.
  let nextWindow = {};
  try {
    const lastIsoTimestamp = computeLastIsoTimestamp({ jsonData, lastIsoTimestamp: window.lastIsoTimestamp ?? null, strategy, timestampFieldName });
    const records = jsonData.value
      .filter(record => !!lastIsoTimestamp && isoOf(record?.[timestampFieldName]) === lastIsoTimestamp)
      .map(record => JSON.stringify(record))
      .reduce((counts, served) => counts.set(served, (counts.get(served) ?? 0) + 1), new Map());
    nextWindow = { lastIsoTimestamp, records };
  } catch {
    nextWindow = {};
  }

  return { jsonData: value.length === jsonData.value.length ? jsonData : { ...jsonData, value }, window: nextWindow };
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
    if (!expansionInfo?.length) {
      return [{ modelName: parentModelName, isExpansion: false, record }];
    }

    // The parent is scored once, without any of the navigations the request expanded. A request can expand several
    // navigations at once (batch expansion): each one's records are scored under its own child, and none of them stays
    // on the parent as a field. Removing only one navigation per pass scored the parent once per navigation, each time
    // carrying the others as fields, so a batched run reported ListAgent, Media and the rest as fields of Property and
    // counted its parent records once per navigation. One navigation per request comes out exactly as before.
    const navigationNames = new Set(expansionInfo.map(({ fieldName }) => fieldName));
    const parentRecord = Object.fromEntries(Object.entries(record).filter(([name]) => !navigationNames.has(name)));
    const expandedRecords = expansionInfo.flatMap(({ fieldName, modelName }) => {
      const expandedData = record[fieldName];
      if (!expandedData) return [];
      return (Array.isArray(expandedData) ? expandedData : [expandedData]).map(expandedRecord => ({
        modelName,
        parentModelName,
        fieldName,
        isExpansion: true,
        record: expandedRecord
      }));
    });

    return [...expandedRecords, { modelName: parentModelName, isExpansion: false, record: parentRecord }];
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
  const { addRecordKey, getResourceAvailabilityMap, getMetadataMap } = REPLICATION_STATE_SERVICE;

  const records = extractValues(jsonData);

  // return if there's nothing to process
  if (!(records && Array.isArray(records) && records?.length)) return;

  let recordCount = 0,
    expandedRecordCount = 0;
  // Expanded records by the child they belong to, so a batched request credits each child with its own records.
  const expandedRecordCounts = {};

  // Score records
  records.forEach(record => {
    // process both parent record and expanded data
    (
      normalizeRecords({ expansionInfo, record, resourceName }) || []
    ).forEach(({ isExpansion = false, modelName, parentModelName, record: normalizedRecord = {} } = {}) => {

      // duplicate detection - necessary for both parent resources and their expansions as we can
      // resample both resources and their expansions in testing using different replication strategies
      //
      // One add, and its outcome decides: 'added' is a record this run has not counted, so it is counted.
      // 'present' is one it has, so it is skipped. 'refused' means the set reached its ceiling and can no longer
      // tell the two apart, so the record is skipped as well: the totals come out low, never high, and the set
      // remembers the refusal so the report can say the totals are a floor.
      const normalizedRecordHash = hashJsonData({ modelName, parentModelName, normalizedRecord });
      if (addRecordKey(String(normalizedRecordHash)) === 'added') {

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
      }

      if (isExpansion) {
        expandedRecordCount++;
        expandedRecordCounts[modelName] = (expandedRecordCounts[modelName] ?? 0) + 1;
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
      expandedRecordCounts: expansionInfo ? expandedRecordCounts : undefined,
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
    (acc, { responseTimeMs, responseBytes, resourceName, recordCount, expandedRecordCount, expandedRecordCounts, expansionInfo = [] }) => {
      // Every child the request expanded. A batched request expands several: its time and size are the whole
      // request's, recorded against each child, and each child gets its own expanded records. Filing the request under
      // its first expansion only left every other child of a batched request with no records, times or sizes.
      const expandedModelNames = [...new Set((expansionInfo ?? []).map(item => item?.modelName).filter(Boolean))],
        isExpansion = expandedModelNames.length > 0;

      //initialize top-lever resource item if not present
      if (!acc[resourceName]) {
        acc[resourceName] = {
          responseTimes: [],
          responseBytes: [],
          recordCounts: []
        };
      }

      if (isExpansion) {
        expandedModelNames.forEach(expandedModelName => {
          if (!acc[resourceName].expansions) {
            acc[resourceName].expansions = {};
          }

          if (!acc[resourceName].expansions[expandedModelName]) {
            acc[resourceName].expansions[expandedModelName] = {
              responseTimes: [],
              responseBytes: [],
              recordCounts: [],
              expandedRecordCounts: []
            };
          }

          acc[resourceName].expansions[expandedModelName].responseTimes.push(responseTimeMs);
          acc[resourceName].expansions[expandedModelName].responseBytes.push(responseBytes);
          acc[resourceName].expansions[expandedModelName].recordCounts.push(recordCount);
          acc[resourceName].expansions[expandedModelName].expandedRecordCounts.push(
            expandedRecordCounts?.[expandedModelName] ?? (expandedModelNames.length === 1 ? expandedRecordCount : 0)
          );
        });
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
  const { totalErrors = 0 } = errorMap?.stats ?? {};
  if (totalErrors > 0) {
    const resolvedPath = resolveFilePathSync({ outputPath, filename: SCHEMA_VALIDATION_REPORT_FILENAME });
    await writeFile(resolvedPath, JSON.stringify(combineErrors(errorMap)));
    console.log(`Schema validation errors written to: ${resolvedPath}`);
  }
};

/**
 * Writes the schema-validation WARNINGS of a run that produced no errors (#298: on the transport path a
 * malformed or disagreeing `@reso.context` is a warning until DD 3.0; before this file existed such a run
 * left no trace of them, since the errors report is written only when totalErrors > 0 and in place of the
 * analytics reports). A separate file, written beside the analytics reports, so no existing reader's
 * meaning changes: the presence of the errors report still means the run had errors.
 *
 * @param {{outputPath: string, errorMap?: {stats?: {totalErrors?: number, totalWarnings?: number}}}} params
 * @returns {Promise<string|undefined>} the path written, when warnings were present without errors
 */
const writeSchemaValidationWarningsReport = async ({ outputPath, errorMap = {} }) => {
  // a run in which no page was validated (zero records, every request an error the engine swallowed) hands
  // an empty accumulator here: nothing to write, never a reason to fail the run
  const { totalErrors = 0, totalWarnings = 0 } = errorMap?.stats ?? {};
  if (totalErrors === 0 && totalWarnings > 0) {
    const resolvedPath = resolveFilePathSync({ outputPath, filename: SCHEMA_VALIDATION_WARNINGS_FILENAME });
    await writeFile(resolvedPath, JSON.stringify(combineErrors(errorMap)));
    console.log(`Schema validation warnings (no errors) written to: ${resolvedPath}`);
    return resolvedPath;
  }
  return undefined;
};

/**
 * Removes the warnings report, when there is one. The warnings file is for a run with warnings and no errors; a run
 * with both writes the errors file alone, which carries its warnings. A strategy that had only warnings writes the
 * warnings file, and when a later strategy of the same run brings an error, that file would otherwise stay beside the
 * errors file, describing one strategy of a run that had errors.
 *
 * @param {{outputPath: string}} params
 */
const removeSchemaValidationWarningsReport = async ({ outputPath }) => {
  await rm(resolveFilePathSync({ outputPath, filename: SCHEMA_VALIDATION_WARNINGS_FILENAME }), { force: true });
};

/**
 * What the availability report says about record deduplication. The ONE place that decides it: to change when the
 * field appears (always, or only when saturated), change this function and nothing else.
 *
 * The report is uploaded and a provider reads it, so it carries the two facts a reader needs and nothing about how
 * the set works (no sizes, widths or capacities; those go to the log, see describeRecordDeduplication):
 *   - `saturated`: the set reached its memory ceiling during the run.
 *   - `totalsAreFloor`: at least one record was skipped because the set could no longer tell it from a counted
 *     one, so every availability total in the report is a lower bound.
 *
 * @param {Object} replicationStateService the run's replication state
 * @returns the fields to spread into the availability report
 */
const recordDeduplicationReportOf = replicationStateService => {
  const { saturated = false, refused = 0 } = replicationStateService.getRecordDeduplicationStats() ?? {};
  return { recordDeduplication: { saturated: !!saturated, totalsAreFloor: refused > 0 } };
};

/**
 * One line with everything the record set knows about itself, for the log at the end of a replication call.
 * @param {Object} replicationStateService the run's replication state
 * @returns the line
 */
const describeRecordDeduplication = replicationStateService => {
  const { recorded, capacity, loadFactor, bytesReserved, hashBits, saturated, refused } = replicationStateService.getRecordDeduplicationStats() ?? {};
  const count = n => Number(n ?? 0).toLocaleString('en-US');
  return (
    `Record deduplication: ${count(recorded)} distinct records recorded, room for ${count(capacity)} ` +
    `(${(Number(loadFactor ?? 0) * 100).toFixed(1)}% used), ${count(bytesReserved)} bytes reserved, ${hashBits}-bit hash, ` +
    `saturated: ${!!saturated}, refused: ${count(refused)}${refused > 0 ? ' (availability totals are a floor)' : ''}`
  );
};

/**
 * Writes a data-availability-report.json file for the given version and availability data
 *
 * @param {Object} params
 */
const writeAnalyticsReports = async ({ outputPath, version, softwareVersion, serviceRootUri, replicationStateService: REPLICATION_STATE_SERVICE }) => {
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
        ...(softwareVersion ? { softwareVersion } : {}),
        generatedOn,
        ...recordDeduplicationReportOf(REPLICATION_STATE_SERVICE),
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
    // Neither logged nor re-wrapped by hand. `new Error(err)` stringified the original, so the
    // message came out as "Error: Error: ..." and the stack of the thing that actually failed was
    // discarded; logging here as well reported it twice, since the caller reports it too.
    throw new Error(`Could not build the request URL: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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

    // `le` (inclusive), symmetric to TimestampAsc's `ge`: re-fetch the boundary record and let scorePayload's
    // hash dedup drop the repeat, rather than `lt` (exclusive) which silently dropped every record sharing the
    // page-boundary timestamp when a collision straddled a page. The -1ms nudge in computeLastIsoTimestamp
    // breaks the stall when a whole page shares the min timestamp.
    return new URL(
      `?$top=${$top}&$filter=${timestampField} le ${timestamp}${preparedFilter?.length ? ` and ${preparedFilter}` : ''}${
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

/** How many of an error class's failing fields to name before summarizing the rest. Enough to show the
 *  shape of the problem, few enough that one error class stays on one line. */
const MAX_SCHEMA_FIELDS_LOGGED = 5;

/**
 * Describe a page's schema-validation state as ONE operator-facing line.
 *
 * Replaces a generic line emitted per page - "Schema validation errors found in the <Resource> payload!" -
 * with no count, no field and no error class, so a 1,770-page run produced 1,770 identical copies of a
 * sentence that was impossible to ignore and told the operator nothing.
 *
 * The fix is to make the line CARRY the state, not to print it less often. Announcing each error class once
 * and then going quiet was the first attempt and it was wrong for a specific reason (Josh, 2026-10-16):
 * **a page with errors that prints nothing reads as a page that passed.** Silence is not a safe default when
 * the subject is a failure. So every page with errors emits a line, every time.
 *
 * Consequences of that, deliberately: there is NO carried state - no announce-set, no page cadence - so the
 * same accumulator always renders the same line, there is nothing to reset between replication strategies,
 * and no caller can suppress a page by threading history back in. Classes are ordered largest first so the
 * dominant problem reads first, and the whole state stays on one line so a long run is still greppable.
 *
 * Every number here was already in the accumulator at runtime; this only reports it.
 *
 * @param {Object} obj
 * @param {Object} obj.errorMap the accumulated validation result (`stats` + `errorCache`)
 * @param {String} obj.resourceName resource the current page belongs to
 * @returns {{line: String|null, totals: String|null}} both null when the page found no errors
 */
const describeSchemaErrors = ({ errorMap, resourceName }) => {
  const { stats: { totalErrors = 0, totalWarnings = 0 } = {}, errorCache = {} } = errorMap ?? {};
  if (!(totalErrors > 0)) return { line: null, totals: null };

  const count = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, word) => `${count(n)} ${word}${Number(n || 0) === 1 ? '' : 's'}`;
  const classes = Object.keys(errorCache);
  const totals = `${plural(totalErrors, 'error')}, ${plural(totalWarnings, 'warning')}, ${plural(classes.length, 'distinct type')}`;

  // Only classes that actually hit THIS resource are broken down; errorCache is keyed by MESSAGE across
  // every resource, so naming another resource's finding here would send the operator to the wrong place.
  // The totals stay run-wide, because they are run-wide.
  const breakdown = classes
    .map(message => ({ message, hit: errorCache[message]?.resources?.[resourceName] }))
    .filter(({ hit }) => hit)
    .map(({ message, hit }) => {
      // Largest fields first, so the cap hides the SMALLEST rather than whichever was recorded last. On a
      // live run the old insertion order collapsed `Rooms` (12,351, the biggest and the field under
      // investigation) into "+1 more" while `Heating` (104) kept a visible slot. A field's own count is the
      // sum of its per-value counts; a class that records no per-value counts sorts to all-zero and the
      // stable sort then preserves the recorded order, which is the only order it has.
      // A field's own count comes from one of TWO shapes, because the validator records two. An enum-class
      // field carries `{ lookups: { value: { count } } }` and no field-level count; a type-class field
      // carries `{ count }` and no lookups at all. Reading only the lookups scored every type-class field at
      // zero and silently fell back to recorded order. A field with neither sorts to zero, which is correct:
      // there is nothing to order it by.
      const fieldCount = fv =>
        fv?.count !== undefined
          ? Number(fv.count || 0)
          : Object.values(fv?.lookups ?? {}).reduce((s, v) => s + Number(v?.count || 0), 0);
      const fields = Object.entries(hit.fields ?? {})
        .map(([field, fv]) => ({ field, n: fieldCount(fv) }))
        .sort((a, b) => b.n - a.n)
        .map(({ field }) => field);
      const shown = fields.slice(0, MAX_SCHEMA_FIELDS_LOGGED);
      const remaining = fields.length - shown.length;
      const where = shown.length
        ? ` on ${plural(fields.length, 'field')} (${shown.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''})`
        : '';
      return { n: Number(hit.count || 0), text: `${message} ${count(hit.count)}${where}` };
    })
    .sort((a, b) => b.n - a.n);

  // The lead number is THIS resource's own count, so the line reconciles against its own breakdown. Leading
  // with `stats.totalErrors` instead was a measured defect: it is cumulative across every resource, so a
  // live run printed "Schema validation (Member): 42,793 errors ... 3,996 on 1 field", and a resource with
  // none of its own printed a five-figure count and no breakdown - reading as catastrophe on a clean
  // resource, the exact inverse of the bug this logging was written to fix. The cumulative figure is still
  // shown, labeled as cumulative, because watching it climb is the point of a per-page line.
  const own = breakdown.reduce((sum, { n }) => sum + n, 0);
  const head = `${plural(own, 'error')}, ${plural(breakdown.length, 'type')} here (${count(totalErrors)} run total)`;
  const detail = breakdown.length > 0 ? ` \u00b7 ${breakdown.map(({ text }) => text).join(' \u00b7 ')}` : '';

  return { line: `Schema validation (${resourceName}): ${head}${detail}`, totals };
};

module.exports = {
  ERROR_TYPES,
  REPLICATION_DIRECTORY_NAME,
  REPLICATION_STRATEGIES,
  DEFAULT_DD_VERSION,
  DEFAULT_TIMESTAMP_FIELD,
  DEFAULT_PAGE_SIZE,
  computeLastIsoTimestamp,
  scorePayload,
  writeAnalyticsReports,
  withoutBoundaryRepeats,
  describeRecordDeduplication,
  removeSchemaValidationWarningsReport,
  writeSchemaValidationErrorReport,
  writeSchemaValidationWarningsReport,
  SCHEMA_VALIDATION_WARNINGS_FILENAME,
  describeSchemaErrors,
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
