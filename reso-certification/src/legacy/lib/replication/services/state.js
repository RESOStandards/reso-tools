'use strict';

const { buildMetadataMap } = require('../../../common');
const { mergeSchemaValidationResults } = require('../schema-results');

/**
 * One run's replication state: the availability map, the record set, the responses, the page and top-level
 * counts, and the metadata map. Each call returns new state that shares nothing with any other call.
 *
 * This module used to hold the state at module level, so every caller got the same object and a second run in the
 * same process (a config file with several Data Dictionary entries) inherited the first run's responses and record
 * hashes. The availability report is built from this state, so it reported records the run never received.
 *
 * The record set is GIVEN, never built here. It is a `DistinctKeySet` (`src/state/distinct-key-set.ts`) whose
 * memory ceiling belongs to whoever owns the run: one run in a container can take more than one of several runs on
 * a desktop, and nothing in here can know which it is. So a missing set is an error, not a default.
 *
 * @param {Object} options
 * @param {Object} options.recordKeySet the set that answers "has this run counted this record": `add`, `stats`
 */
const createReplicationState = ({ recordKeySet } = {}) => {
  if (typeof recordKeySet?.add !== 'function' || typeof recordKeySet?.stats !== 'function') {
    throw new Error(
      'Replication state needs a record set: pass { recordKeySet } to createReplicationStateServiceInstance. ' +
        'The caller that owns the run creates it (createRecordKeySet in src/state/record-key-set.ts), because the ' +
        'memory it may use is the caller\'s decision.'
    );
  }

  /**
   * Resource availability map has a structure of resourceName, fieldName, lookups, lookupValue
   */
  const _resourceAvailabilityMap = {};

  /**
   * Whether this run has counted a record, so one fetched again (by another strategy, or by a timestamp walk at a
   * page boundary) is counted once. `recordKeySet` replaced twenty plain objects scanned on every lookup.
   *
   * What is still true of the key, for the DD 2.2 rewrite:
   *
   *   1. The key is `hashJsonData({ modelName, parentModelName, normalizedRecord })`: a SHA-256 truncated to 15 hex
   *      characters, 60 bits (`NUM_SHORT_HASH_CHARACTERS` is 16 and is sliced to 16 - 1). The set hashes that
   *      string again to its own width. Two records that collide read as one, so the second is not counted:
   *      an undercount, which is the safe direction. Widening the set alone buys nothing; the 60 bits come first.
   *
   *   2. `parentModelName` is in the key, so a record reached alone and reached through an expansion are two
   *      entries, not a repeat. That is deliberate (availability is kept per parent), and it means this set cannot
   *      measure standalone-versus-expansion overlap. That needs a second key without the parent.
   *
   *   3. The SHA-256 step is kept only so the keys match the ones this replaced. The set's own hash is enough and
   *      about five times faster; dropping the SHA-256 belongs with the sampling rewrite.
   *
   * Never window this set to a page or a walk: a server could then re-serve dense records on later pages and be
   * counted again.
   */
  const addRecordKey = key => recordKeySet.add(key);

  /**
   * The record set's occupancy and whether it reached its ceiling, for the report and the log.
   * @returns the set's stats
   */
  const getRecordDeduplicationStats = () => recordKeySet.stats();

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
   * The schema validation results of every strategy of this run that ran to its end, merged: everything a relaxed
   * strategy found, and the warnings of a strict strategy that passed. Null until the first one does.
   */
  let _schemaValidationResults = null;

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
   * Initializes this run's replication state. Nothing is left to prepare; kept because callers call it.
   */
  const init = () => {
    _isInitialized = true;
  };

  /**
   * Resource availability map accessor
   * @returns current instance
   */
  const getResourceAvailabilityMap = () => _resourceAvailabilityMap;

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

  /**
   * Accessor for the schema validation results accumulated across this run's strategies
   * @returns the merged results, or null when no strategy has accumulated any
   */
  const getSchemaValidationResults = () => _schemaValidationResults;

  /**
   * Merges one strategy's schema validation results into this run's. See `../schema-results` for the counting
   * rule: the findings are the union, and a count is never the sum across strategies.
   * @param {Object} results one `replicate()` call's results, as returned by the schema validator
   * @returns the run's merged results
   */
  const accumulateSchemaValidationResults = results => {
    _schemaValidationResults = mergeSchemaValidationResults(_schemaValidationResults, results);
    return _schemaValidationResults;
  };

  return {
    init,
    getIsInitialized,
    getResourceAvailabilityMap,
    addRecordKey,
    getRecordDeduplicationStats,
    getResponses,
    getResourcePageCount,
    incrementResourcePageCount,
    getMetadataMap,
    setMetadataMap,
    getSchemaValidationResults,
    accumulateSchemaValidationResults,
    getTopLevelResourceCounts,
    setTopLevelResourceCount,
    checkIfTopLevelResourceCountExists
  };
};

module.exports = {
  createReplicationState
};
