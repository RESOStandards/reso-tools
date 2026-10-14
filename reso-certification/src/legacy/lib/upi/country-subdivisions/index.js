'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_COUNTRY_CODE = 'US';

/**
 * Parses a new-line delimited string which has rows separated by
 * a given delimiter such as a comma or pipe character
 *
 * @param {String} data newline-delimited string data
 * @param {Array} fieldList list of JSON-based fields to map to
 * @param {Object} options set of parsing options
 * @returns JSON-based array of data in CSV
 * @throws Error if something can't be parsed or if the schema doesn't match the data
 */
const parseCsv = (data, fieldList, { separator = ',', hasHeader = true }) => {
  const lines = data.split('\n').reduce((acc, row, index) => {
    if (hasHeader && index === 0) return acc;

    const rowData = row && row?.length ? row.split(separator) : [];

    if (rowData?.length !== fieldList?.length) {
      throw new Error(`Schema mismatch. Number of columns in row ${index} is different from fieldList`);
    }

    const data = {};
    fieldList.forEach((fieldName, i) => (data[fieldName] = rowData[i]));
    acc.push(data);
    return acc;
  }, []);

  return lines;
};

/**
 * Returns the local set of reference counties or the given ISO 3166 country code.
 *
 * @returns JSON representation of the given pipe-delimited file
 * @see https://www.census.gov/library/reference/code-lists/ansi.html#cou
 * @see https://en.wikipedia.org/wiki/List_of_ISO_3166_country_codes
 *
 */
const getCountiesOrParishesForCountry = async (countryCode = DEFAULT_COUNTRY_CODE) => {
  // Header row: STATE|STATEFP|COUNTYFP|COUNTYNS|COUNTYNAME|CLASSFP|FUNCSTAT
  const FIELD_LIST = Object.freeze([
    'state',
    'stateFipsCode',
    'countyFipsCode',
    'countyNsCode',
    'countyName',
    'fipsClassCode',
    'functionalStatus'
  ]);

  let referenceData;

  try {
    referenceData = await readFile(path.resolve(`${__dirname}/${countryCode?.toLowerCase()}/counties.txt`), 'utf-8');
  } catch {
    throw new Error(`Could not find reference data for country code '${countryCode}'`);
  }

  try {
    const cache = parseCsv(referenceData, FIELD_LIST, { separator: '|' }).reduce((acc, cur) => {
      const { stateFipsCode, countyFipsCode } = cur;

      const key = stateFipsCode + countyFipsCode;

      if (stateFipsCode && countyFipsCode && !acc[key]) {
        acc[stateFipsCode + countyFipsCode] = { key, ...cur };
      }

      return acc;
    }, {});

    return cache;
  } catch (err) {
    throw new Error(`Could not get country subdivisions! Error: ${err}`);
  }
};

/**
 * Returns the local set of reference county subdivision files
 *
 * @returns JSON representation of the given pipe-delimited file
 * @see https://www.census.gov/library/reference/code-lists/ansi.html#cousub
 *
 */
const getCountySubdivisionsForCountry = async (countryCode = DEFAULT_COUNTRY_CODE) => {
  // Header row: STATE|STATEFP|COUNTYFP|COUNTYNAME|COUSUBFP|COUSUBNS|COUSUBNAME|CLASSFP|FUNCSTAT
  const FIELD_LIST = Object.freeze([
    'state',
    'stateFipsCode',
    'countyFipsCode',
    'countyName',
    'countySubdivisionFipsCode',
    'countySubdivisionNsCode',
    'countySubdivisionName',
    'fipsClassCode',
    'functionalStatus'
  ]);

  let referenceData;

  try {
    referenceData = await readFile(
      path.resolve(`${__dirname}/${countryCode?.toLowerCase()}/county-subdivisions.txt`),
      'utf-8'
    );
  } catch {
    throw new Error(`Could not find reference data for country code '${countryCode}'`);
  }

  try {
    return parseCsv(referenceData, FIELD_LIST, { separator: '|' }).reduce((acc, cur) => {
      const { stateFipsCode, countyFipsCode, countySubdivisionFipsCode } = cur;
      const key = stateFipsCode + countyFipsCode + countySubdivisionFipsCode;

      if (stateFipsCode && countyFipsCode && countySubdivisionFipsCode && !acc[key]) {
        acc[stateFipsCode + countyFipsCode + countySubdivisionFipsCode] = { key, ...cur };
      }

      return acc;
    }, {});
  } catch (err) {
    throw new Error(`Could not get country subdivisions! Error: ${err}`);
  }
};

const buildCountrySubdivisionCaches = async (countryCode = 'US') =>
  Object.freeze({
    countiesOrParishesCache: await getCountiesOrParishesForCountry(countryCode),
    countySubdivisionCache: await getCountySubdivisionsForCountry(countryCode)
  });

module.exports = {
  buildCountrySubdivisionCaches
};
