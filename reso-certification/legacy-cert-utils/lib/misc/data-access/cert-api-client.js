'use strict';

const { CERTIFICATION_API_KEY, ORGS_DATA_URL, SYSTEMS_DATA_URL } = process.env;
const { sleep } = require('../../../common');

const API_DEBOUNCE_SECONDS = 1;

const CERTIFICATION_ORG_TYPES = Object.freeze(['MLS', 'Technology Company', 'Pooled Platform', 'Commercial', 'Brokerage']);

/**
 * Posts Data Dictionary results to the Certification API at the given URL.
 *
 * @param {Object} args includes the URL to post to and UOI and USI information
 * @returns reportId that was created
 * @throws if invalid JSON response or reportId is returned from the API
 */
const postDataDictionaryResultsToApi = async ({ url, providerUoi, providerUsi, recipientUoi, metadataReport = {} } = {}) => {
  if (!url) throw new Error('url is required!');
  if (!providerUoi) throw new Error('providerUoi is required!');
  if (!providerUsi) throw new Error('providerUsi is required!');
  if (!recipientUoi) throw new Error('recipientUoi is required!');
  if (!Object.keys(metadataReport)?.length) throw new Error('metadataReport is empty!');

  //TODO: add report pre-processing
  try {
    const response = await fetch(`${url}/api/v1/certification_reports/data_dictionary/${providerUoi}`, {
      headers: {
        Authorization: `ApiKey ${CERTIFICATION_API_KEY}`,
        recipientUoi,
        'Content-Type': 'application/json',
        providerUsi
      },
      method: 'POST',
      body: JSON.stringify(metadataReport)
    });

    if (!response.ok) throw new Error(`Received invalid response from the API! Status code: ${response.status}`);

    const { id: reportId = null } = await response.json();

    if (!(!!reportId && typeof reportId === 'string' && reportId?.length)) {
      throw new Error('Did not receive a valid reportId from the Certification API!');
    }
    return reportId;
  } catch (err) {
    throw new Error(`Could not post data dictionary results to API! ${err}`);
  }
};

/**
 *
 * Posts data availability reports to the API.
 *
 * @param {Object} args includes the URL of the Certification API, reportId, and report
 * @returns true if report was processed, false otherwise
 * @throws if report could not be processed or is in an invalid format
 */
const postDataAvailabilityResultsToApi = async ({ url, reportId, dataAvailabilityReport = {} } = {}) => {
  if (!url) throw new Error('url is required!');
  if (!reportId) throw new Error('reportId is required!');
  if (!Object.keys(dataAvailabilityReport)?.length) throw new Error('metadataReport is empty!');

  try {
    const response = await fetch(`${url}/api/v1/payload/data_availability/${reportId}`, {
      headers: {
        Authorization: `ApiKey ${CERTIFICATION_API_KEY}`,
        'Content-Type': 'application/json'
      },
      method: 'POST',
      body: JSON.stringify(dataAvailabilityReport)
    });

    if (!response.ok) return false;

    const { success = false } = await response.json();
    return success;
  } catch (err) {
    throw new Error(`Could not post data availability results to API!\n${err}`);
  }
};

/**
 * Processes DD results for the given org and reports.
 *
 * @param {Object} args include API, reports, and UOI/USI information
 * @returns outcome of posting availability results to API or null
 */
const processDataDictionaryResults = async ({
  url,
  providerUoi,
  providerUsi,
  recipientUoi,
  metadataReport = {},
  dataAvailabilityReport = {}
}) => {
  try {
    //wait for the dust to settle to avoid thrashing the server
    await sleep(API_DEBOUNCE_SECONDS * 1000);

    const reportId = await postDataDictionaryResultsToApi({
      url,
      providerUoi,
      providerUsi,
      recipientUoi,
      metadataReport
    });

    if (reportId) {
      //wait for the dust to settle to avoid thrashing the server
      await sleep(API_DEBOUNCE_SECONDS * 1000);
      return await postDataAvailabilityResultsToApi({ url, reportId, dataAvailabilityReport });
    } else {
      return null;
    }
  } catch (err) {
    throw new Error(`Could not process data dictionary results! ${err}`);
  }
};

/**
 * Creates a map of UOIs based on data in the ORGS_DATA_URL environment variable.
 *
 * @returns map of orgs eligible for certification
 */
const getOrgsMap = async () => {
  const ERR_MSG = `Could not fetch RESO UOI data!\nURL: ${ORGS_DATA_URL}`;

  try {
    const response = await fetch(ORGS_DATA_URL);
    if (!response.ok) throw new Error(`${ERR_MSG}\nStatus code: ${response.status}`);

    const { Data: uoiData = [] } = await response.json();

    return uoiData.reduce((acc, { OrganizationUniqueId, OrganizationType }) => {
      const uoi = !!OrganizationUniqueId && OrganizationUniqueId?.trim()?.length ? OrganizationUniqueId.trim() : null;
      const orgType = !!OrganizationType && OrganizationType?.trim()?.length ? OrganizationType.trim() : null;

      if (!(uoi && orgType && CERTIFICATION_ORG_TYPES.includes(orgType))) {
        return acc;
      }
      acc[uoi] = true;
      return acc;
    }, {});
  } catch (err) {
    throw new Error(`${ERR_MSG}\nError: ${err}`);
  }
};

/**
 * Creates a map of USIs based on data in the SYSTEMS_DATA_URL environment variable.
 * 
 * @returns current USIs 
 * @throws if USI data could not be fetched or processed
 */
const getOrgSystemsMap = async () => {
  try {
    const response = await fetch(SYSTEMS_DATA_URL);

    if (!response.ok) throw new Error(`Received invalid response from the API! Status code: ${response.status}`);

    const { values = [] } = await response.json();

    return values?.slice(1).reduce((acc, [providerUoi, , usi]) => {
      if (!acc?.[providerUoi]) acc[providerUoi] = [];
      acc[providerUoi].push(usi);
      return acc;
    }, {}) ?? {};

  } catch (err) {
    throw new Error(`Could not fetch RESO USI data!\nURL: ${SYSTEMS_DATA_URL}\nError: ${err}`);
  }
};

module.exports = {
  processDataDictionaryResults,
  getOrgsMap,
  getOrgSystemsMap
};
