'use strict';

const { buildMetadataMap } = require('../../../common');
const { getRandomInt } = require('../utils');

// Node has a 2^24 record limit on hashmaps, so the default supports around 336m hashes
const NUM_RECORD_COUNT_HASHMAPS = 20;

/**
 * Resource availability map has a structure of resourceName, fieldName, lookups, lookupValue
 */
const _resourceAvailabilityMap = {};

/**
 * Used to detect whether we've pulled the same record using different strategies
 * Format of each entry is recordHash: count
 */
const _recordCountHashMaps = [];

/**
 * Tracks page responses
 */
const _responses = [];

/**
 * Tracks how many pages were fetched per resource
 */
const _resourcePageCounts = {};

/**
 * Metadata map used for lookups on a given metadata report
 */
let _metadataMap = {};

/**
 * Local state variable to track whether the service is initialized
 */
let _isInitialized = false;

/**
 * Accessor for initialization state
 * @returns true if the service has been initialized, false otherwise
 */
const getIsInitialized = () => !!_isInitialized;

/**
 * Stores top level resource counts for compatibility with older reports
 */
const _topLevelResourceCounts = {};

/**
 * Initializes the singleton replication state service
 */
const init = () => {
  if (_isInitialized) {
    return;
  }

  for (let i = 0; i < NUM_RECORD_COUNT_HASHMAPS; i++) {
    _recordCountHashMaps.push({});
  }

  _isInitialized = true;
};

/**
 * Resource availability map accessor
 * @returns current instance
 */
const getResourceAvailabilityMap = () => _resourceAvailabilityMap;

const _getHashValue = (value) => {
  for (const recordCountHashMap of _recordCountHashMaps) {
    if (!!(recordCountHashMap && typeof recordCountHashMap === 'object' && !!recordCountHashMap?.[value])) {
      return recordCountHashMap[value];
    }
  }

  return null;
};

/**
 * Checks to see whether a hash value exists in the record count hash map
 * 
 * @param {String} value the string hash value to check for 
 * @returns true if hash exists, false otherwise
 */
const hashExists = (value) => !!_getHashValue(value);

/**
 * Adds and increments the count for each found hashed record
 * @param {String} value the hash value to add 
 */
const addOrIncrementHashValue = (value) => {
  let val = _getHashValue(value);

  if (!val) {
    _recordCountHashMaps[getRandomInt(_recordCountHashMaps?.length - 1)][value] = 1;
  } else {
    val++;
  }
};

/**
 * Responses accessor
 * @returns array of responses
 */
const getResponses = () => _responses;

/**
 * Gets the resource count
 * @param {String} resourceName name of resource to get count for
 * @returns current record count
 */
const getResourcePageCount = resourceName => _resourcePageCounts?.[resourceName];

/**
 * Increments current record count for the given resource
 * @param {String} resourceName name of the resource to increment the count for
 */
const incrementResourcePageCount = resourceName => {
  if (!_resourcePageCounts?.[resourceName]) {
    _resourcePageCounts[resourceName] = 0;
  }

  _resourcePageCounts[resourceName]++;
};

/**
 * Accessor for top level resource counts
 * @returns map of top level resource counts
 */
const getTopLevelResourceCounts = () => _topLevelResourceCounts;

/**
 * Checks to see if a resource count exists for the given resourceName
 * @param {String} resourceName name of the resource to check
 * @returns true if the top level count exists and false otherwise
 */
const checkIfTopLevelResourceCountExists = resourceName =>
  !!(resourceName?.length && _topLevelResourceCounts?.[resourceName]?.hasBeenChecked);

/**
 * Sets the top level resource count
 * @param {String} resourceName name of the resource to set the count for
 * @param {Number} count integer value representing count
 */
const setTopLevelResourceCount = (resourceName, count = 0) => {
  if (!_topLevelResourceCounts?.[resourceName]) {
    _topLevelResourceCounts[resourceName] = {
      count,
      hasBeenChecked: true
    };
  }
};

/**
 * Metadata map accessor
 * @returns current metadata map
 */
const getMetadataMap = () => _metadataMap;

/**
 * Creates a local metadata map from the given metadata report JSON
 * @param {Object} metadataReportJson JSON metadata report (fields, lookups) to build the metadata map from
 */
const setMetadataMap = (metadataReportJson = {}) => {
  const { metadataMap } = buildMetadataMap(metadataReportJson);
  _metadataMap = metadataMap;
};

module.exports = {
  init,
  getIsInitialized,
  getResourceAvailabilityMap,
  hashExists,
  addOrIncrementHashValue,
  getResponses,
  getResourcePageCount,
  incrementResourcePageCount,
  getMetadataMap,
  setMetadataMap,
  getTopLevelResourceCounts,
  setTopLevelResourceCount,
  checkIfTopLevelResourceCountExists
};
