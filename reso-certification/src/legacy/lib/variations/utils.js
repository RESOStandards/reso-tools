'use strict';

/**
 * Defines well-known column names for CSV and JSON formats
 */
const columns = Object.freeze([
  { sheetColumnName: 'Resource Name', jsonName: 'resourceName' },
  { sheetColumnName: 'Field Name', jsonName: 'fieldName' },
  { sheetColumnName: 'Lookup Value', jsonName: 'lookupValue' },
  { sheetColumnName: 'Suggested Resource Name', jsonName: 'suggestedResourceName' },
  { sheetColumnName: 'Suggested Field Name', jsonName: 'suggestedFieldName' },
  { sheetColumnName: 'Suggested Lookup Value', jsonName: 'suggestedLookupValue' },
  { sheetColumnName: 'Suggested Related Resource Name', jsonName: 'suggestedRelatedResourceName' },
  { sheetColumnName: 'Suggested Related Field Name', jsonName: 'suggestedRelatedFieldName' },
  { sheetColumnName: 'Suggested Related Lookup Value', jsonName: 'suggestedRelatedLookupValue' },
  { sheetColumnName: 'Outcome', jsonName: 'outcome' }
]);

/**
 * Converts CSV mapping data to JSON format for ingest
 * @param {String} csvData a string representing CSV data (including headers)
 * @returns JSON data corresponding to the csvData that was provided
 */
const convertVariationsCsvToJson = (csvData = '') => {
  const DELIMITER = ',';

  const [headerRow, ...suggestions] = csvData?.trim()?.split('\n') ?? [];

  if (!(headerRow && headerRow?.length && headerRow.includes(DELIMITER))) {
    throw new Error('Header row isn\'t in the correct format!');
  }

  const columnIndexMap = headerRow.split(DELIMITER).reduce((acc, cur, i) => {
    const columnInfo = columns.find(column => column?.sheetColumnName?.includes(cur?.trim()));
    if (columnInfo && Object.values(columnInfo)?.length) {
      acc[i] = columnInfo;
    }
    return acc;
  }, {});

  if (Object.values(columnIndexMap)?.length === 0) {
    throw new Error('Could not find any supported columns! Check header format.');
  } else if (suggestions?.length === 0) {
    throw new Error('No suggestions provided!');
  } else {
    return suggestions.map(suggestion => {
      const values = suggestion.split(DELIMITER) ?? [];
      return values.reduce((acc, value, i) => {
        if (!!value?.trim() && !!columnIndexMap[i]?.jsonName) {
          acc[columnIndexMap[i].jsonName] = value.trim();
        }
        return acc;
      }, {});
    });
  }
};

module.exports = {
  convertVariationsCsvToJson
};
