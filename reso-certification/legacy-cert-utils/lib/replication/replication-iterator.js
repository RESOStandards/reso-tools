'use strict';

const humanizeDuration = require('humanize-duration');
const {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TIMESTAMP_FIELD,
  ERROR_TYPES,
  REPLICATION_STRATEGIES,
  processHttpErrorResponse,
  calculateJsonSize,
  computeLastIsoTimestamp,
  buildRequestUrlString
} = require('./utils');

const { sleep } = require('../../common');

/**
 * @typedef {'TopAndSkip' | 'TimestampAsc' | 'TimestampDesc' | 'NextLink'} ReplicationStrategy
 */

/**
 * @typedef {Object} AuthService
 * @property {() => Promise<{Authorization: string}>} getOAuth2BearerTokenHeader Returns an object with an Authorization bearer token header
 */

/**
 * @typedef {Object} ReplicationIteratorConfig
 * @property {string} [initialRequestUri=''] The starting OData request URI (e.g. https://api.reso.org/Property)
 * @property {number} [maxErrorCount=3] Maximum number of consecutive errors before stopping iteration
 * @property {ReplicationStrategy} strategy The OData replication strategy to use
 * @property {number} [secondsDelayBetweenRequests] Optional throttle delay between requests, in seconds
 * @property {AuthService} authService OAuth2 auth service used to obtain bearer tokens for each request
 * @property {string} [timestampFieldName='ModificationTimestamp'] Field name used for timestamp-based strategies
 * @property {number} [maxPageSize] Requested max page size sent via the OData Prefer header (NextLink strategy only)
 */

/**
 * @typedef {Object} ReplicationError
 * @property {string} errorType Either 'http' or 'general'
 */

/**
 * @typedef {Object} ReplicationIteratorResult
 * @property {string} requestUri The request URI used for this page
 * @property {number} responseStatus HTTP status code of the response
 * @property {number} responseTimeMs Elapsed time for the request in milliseconds
 * @property {string} startTime ISO 8601 timestamp when the request started
 * @property {string} stopTime ISO 8601 timestamp when the request completed
 * @property {Object|null} responseJson Parsed JSON response body, or null on failure
 * @property {boolean} hasResults Whether the response contained any records
 * @property {number} pageSize Number of records in the current page
 * @property {number} totalRecordsFetched Running total of all records fetched across pages
 * @property {number} pagesFetched Number of pages successfully fetched so far
 * @property {number} numErrors Running total of errors encountered
 * @property {ReplicationError|null} error Error details if the request failed, null otherwise
 * @property {boolean} hasError Whether an error occurred on this page
 * @property {number} responseBytes Approximate size of the JSON response in bytes
 */

/** @type {string} OData response property containing the array of records */
const ODATA_VALUE_PROPERTY_NAME = 'value',
  /** @type {string} OData response property containing the next page URL */
  ODATA_NEXT_LINK_PROPERTY_NAME = '@odata.nextLink';

/**
 * OData Prefer header name and max page size parameter.
 * @see https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html#sec_HeaderPrefer
 */
const ODATA_PREFER_HEADER_NAME = 'Prefer',
  ODATA_MAX_PAGE_SIZE_HEADER_NAME = 'odata.maxpagesize',
  /** @type {number} Default max page size when using the NextLink strategy */
  ODATA_MAX_PAGE_SIZE_DEFAULT = 1000;

/**
 * Async generator that pages through an OData API endpoint, yielding results for each page.
 *
 * Maintains internal state (cursor position, error count, timestamps) across iterations.
 * Continues fetching until either no more records are returned or {@link maxErrorCount} is exceeded.
 * The caller controls when to stop by breaking out of the iteration loop.
 *
 * Supports four OData replication strategies:
 *  - **TopAndSkip**: Uses `$top` and `$skip` query parameters
 *  - **TimestampAsc/TimestampDesc**: Orders by a timestamp field and filters using the last seen value
 *  - **NextLink**: Follows `@odata.nextLink` URLs provided by the server
 *
 * @param {ReplicationIteratorConfig} config
 * @yields {ReplicationIteratorResult} The result of each page request
 * @returns {AsyncGenerator<ReplicationIteratorResult, void, unknown>}
 */
async function* replicationIterator({
  initialRequestUri = '',
  maxErrorCount = 3,
  strategy,
  secondsDelayBetweenRequests,
  authService,
  timestampFieldName = DEFAULT_TIMESTAMP_FIELD,
  maxPageSize
} = {}) {
  let pageSize = DEFAULT_PAGE_SIZE,
    pagesFetched = 0,
    numErrors = 0,
    totalRecordsFetched = 0,
    headers = {};

  const REQUEST_DELAY_MS = secondsDelayBetweenRequests * 1000 ?? 0,
    useDelay = (!!secondsDelayBetweenRequests && parseFloat(secondsDelayBetweenRequests) > 0) ?? false;

  let requestUri = initialRequestUri,
    lastRequestUri = null,
    lastIsoTimestamp = null,
    nextLink = null;

  // For NextLink strategy, request a specific page size via OData Prefer header
  if (strategy === REPLICATION_STRATEGIES.NEXT_LINK) {
    headers[ODATA_PREFER_HEADER_NAME] = `${ODATA_MAX_PAGE_SIZE_HEADER_NAME}=${maxPageSize ?? ODATA_MAX_PAGE_SIZE_DEFAULT}`;
  }

  // Apply initial delay before the first request if throttling is enabled
  if (useDelay) await sleep(REQUEST_DELAY_MS);

  do {
    /** @type {Object|null} */
    let responseJson = null,
      /** @type {number} */
      responseBytes = 0,
      /** @type {number} */
      responseStatus = 0,
      /** @type {ReplicationError|null} */
      error = null;

    requestUri = buildRequestUrlString({
      requestUri,
      strategy,
      totalRecordsFetched,
      pageSize,
      lastIsoTimestamp,
      nextLink
    });

    // Guard against infinite loops — stop if the URL hasn't changed since last request
    if (requestUri === lastRequestUri) {
      return;
    }

    // Refresh the bearer token before each request in case it has expired
    headers = {
      ...headers,
      ...(await authService.getOAuth2BearerTokenHeader())
    };

    let responseTimeMs = 0,
      /** @type {string|undefined} */
      startTime,
      /** @type {string|undefined} */
      stopTime;

    try {
      console.log(`\nFetching records from: ${requestUri}`);

      const startTimeMs = new Date();
      const response = await fetch(requestUri, { headers });
      const stopTimeMs = new Date();

      startTime = startTimeMs.toISOString();
      stopTime = stopTimeMs.toISOString();

      //TODO: legacy property - deprecate
      responseTimeMs = stopTimeMs - startTimeMs;

      lastRequestUri = requestUri;
      responseStatus = response.status;

      if (response.ok) {
        try {
          responseJson = await response.json();

          // For timestamp-based strategies, track the last timestamp to use as a filter on the next page
          if ([REPLICATION_STRATEGIES.TIMESTAMP_ASC, REPLICATION_STRATEGIES.TIMESTAMP_DESC].includes(strategy)) {
            lastIsoTimestamp = computeLastIsoTimestamp({ jsonData: responseJson, lastIsoTimestamp, strategy, timestampFieldName });
          }
        } catch {
          // Response was OK but body wasn't valid JSON — treat as empty
          responseJson = {};
        }

        responseBytes = calculateJsonSize(responseJson);

        pageSize = responseJson[ODATA_VALUE_PROPERTY_NAME]?.length ?? 0;
        nextLink = responseJson[ODATA_NEXT_LINK_PROPERTY_NAME] ?? null;
        totalRecordsFetched += pageSize;

        if (pageSize) {
          console.log(
            `Request succeeded! Time taken: ${humanizeDuration(responseTimeMs)}. Records fetched: ${pageSize}. ` +
              `Total records fetched: ${totalRecordsFetched}\n`
          );
        } else {
          console.log('No records to fetch!');
        }
        pagesFetched++;
      } else {
        stopTime = new Date().toISOString();
        error = {
          errorType: ERROR_TYPES.HTTP,
          ...processHttpErrorResponse(response)
        };
        numErrors++;
      }
    } catch (err) {
      console.error(err);
      numErrors++;
      error = {
        errorType: ERROR_TYPES.GENERAL,
        ...err
      };
    }

    yield {
      requestUri,
      responseStatus,
      responseTimeMs,
      startTime,
      stopTime,
      responseJson,
      hasResults: pageSize > 0,
      pageSize,
      totalRecordsFetched,
      pagesFetched,
      numErrors,
      error,
      hasError: !!error,
      responseBytes
    };

    // Throttle between pages if a delay was configured
    if (useDelay) await sleep(REQUEST_DELAY_MS);
  } while (pageSize > 0 && numErrors <= maxErrorCount);
}

/**
 * Replication Iterator module.
 *
 * Provides an async generator interface for paginated OData data replication
 * using one of four strategies: NextLink, TopAndSkip, TimestampAsc, or TimestampDesc.
 *
 * @module replication-iterator
 */
module.exports = {
  REPLICATION_STRATEGIES,
  replicationIterator
};
