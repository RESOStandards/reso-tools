'use strict';

const { DEFAULT_UPI_VERSION, DEFAULT_DD_VERSION } = require('../../common');
const { buildCountrySubdivisionCaches } = require('./country-subdivisions');

const UPI_SEPARATOR = ':',
  SUBCOMPONENT_SEPARATOR = `${UPI_SEPARATOR}sub${UPI_SEPARATOR}`,
  UPI_STEM = `urn${UPI_SEPARATOR}reso${UPI_SEPARATOR}upi`;

const ISO_COUNTRY_CODES = Object.freeze({
  US: 'US'
});

const SUPPORTED_COUNTRIES = Object.freeze(Object.keys(ISO_COUNTRY_CODES));

/**
 *
 * Parses the given UPI string. Uses the the default version of the UPI.
 *
 * @see https://upi.reso.org
 * @see https://www.census.gov/programs-surveys/geography/guidance/geo-identifiers.html
 *
 * @param {String} upiString a correctly formatted UPI string for a given version and country
 * @returns A parsed payload for the given UPI if correctly-formed.
 * @throws Error if UPI isn't correctly formed for the given version and country.
 */
const parseUpi = upiString => {
  if (!(upiString && upiString?.startsWith(UPI_STEM))) {
    throw new Error(`Incorrectly formatted UPI! Must begin with '${UPI_SEPARATOR}'`);
  }

  const [, upiParts] = upiString.split(`${UPI_STEM}${UPI_SEPARATOR}`);

  if (!(upiParts && upiParts?.length)) {
    throw new Error(`Malformed UPI! '${upiString}'`);
  }

  // parcelSubcomponent needs to be removed from main UPI string, if present, since it uses
  // a different delimiter (:sub:) from the normal UPI delimiter of colon
  const [primaryComponents, parcelSubcomponent] = upiParts.split(SUBCOMPONENT_SEPARATOR);

  const [version, country, countrySubdivision, parcelNumber] = primaryComponents.split(UPI_SEPARATOR) ?? [];

  if (!(version && version === DEFAULT_UPI_VERSION)) {
    throw new Error(`UPI version of '${version}' is not supported!`);
  }

  if (!(country && SUPPORTED_COUNTRIES.includes(country))) {
    throw new Error(`Country '${country}' is not supported for UPI version '${version}'!`);
  }

  if (!(countrySubdivision && countrySubdivision?.length)) {
    throw new Error('CountrySubdivision is required!');
  }

  if (!(parcelNumber && parcelNumber?.length)) {
    throw new Error(`ParcelNumber is required for UPI version '${version}'`);
  }

  return {
    '@reso.context': `urn:reso:metadata:${DEFAULT_DD_VERSION}:resource:property`,
    Country: country,
    CountrySubdivision: countrySubdivision,
    ParcelNumber: parcelNumber,
    ParcelSubcomponent: parcelSubcomponent
  };
};

/**
 * Validates the given country subdivision
 * @param {Object} params countrySubdivision to validate with the given subdivisionCache
 * @returns true if valid, false otherwise
 */
const validateCountrySubdivision = (countrySubdivision, countrySubdivisionCache) =>
  !!(
    countrySubdivision &&
    countrySubdivision?.length &&
    countrySubdivisionCache &&
    Object.values(countrySubdivisionCache)?.length &&
    !!(
      countrySubdivisionCache?.countiesOrParishesCache?.[countrySubdivision] ||
      countrySubdivisionCache?.countySubdivisionsCache?.[countrySubdivision]
    )
  );

module.exports = {
  parseUpi,
  validateCountrySubdivision,
  buildCountrySubdivisionCaches,
  ISO_COUNTRY_CODES,
  SUPPORTED_COUNTRIES,
  UPI_SEPARATOR
};
