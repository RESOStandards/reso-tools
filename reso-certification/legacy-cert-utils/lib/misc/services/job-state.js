'use strict';
const { sleep } = require('../../../common');

// const JOB_LOG_DIRECTORY = 'jobs';
// const _jobs = [];

/*
  // scheduled
  {
    "certificationRequestId": "qa-T00000095-1727974929697",
    "recipientConfigId": "M00000057-50038",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "startedAtTimestamp": "2024-10-03T17:02:09.697Z",
    "status": "scheduled",
    "statusTimestamp": "2024-10-03T17:02:09.697Z"
  }

  // passed
  {
    "certificationRequestId": "qa-T00000044-1706609082545",
    "recipientConfigId": "M00000172-50002",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "reportId": "ks2mVY0BmZ47qXugY3F7",
    "startedAtTimestamp": "2024-01-30T10:04:42.545Z",
    "status": "passed",
    "statusTimestamp": "2024-01-30T10:05:23.406Z"
  }

  // failed
  {
    "certificationRequestId": "qa-T00000141-1711478354430",
    "recipientConfigId": "T00000012-50030",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "reportId": "VQ4PfI4BMSgypO6msO7Y",
    "startedAtTimestamp": "2024-03-26T18:39:14.430Z",
    "status": "failed",
    "failedStep": "variations check",
    "statusTimestamp": "2024-03-26T18:39:47.188Z"
  }

  // error
  {
    "certificationRequestId": "qa-T00000095-1727974929697",
    "recipientConfigId": "M00000094-50038",
    "endorsementName": "data-dictionary",
    "endorsementVersion": "1.7",
    "environmentName": "qa",
    "error": "{\"Error\":\"SyntaxError\",\"Cause\":\"{\\\"errorType\\\":\\\"SyntaxError\\\",\\\"errorMessage\\\":\\\"Unexpected token o in JSON at position 1\\\",\\\"trace\\\":[\\\"SyntaxError: Unexpected token o in JSON at position 1\\\",\\\"    at JSON.parse (<anonymous>)\\\",\\\"    at Runtime.exports.handler (/var/task/index.js:127:52)\\\"]}\"}",
    "reportId": "error",
    "startedAtTimestamp": "2024-10-03T17:02:09.697Z",
    "status": "error",
    "statusTimestamp": "2024-10-03T17:02:28.213Z"
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
