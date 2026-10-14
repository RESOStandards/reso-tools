'use strict';

const { DEFAULT_UPI_VERSION } = require('../../../common');
const { readFile, writeFile } = require('node:fs/promises');
const { parseUpi, validateCountrySubdivision, buildCountrySubdivisionCaches, ISO_COUNTRY_CODES } = require('../../upi');

/**
 *
 * Runs UPI tests for one or more items in RESO Common Format.
 * Also validates countries and country subdivisions.
 *
 * @param {Object} options the set of options used to run the tests with. Supports library or CLI (interactive) use
 * @returns validation report if called as a library, otherwise writes the file to the local filesystem
 */
const runUpiTests = async ({
  resoCommonFormatJson = {},
  fromCli = false,
  pathToResoCommonFormatJson,
  version = DEFAULT_UPI_VERSION,
  writeOutput = fromCli || false
} = {}) => {
  if (
    !(
      (resoCommonFormatJson && Object.values(resoCommonFormatJson)?.length) ||
      (pathToResoCommonFormatJson && pathToResoCommonFormatJson?.length)
    )
  ) {
    throw new Error('One of resoCommonFormatJson or pathToResoCommonFormatJson are required!');
  }

  // TODO: turn this into a singleton service that gets created in parseUpi and
  // lazily creates a cache for each country based on whether it's there on not.
  // For now, we can eagerly create a cache and pass it in for simplicity
  const COUNTRY_SUBDIVISION_CACHE = await buildCountrySubdivisionCaches(ISO_COUNTRY_CODES.US);

  const invalidIds = [];
  const upiData = [];

  try {
    const parsedJson =
      (resoCommonFormatJson && Object.values(resoCommonFormatJson)?.length
        ? resoCommonFormatJson
        : JSON.parse(await readFile(pathToResoCommonFormatJson))) ?? {};

    if (pathToResoCommonFormatJson?.length && !parsedJson) {
      // TODO: need to handle when a path to a directory of individual RCF files is used
      throw new Error(`RESO Common Format JSON could not be loaded from path: '${pathToResoCommonFormatJson}'`);
    }

    const { value } = parsedJson;

    if (Array.isArray(parsedJson.value)) {
      upiData.push(...value);
    } else {
      upiData.push(parsedJson);
    }

    upiData.forEach(item => {
      const { UniversalParcelId, Country: suppliedCountry, CountrySubdivision: suppliedCountrySubdivision, ParcelNumber: suppliedParcelNumber } = item;

      if (!UniversalParcelId) {
        throw new Error('UniversalParcelId not present in data!');
      }

      if (!UniversalParcelId?.length) {
        throw new Error('Empty UniversalParcelId in data!');
      }

      try {
        const { Country: parsedCountry, CountrySubdivision: parsedCountrySubdivision, ParcelNumber: parsedParcelNumber } = parseUpi(UniversalParcelId);

        if (!validateCountrySubdivision(parsedCountrySubdivision, COUNTRY_SUBDIVISION_CACHE)) {
          invalidIds.push({ upi: UniversalParcelId, error: `Invalid country subdivision '${parsedCountrySubdivision}'` });
        }

        if (suppliedParcelNumber && suppliedParcelNumber !== parsedParcelNumber) {
          //console.error(`Parsed parcel number '${parsedParcelNumber}' differs from the one provided in the payload: '${suppliedParcelNumber}'`);
          invalidIds.push({ upi: parsedParcelNumber, error: 'Parsed UPI mismatch with UPI data' });
        }

        if (suppliedCountry && suppliedCountry !== parsedCountry) {
          invalidIds.push({ upi: UniversalParcelId, error: 'Parsed UPI mismatch with UPI data' });
        }

        if (suppliedCountrySubdivision && suppliedCountrySubdivision !== parsedCountrySubdivision) {
          invalidIds.push({ upi: UniversalParcelId, error: 'Parsed UPI mismatch with UPI data' });
        }
      } catch (err) {
        invalidIds.push({ upi: UniversalParcelId, error: err?.message ?? 'Parsing Error' });
      }
    });
  } finally {
    const testsPassed = invalidIds?.length === 0;

    const UPI_REPORT_FILE_NAME = 'upi-validation-report.json';
    const upiValidationReport = {
      description: 'RESO UPI Validation Report',
      version,
      generatedOn: new Date().toISOString()
    };

    if (testsPassed) {
      if (fromCli) {
        console.log('UPI tests passed!');
      }

      upiValidationReport.numValidRecords = upiData.length;
    } else {
      if (fromCli) {
        console.log(`UPI tests failed! Error count: ${invalidIds.length}`);
      }

      upiValidationReport.errors = invalidIds;
    }

    if (fromCli || writeOutput) {
      await writeFile(UPI_REPORT_FILE_NAME, JSON.stringify(upiValidationReport));
      console.log(`See ./${UPI_REPORT_FILE_NAME} for more information`);
    } else {
      return upiValidationReport;
    }
  }
};

module.exports = {
  runUpiTests
};
