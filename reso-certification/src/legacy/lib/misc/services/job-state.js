'use strict';
const { sleep } = require('../../../common');

// const JOB_LOG_DIRECTORY = 'jobs';
// const _jobs = [];

/*
  The four job-state shapes. Identifiers, timestamps, report ids and the error trace below are
  SYNTHETIC. Do not paste real certification records here: this file ships in the published npm
  package and the repository is public, so a real record publishes a named provider's result.

  // scheduled
  {
    "certificationRequestId": "qa-T00000012-1700000000000",
    "recipientConfigId": "M00000123-50000",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "startedAtTimestamp": "2026-01-01T00:00:00.000Z",
    "status": "scheduled",
    "statusTimestamp": "2026-01-01T00:00:00.000Z"
  }

  // passed
  {
    "certificationRequestId": "qa-T00000012-1700000000000",
    "recipientConfigId": "M00000123-50000",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "reportId": "EXAMPLE_REPORT_ID_0001",
    "startedAtTimestamp": "2026-01-01T00:00:00.000Z",
    "status": "passed",
    "statusTimestamp": "2026-01-01T00:01:00.000Z"
  }

  // failed
  {
    "certificationRequestId": "qa-T00000012-1700000000000",
    "recipientConfigId": "M00000123-50000",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "reportId": "EXAMPLE_REPORT_ID_0002",
    "startedAtTimestamp": "2026-01-01T00:00:00.000Z",
    "status": "failed",
    "failedStep": "<the step that failed>",
    "statusTimestamp": "2026-01-01T00:01:00.000Z"
  }

  // error
  {
    "certificationRequestId": "qa-T00000012-1700000000000",
    "recipientConfigId": "M00000123-50000",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "error": "{\\"Error\\":\\"<ErrorName>\\",\\"Cause\\":\\"{\\\\\\"errorType\\\\\\":\\\\\\"<ErrorName>\\\\\\",\\\\\\"errorMessage\\\\\\":\\\\\\"<message>\\\\\\",\\\\\\"trace\\\\\\":[\\\\\\"<stack frames>\\\\\\"]}\\"}",
    "reportId": "error",
    "startedAtTimestamp": "2026-01-01T00:00:00.000Z",
    "status": "error",
    "statusTimestamp": "2026-01-01T00:00:20.000Z"
  }
*/

let isSerializingResultsToFile = false;

const MAX_FILE_SYNC_RETRIES = 10;

/**
 * Used to serialize job states when running locally
 */
const serializeLocalJobState = async () => {
  let numRetries = 0;
  while (isSerializingResultsToFile && numRetries < MAX_FILE_SYNC_RETRIES) {
    numRetries++;
    await sleep(100);
  }

  if (!isSerializingResultsToFile) {
    try {
      isSerializingResultsToFile = true;
    } catch (err) {
      console.error(`Error serializing job results. Error: ${err}`);
    } finally {
      isSerializingResultsToFile = false;
    }
  } else {
    console.error('Could not write output to jobs file. File locked.');
  }
};

const updateJobState = async () => {

};

module.exports = {
  serializeLocalJobState,
  updateJobState
};
