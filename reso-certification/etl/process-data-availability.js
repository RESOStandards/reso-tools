const { getLookupMap, getStandardMetadata, CATEGORIES } = require('./common');

/**
 * Defines the bins template for stats.
 * @returns bins template with all bins initialized to 0.
 */
const getBinsTemplate = () => {
  return {
    eqZero: 0,
    gtZero: 0,
    gte25: 0,
    gte50: 0,
    gte75: 0,
    eq100: 0
  };
};

/**
 * Defines the totals template for stats.
 * @returns totals template with all bins initialized to 0.
 */
const getTotalsTemplate = () => {
  return {
    total: getBinsTemplate(),
    reso: getBinsTemplate(),
    idx: getBinsTemplate(),
    local: getBinsTemplate()
  };
};

/**
 * Defines the set of bins used for availability totals.
 * @returns totals template with all bins initialized to 0.
 */
const getAvailabilityTotalsTemplate = () => {
  return {
    total: getBinsTemplate(),
    reso: getBinsTemplate(),
    idx: getBinsTemplate(),
    local: getBinsTemplate()
  };
};

/**
 * Defines the availability template for stats. This is the structure of the processed results.
 * @returns availability template with all totals and bins initialized to 0.
 */
const getAvailabilityTemplate = () => {
  return {
    fields: [],
    lookups: [],
    lookupValues: [],
    resources: [],
    availability: {
      fields: getAvailabilityTotalsTemplate(),
      lookups: getAvailabilityTotalsTemplate(),
      resources: {},
      resourcesBinary: {}
    }
  };
};

/**
 * Builds a standard field cache from a list of standard fields.
 * @param {Array} fields an array of standard fields.
 * @returns map of all standard fields addressable by cache[resourceName][fieldName]
 *          or an empty map if there are none.
 */
const createStandardFieldCache = (fields = []) =>
  fields.reduce((cache, item) => {
    const { resourceName, fieldName } = item;

    if (!(resourceName && fieldName)) return cache;

    if (!cache[resourceName]) {
      cache[resourceName] = {};
    }
    cache[resourceName][fieldName] = item;

    return cache;
  }, {});

/**
 * Builds a lookup value cache from a list of individual lookup value items.
 * @param {Array} lookupValues the lookup values to create the cache from.
 * @returns map of all lookups addressable by cache[resourceName][fieldName][lookupValue]
 *          or an empty map if there are none.
 */
const createLookupValueCache = (lookupValues = []) => {
  return lookupValues.reduce((cache, item) => {
    const { resourceName, fieldName, lookupValue, parentResourceName } = item;
    if (parentResourceName) {
      if (!cache[parentResourceName]) {
        cache[parentResourceName] = { expansions: {} };
      }
      if (!cache[parentResourceName].expansions[resourceName]) {
        cache[parentResourceName].expansions[resourceName] = {};
      }
      if (!cache[parentResourceName].expansions[resourceName][fieldName]) {
        cache[parentResourceName].expansions[resourceName][fieldName] = {};
      }
      cache[parentResourceName].expansions[resourceName][fieldName][lookupValue] = item;
    } else {
      if (!cache[resourceName]) {
        cache[resourceName] = { expansions: {} };
      }
      if (!cache[resourceName][fieldName]) {
        cache[resourceName][fieldName] = {};
      }
      cache[resourceName][fieldName][lookupValue] = item;
    }
    return cache;
  }, {});
};

/**
 * Determines whether a given field is an IDX field.
 * TODO: The performance could be improved here in that there's a filter being done on each payloads array.
 *       There's potential speedup if each payload were turned into a nested property rather than an array.
 * @param {String} resourceName the name of the resource for the field.
 * @param {String} fieldName the name of the field.
 * @param {Object} standardFieldCache a field cache created by createStandardFieldCache().
 * @returns true if the given field is an IDX field, false otherwise.
 */
const isIdxField = (resourceName, fieldName, standardFieldCache = {}) =>
  resourceName &&
  fieldName &&
  isResoField(resourceName, fieldName, standardFieldCache) &&
  !!standardFieldCache[resourceName][fieldName]?.payloads?.some(x => x === 'IDX');

/**
 * Determines whether a given field is a RESO field.
 * @param {String} resourceName the name of the resource for the field.
 * @param {String} fieldName the name of the field.
 * @param {Object} standardFieldCache a field cache created by createStandardFieldCache().
 * @returns true if the given field is a RESO field, false otherwise.
 */
const isResoField = (resourceName, fieldName, standardFieldCache = {}) =>
  resourceName && fieldName && standardFieldCache[resourceName] && !!standardFieldCache[resourceName][fieldName];

/**
 * Determines if a given lookup is a RESO lookup.
 * @param {String} resourceName the name of the resource for the field.
 * @param {String} fieldName the name of the field.
 * @param {String} lookupValue the name of the lookup to test.
 * @param {Object} standardFieldCache a field cache created by createStandardFieldCache().
 * @param {Object} lookupMap standard lookup map
 * @returns the RESO lookup, if found, otherwise null.
 */
const findResoLookup = (resourceName, fieldName, lookupValue, standardFieldCache = {}, lookupMap = {}) => {
  if (resourceName && fieldName && standardFieldCache[resourceName] && standardFieldCache[resourceName][fieldName]) {
    const field = standardFieldCache[resourceName][fieldName];

    if (field && field.simpleDataType?.includes('String List') && field.type?.includes('.')) {
      const lookupName = field.type.substring(field.type.lastIndexOf('.') + 1, field.type.length);
      const lookup = lookupMap[lookupName]?.find(x => x?.lookupValue === lookupValue || x?.lookupDisplayName === lookupValue);
      //TODO: turn the lookup map into its own inverted hash by lookup values and display names
      return lookup ? { lookupName, lookup } : null;
    }
  }
  return null;
};

/**
 * Computes availability from existing bins.
 * @param {Number} availability the current availability value.
 * @param {Object} bins existing bins containing past availability values.
 * @returns a new object following the getBinsTemplate structure that contains updated availabilities for each bin.
 */
const computeBins = (availability, bins) => {
  bins = bins || getBinsTemplate();
  return {
    eqZero: availability === 0 ? bins.eqZero + 1 : bins.eqZero,
    gtZero: availability > 0 ? bins.gtZero + 1 : bins.gtZero,
    gte25: availability >= 0.25 ? bins.gte25 + 1 : bins.gte25,
    gte50: availability >= 0.5 ? bins.gte50 + 1 : bins.gte50,
    gte75: availability >= 0.75 ? bins.gte75 + 1 : bins.gte75,
    eq100: availability === 1 ? bins.eq100 + 1 : bins.eq100
  };
};

const getAvailabilityAggregatesByResourceTemplate = () => {
  return {
    fields: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 },
    fieldCounts: { total: 0, reso: 0, idx: 0, local: 0 },
    lookups: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 },
    lookupCounts: { total: 0, reso: 0, idx: 0, local: 0 }
  };
};

/**
 * Processes a RESO Data Availability Report and creates aggregates and roll-ups.
 * TODO: individual totals calculations could be tidied up a bit.
 * @param {Object} availabilityReport the RESO availability report JSON to process.
 * @returns a JSON availability report with the appropriate roll-ups and aggregates.
 */
const processDataAvailability = async (availabilityReport, useNewReportFormat = true) => {
  //iterate over each field and lookup and compute their availabilities
  const { resources, fields, lookups, lookupValues, version, ...rest } = availabilityReport;

  const lookupMap = getLookupMap(version);
  const standardMetadata = getStandardMetadata(version);

  const transformed = getAvailabilityTemplate();
  const standardFieldCache = createStandardFieldCache(standardMetadata.fields);

  const { resourceCounts, expandedResourcesCounts } = resources.reduce(
    (acc, curr) => {
      const { resourceName, numRecordsFetched, expansions, numUniqueRecordsFetched } = curr;
      const totalFetchedRecords = useNewReportFormat ? numUniqueRecordsFetched : numRecordsFetched;
      acc.resourceCounts[resourceName] = totalFetchedRecords;
      expansions?.forEach(expansion => {
        const totalFetchedExpandedRecords = useNewReportFormat ? expansion.numUniqueRecordsFetched : expansion.numRecordsFetched;
        if (!acc.expandedResourcesCounts[resourceName]) {
          acc.expandedResourcesCounts[resourceName] = {};
        }
        acc.expandedResourcesCounts[resourceName][expansion.resourceName] = totalFetchedExpandedRecords;
      });
      return acc;
    },
    {
      resourceCounts: {},
      expandedResourcesCounts: {}
    }
  );

  const processedFields = [],
    processedLookupValues = [],
    lookupValueCache = createLookupValueCache(lookupValues);

  //binary resource availability cache
  const resourcesBinary = {};

  //resource availability cache
  const availabilityAggregatesByResource = {};

  //process fields
  fields.forEach(field => {
    const { resourceName, fieldName, parentResourceName } = field;

    const isExpansion = parentResourceName && parentResourceName?.length;

    const count = parentResourceName ? expandedResourcesCounts[parentResourceName]?.[resourceName] : resourceCounts[resourceName];
    const availability = field?.frequency && count ? (1.0 * field.frequency) / count : 0.0;

    //create template if not already present
    if (!availabilityAggregatesByResource[resourceName]) {
      availabilityAggregatesByResource[resourceName] = getAvailabilityAggregatesByResourceTemplate();
    }

    if (isExpansion) {
      if (!availabilityAggregatesByResource[parentResourceName]) {
        availabilityAggregatesByResource[parentResourceName] = getAvailabilityAggregatesByResourceTemplate();
      }
      if (!availabilityAggregatesByResource[parentResourceName].expansions) {
        availabilityAggregatesByResource[parentResourceName].expansions = {};
      }
      if (!availabilityAggregatesByResource[parentResourceName].expansions[resourceName]) {
        availabilityAggregatesByResource[parentResourceName].expansions[resourceName] = getAvailabilityAggregatesByResourceTemplate();
      }
    }

    //update resource availability and counts
    updateAvailabilityCache({
      resourceName,
      availability,
      availabilityAggregatesByResource,
      parentResourceName,
      type: 'fields', // fields or lookups
      category: CATEGORIES.TOTAL // total, reso, idx, local
    });

    //update aggregate availability
    transformed.availability.fields.total = computeBins(availability, transformed.availability.fields.total);

    //initialize discrete availability map if it does't exist
    if (!resourcesBinary[resourceName]) {
      resourcesBinary[resourceName] = {
        fields: getTotalsTemplate(),
        lookups: getTotalsTemplate()
      };
    }

    if (isExpansion) {
      if (!resourcesBinary[parentResourceName]) {
        resourcesBinary[parentResourceName] = {
          fields: getTotalsTemplate(),
          lookups: getTotalsTemplate(),
          expansions: {}
        };
      }
      if (!resourcesBinary[parentResourceName].expansions) {
        resourcesBinary[parentResourceName].expansions = {};
      }
      if (!resourcesBinary[parentResourceName].expansions[resourceName]) {
        resourcesBinary[parentResourceName].expansions[resourceName] = {
          fields: getTotalsTemplate(),
          lookups: getTotalsTemplate()
        };
      }
    }

    //update discrete availability
    updateResourceBinaryAvailability({
      resourceName,
      type: 'fields', // fields or lookups
      category: CATEGORIES.TOTAL, // total, reso, idx, local
      availability,
      resourcesBinary,
      parentResourceName
    });

    if (isResoField(resourceName, fieldName, standardFieldCache)) {
      //update resource availability and counts
      updateAvailabilityCache({
        resourceName,
        availability,
        availabilityAggregatesByResource,
        parentResourceName,
        type: 'fields', // fields or lookups
        category: CATEGORIES.RESO // total, reso, idx, local
      });

      //update aggregate availability
      transformed.availability.fields.reso = computeBins(availability, transformed.availability.fields.reso);

      //update discrete availability
      updateResourceBinaryAvailability({
        resourceName,
        type: 'fields', // fields or lookups
        category: CATEGORIES.RESO, // total, reso, idx, local
        availability,
        resourcesBinary,
        parentResourceName
      });

      if (isIdxField(resourceName, fieldName, standardFieldCache)) {
        //update resource availability and counts
        updateAvailabilityCache({
          resourceName,
          availability,
          availabilityAggregatesByResource,
          parentResourceName,
          type: 'fields', // fields or lookups
          category: CATEGORIES.IDX // total, reso, idx, local
        });

        //update aggregate availability
        transformed.availability.fields.idx = computeBins(availability, transformed.availability.fields.idx);

        //update discrete availability
        updateResourceBinaryAvailability({
          resourceName,
          type: 'fields', // fields or lookups
          category: CATEGORIES.IDX, // total, reso, idx, local
          availability,
          resourcesBinary,
          parentResourceName
        });
      }
    } else {
      //update resource availability and counts
      updateAvailabilityCache({
        resourceName,
        availability,
        availabilityAggregatesByResource,
        parentResourceName,
        type: 'fields', // fields or lookups
        category: CATEGORIES.LOCAL // total, reso, idx, local
      });

      //update aggregate availability
      transformed.availability.fields.local = computeBins(availability, transformed.availability.fields.local);

      //update discrete availability
      updateResourceBinaryAvailability({
        resourceName,
        type: 'fields', // fields or lookups
        category: CATEGORIES.LOCAL, // total, reso, idx, local
        availability,
        resourcesBinary,
        parentResourceName
      });
    }

    const lookupsForField = isExpansion
      ? lookupValueCache[parentResourceName]?.expansions?.[resourceName]?.[fieldName]
      : lookupValueCache[resourceName]?.[fieldName];

    //only process if there are lookups for this field
    if (lookupsForField) {
      Object.values(lookupsForField).forEach(lookupValue => {
        if (lookupValue && lookupValue?.lookupValue !== 'NULL_VALUE') {
          const lookupAvailability = lookupValue?.frequency && count ? (1.0 * lookupValue.frequency) / count : 0.0;

          //update resource availability and counts
          updateAvailabilityCache({
            resourceName,
            availability: lookupAvailability,
            availabilityAggregatesByResource,
            parentResourceName,
            type: 'lookups', // fields or lookups
            category: CATEGORIES.TOTAL // total, reso, idx, local
          });

          //update aggregate availability
          transformed.availability.lookups.total = computeBins(lookupAvailability, transformed.availability.lookups.total);

          //update discrete availability
          updateResourceBinaryAvailability({
            resourceName,
            type: 'lookups', // fields or lookups
            category: CATEGORIES.TOTAL, // total, reso, idx, local
            availability: lookupAvailability,
            resourcesBinary,
            parentResourceName
          });

          if (
            isResoField(lookupValue.resourceName, lookupValue.fieldName, standardFieldCache) &&
            findResoLookup(lookupValue.resourceName, lookupValue.fieldName, lookupValue.lookupValue, standardFieldCache, lookupMap)
          ) {
            //update resource availability and counts
            updateAvailabilityCache({
              resourceName,
              availability: lookupAvailability,
              availabilityAggregatesByResource,
              parentResourceName,
              type: 'lookups', // fields or lookups
              category: CATEGORIES.RESO // total, reso, idx, local
            });

            //update aggregate availability
            transformed.availability.lookups.reso = computeBins(lookupAvailability, transformed.availability.lookups.reso);

            //update discrete availability
            updateResourceBinaryAvailability({
              resourceName,
              type: 'lookups', // fields or lookups
              category: CATEGORIES.RESO, // total, reso, idx, local
              availability: lookupAvailability,
              resourcesBinary,
              parentResourceName
            });

            if (isIdxField(lookupValue.resourceName, lookupValue.fieldName, standardFieldCache)) {
              //update resource availability and counts
              updateAvailabilityCache({
                resourceName,
                availability: lookupAvailability,
                availabilityAggregatesByResource,
                parentResourceName,
                type: 'lookups', // fields or lookups
                category: CATEGORIES.IDX // total, reso, idx, local
              });

              //update aggregate availability
              transformed.availability.lookups.idx = computeBins(lookupAvailability, transformed.availability.lookups.idx);

              //update discrete availability
              updateResourceBinaryAvailability({
                resourceName,
                type: 'lookups', // fields or lookups
                category: CATEGORIES.IDX, // total, reso, idx, local
                availability: lookupAvailability,
                resourcesBinary,
                parentResourceName
              });
            }
          } else {
            //update availability and counts
            updateAvailabilityCache({
              resourceName,
              availability: lookupAvailability,
              availabilityAggregatesByResource,
              parentResourceName,
              type: 'lookups', // fields or lookups
              category: CATEGORIES.LOCAL // total, reso, idx, local
            });

            //update update aggregate availability
            transformed.availability.lookups.local = computeBins(lookupAvailability, transformed.availability.lookups.local);

            //update discrete availability
            updateResourceBinaryAvailability({
              resourceName,
              type: 'lookups', // fields or lookups
              category: CATEGORIES.LOCAL, // total, reso, idx, local
              availability: lookupAvailability,
              resourcesBinary,
              parentResourceName
            });
          }

          processedLookupValues.push({
            ...lookupValue,
            availability: lookupAvailability
          });
        }
      });
    }

    //should always be OK, but just in case
    if (field) {
      processedFields.push({
        ...field,
        availability
      });
    }
  });

  transformed.version = version;
  transformed.resources = resources;
  transformed.fields = processedFields;
  transformed.lookups = lookups;
  transformed.lookupValues = processedLookupValues;
  transformed.availability.resourcesBinary = resourcesBinary;
  transformed.availability.resources = computeResourceAvailability(availabilityAggregatesByResource);

  return { ...rest, ...transformed };
};

const updateResourceBinaryAvailability = ({ resourceName, type, category, availability, resourcesBinary, parentResourceName } = {}) => {
  if (parentResourceName) {
    resourcesBinary[parentResourceName].expansions[resourceName][type][category] = computeBins(
      availability,
      resourcesBinary[parentResourceName].expansions[resourceName][type][category]
    );
  } else {
    resourcesBinary[resourceName][type][category] = computeBins(availability, resourcesBinary[resourceName][type][category]);
  }
};

/**
 *
 * @param {Object} obj
 * @param {String} obj.resourceName
 * @param {Number} obj.availability
 * @param {Object} obj.availabilityAggregatesByResource
 * @param {String} obj.parentResourceName
 * @param {String} obj.type
 * @param {String} obj.category
 * @description Updates availability aggregates for a given resource.
 */
const updateAvailabilityCache = ({
  resourceName,
  availability,
  availabilityAggregatesByResource,
  parentResourceName,
  type,
  category
} = {}) => {
  const countType = type === 'fields' ? 'fieldCounts' : 'lookupCounts';
  if (parentResourceName) {
    availabilityAggregatesByResource[parentResourceName].expansions[resourceName][type][category] += availability;
    availabilityAggregatesByResource[parentResourceName].expansions[resourceName][countType][category]++;
  } else {
    availabilityAggregatesByResource[resourceName][type][category] += availability;
    availabilityAggregatesByResource[resourceName][countType][category]++;
  }
};

/**
 * Computes resource availability aggregates.
 * @param {*} availabilityAggregatesByResource overall resource availability from sum of field availability
 * @returns
 */
const computeResourceAvailability = availabilityAggregatesByResource => {
  return Object.entries(availabilityAggregatesByResource).reduce((acc, [resourceName, { fields, lookups, expansions }]) => {
    if (!acc[resourceName])
      acc[resourceName] = {
        fields: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 },
        lookups: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 }
      };

    if (expansions && Object.entries(expansions).length) {
      Object.entries(expansions).forEach(([expandedResourceName, { fields, lookups }]) => {
        if (!acc[resourceName].expansions) {
          acc[resourceName].expansions = {};
        }
        if (!acc[resourceName].expansions[expandedResourceName]) {
          acc[resourceName].expansions[expandedResourceName] = {
            fields: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 },
            lookups: { total: 0.0, reso: 0.0, idx: 0.0, local: 0.0 }
          };
        }

        updateAvailability({
          acc,
          resourceName,
          expandedResourceName,
          type: 'fields',
          data: fields,
          availabilityAggregatesByResource
        });

        updateAvailability({
          acc,
          resourceName,
          expandedResourceName,
          type: 'lookups',
          data: lookups,
          availabilityAggregatesByResource
        });
      });
    }

    updateAvailability({
      acc,
      resourceName,
      type: 'fields',
      data: fields,
      availabilityAggregatesByResource
    });

    updateAvailability({
      acc,
      resourceName,
      type: 'lookups',
      data: lookups,
      availabilityAggregatesByResource
    });

    return acc;
  }, {});
};

/**
 *
 * @param {Object} obj
 * @param {Object} obj.acc
 * @param {String} obj.resourceName
 * @param {String} obj.expandedResourceName
 * @param {String} obj.type
 * @param {Object} obj.data
 * @param {Object} obj.availabilityAggregatesByResource
 * @description Updates availability for a given resource and expansion resource.
 */
const updateAvailability = ({ acc, resourceName, expandedResourceName, type, data, availabilityAggregatesByResource }) => {
  const countType = type === 'fields' ? 'fieldCounts' : 'lookupCounts';
  Object.values(CATEGORIES).forEach(category => {
    if (expandedResourceName) {
      acc[resourceName].expansions[expandedResourceName][type][category] =
        (1.0 * data[category]) /
        (availabilityAggregatesByResource[resourceName]?.expansions[expandedResourceName]?.[countType]?.[category] || 1);
    } else {
      acc[resourceName][type][category] =
        (1.0 * data[category]) / (availabilityAggregatesByResource[resourceName]?.[countType]?.[category] || 1);
    }
  });
};

module.exports = {
  processDataAvailability,
  createStandardFieldCache,
  isIdxField,
  isResoField
};
