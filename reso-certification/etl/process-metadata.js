const {
  getFieldsCount,
  getResourcesCount,
  getLookupsCount,
  getIdxCounts,
  getAdvertisedCountPerResourcesByType,
  getMetadata,
  getStandardMetadata
} = require('./common');

const ANNOTATION_TERM_STANDARD_NAME = 'RESO.OData.Metadata.StandardName';

/**
 * Processes a Data Dictionary metadata report.
 * @param {Object} body is the metadata report body generated during testing
 * @returns processed metadata report
 */
const processMetadataReport = (
  metadataReportJson
) => {
  const { fields, lookups, version, ...reportInfo } = metadataReportJson;

  if (!version) {
    throw new Error('Version is missing from metadata report!');
  }

  const standardMetadata = getStandardMetadata(version);

  const referenceLookups = lookups?.filter(
    (x) => !isReferencePlaceholderValue(x)
  );

  const transformedMetadataReportJson = {
    ...reportInfo,
    version,
    fields: getTransformedFields(fields, standardMetadata),
    lookups: getTransformedLookups(metadataReportJson),
  };

  return {
    ...transformedMetadataReportJson,
    ...getFieldsCount(fields, version),
    ...getResourcesCount(fields, version),
    ...getLookupsCount(transformedMetadataReportJson.lookups),
    ...getIdxCounts(fields, referenceLookups, version),
    advertised: getAdvertisedCountPerResourcesByType(
      transformedMetadataReportJson
    ),
  };
};

//TODO: convert to use a map instead
const getTransformedFields = (fields = [], standardMetadata = { fields: [] }) => {
  return fields.map((field) => {
    return {
      ...field,
      standardRESO: standardMetadata.fields.some(
        (x) =>
          x?.resourceName === field?.resourceName &&
          x?.fieldName === field?.fieldName
      ),
      payloads: standardMetadata.fields.find(
        (x) =>
          x?.resourceName === field?.resourceName &&
          x?.fieldName === field?.fieldName
      )?.payloads,
    };
  });
};

/**
 * Parses an OData fully qualified lookup name into its lookupName and FQDN.
 * @param {String} lookupName the lookup name to parse.
 * @returns an object containing the parsed lookupName and lookupNameFQDN.
 */
const parseLookupName = (lookupName = '') => {
  const FQDNSeparator = '.';
  return {
    lookupName:
      lookupName?.slice(lookupName?.lastIndexOf(FQDNSeparator) + 1) ?? null,
    lookupNameFQDN:
      lookupName?.slice(0, lookupName?.lastIndexOf(FQDNSeparator)) ?? null,
    lookupNameWithFQDN: lookupName,
  };
};

/**
 * Builds a template object for a given lookup report item from metadata report data.
 * @param {Object} lookupReportItem is a lookup item from a RESO metadata report.
 * @returns a metadata report lookup item with additional properties filled in.
 */
const buildLookupMetadataTemplate = (lookup = {}) => {
  const { lookupValue, annotations = [], type, lookupName = '' } = lookup;

  return {
    type,
    lookupValue,
    ...parseLookupName(lookupName),
    annotations,
  };
};

/**
 * Creates a field map from the given metadata report JSON.
 * @param {Object} metadataReportJson is a metadata report with a fields array.
 * @returns a map of all fields keyed by resourceName and standardName.
 */
const buildFieldMap = ({ fields = [] }) =>
  fields.reduce((cache, item) => {
    const { resourceName, fieldName } = item;

    if (!(resourceName && fieldName)) return cache;

    if (!cache[resourceName]) cache[resourceName] = {};
    cache[resourceName][fieldName] = item;
    return cache;
  }, {});

/**
 * Creates a lookup map from a RESO Metadata Report
 * @param {Object} metadataReportJson object containing a lookups array
 * @returns a map of normalized lookups keyed by lookupName and lookupValue matching the lookup template format.
 */
const buildLookupMap = (lookups = []) =>
  lookups.map(buildLookupMetadataTemplate).reduce((cache, item) => {
    const { lookupName, lookupValue } = item;

    if (!(lookupName && lookupValue)) return cache;

    if (!cache[lookupName]) cache[lookupName] = {};
    cache[lookupName][lookupValue] = item;
    return cache;
  }, {});

const findStandardDisplayNameAnnotation = (annotations = []) =>
  annotations?.find(({ term }) => term === ANNOTATION_TERM_STANDARD_NAME)
    ?.value;

/**
 * Creates a lookup display name map so that inbound annotations can be checked to see if a given lookup is standard (by display name).
 * @param {Array} lookups is a list of lookup items from the metadata report to create a name map from.
 * @returns a map of human friendly standard names for each lookup name / value pair.
 */
const buildStandardLookupValueMap = (lookups = []) => {
  return lookups
    .map(({ lookupName, lookupValue, annotations = [] }) => {
      return {
        lookupName: parseLookupName(lookupName)?.lookupName,
        lookupValue,
        standardDisplayName: findStandardDisplayNameAnnotation(annotations),
        annotations,
      };
    })
    .reduce((cache, item = {}) => {
      const { lookupName, lookupValue, standardDisplayName, annotations } =
        item;

      if (!(lookupName && (standardDisplayName ?? lookupValue))) return cache;
      if (!cache[lookupName]) cache[lookupName] = {};

      //add entry for the standard lookup value
      cache[lookupName][lookupValue] = {
        lookupName,
        lookupValue,
        standardDisplayName,
        annotations,
      };

      //if the display name is different from the lookup value, add an additional entry
      if (lookupValue !== standardDisplayName) {
        cache[lookupName][standardDisplayName] = {
          lookupName,
          lookupValue,
          standardDisplayName,
          annotations,
        };
      }

      return cache;
    }, {});
};

/**
 * Determines whether a given field is a lookup field by looking at its type.
 *
 * Assumes that the lookup type is a custom type, which doesn't start with "Edm."
 *
 * @param {Object} field is a field object that contains a type.
 * @returns true if the field is a lookup and false otherwise
 *
 */
const isLookupField = (field = '') => !field?.type?.startsWith('Edm.');

/**
 * Determines whether a given lookup is a placeholder value. These start with Sample, and end with EnumValue.
 * @param {Object} lookup is a lookup object with a lookupValue property.
 * @returns true if the lookup is a reference placeholder value, false otherwise.
 */
const isReferencePlaceholderValue = ({ lookupValue = '' }) =>
  lookupValue?.startsWith('Sample') && lookupValue?.endsWith('EnumValue');

/**
 * Processes a RESO metadata report and provides counts and information about which fields and lookups are standard.
 *
 * TODO: remove FQDN types from the processed items
 *
 * @param {Object} metadataReportJson the metadata report to process.
 * @returns {Array} list of items classified as standard RESO with their display names if they match.
 *
 *  [{
 *    "lookupName" : "PropertyEnums.PropertySubType",
 *    "lookupValue" : "SingleFamilyResidence",
 *    "type" : "Edm.Int32",
 *    "standardRESO" : true,
 *    "standardDisplayName" : "Single Family Residence"
 *  },
 *  ...]
 *
 */
const getTransformedLookups = (metadataReportJson = {}) => {
  if (!metadataReportJson?.lookups) return [];

  const referenceMetadataJson = getMetadata(metadataReportJson.version);
  const referenceFieldMap = buildFieldMap(referenceMetadataJson);

  //remove placeholder values added to the reference metadata for open enumerations without values
  //OData enums MUST have at least one value, so the reference metadata needed a sample value
  const referenceLookups =
    referenceMetadataJson?.lookups?.filter(
      (lookup) => !isReferencePlaceholderValue(lookup)
    ) ?? [];

  const referenceLookupNameValueMap =
    buildStandardLookupValueMap(referenceLookups);

  //create a lookup map of all lookups found in the metadata report
  const lookupMap = buildLookupMap(metadataReportJson?.lookups);

  return Object.values(
    (metadataReportJson?.fields ?? [])
      .filter(isLookupField)
      .flatMap((field = {}) => {
        const { resourceName, fieldName, type: fieldType } = field;

        //if the field is a standard lookup field, try processing it
        if (field && fieldType) {
          const { lookupName } = parseLookupName(fieldType);

          //try and extract a RESO standard field
          const standardField =
            resourceName &&
            fieldName &&
            referenceFieldMap[resourceName] &&
            referenceFieldMap[resourceName][fieldName];

          const { lookupName: resoLookupName } =
            parseLookupName(standardField?.type) ?? {};

          //get lookup maps for the given item
          const standardLookupValueMap =
            referenceLookupNameValueMap[resoLookupName] ?? {};

          if (!lookupMap[lookupName]) {
            return [];
          }

          return Object.values(lookupMap[lookupName])?.map((lookup) => {
            const {
              lookupValue,
              lookupNameWithFQDN: lookupName,
              type,
            } = lookup;

            //if the item is a standard lookup value, classify and return
            const standardLookupValueMatch =
              lookupValue && standardLookupValueMap[lookupValue];
            if (standardLookupValueMatch) {
              const { standardDisplayName } = standardLookupValueMatch;
              return {
                lookupName,
                lookupValue,
                type,
                standardRESO: true,
                standardDisplayName,
              };
            }

            //otherwise the lookup is local
            return { lookupName, lookupValue, type, standardRESO: false };
          });
        }
      })
      .reduce((cache, item = {}) => {
        //turning items into a hash to make them into a set
        const { lookupName, lookupValue } = item;
        if (!(lookupName && lookupValue)) return cache;
        if (!cache[lookupName + lookupValue])
          cache[lookupName + lookupValue] = item;
        return cache;
      }, {})
  );
};

module.exports = {
  processMetadataReport,
  parseLookupName,
  ANNOTATION_TERM_STANDARD_NAME,
};
