const {
  processMetadata: { ANNOTATION_TERM_STANDARD_NAME }
} = require('../../index.cjs');
const { reportTypes } = require('../../common.cjs');

const metadataReport = {
  description: 'RESO Data Dictionary Metadata Report',
  version: '1.7',
  generatedOn: '2022-03-15T10:12:32.319Z',
  type: reportTypes.DATA_DICTIONARY.name,
  fields: [
    {
      resourceName: 'Office',
      fieldName: 'OfficeStateOrProvince',
      type: 'States'
    },
    {
      resourceName: 'Property',
      fieldName: 'AccessibilityFeatures',
      type: 'PropertyEnums.AccessibilityFeatures'
    },
    {
      resourceName: 'Property',
      fieldName: 'StandardStatus',
      type: 'PropertyEnums.Statuses'
    },
    {
      resourceName: 'Property',
      fieldName: 'ListPrice',
      type: 'Edm.Decimal'
    },
    {
      resourceName: 'Property',
      fieldName: 'CustomLookupField123',
      type: 'CustomLookups.LookupField123'
    }
  ],
  lookups: [
    {
      lookupName: 'States',
      lookupValue: 'CA',
      type: 'Edm.Int32'
    },
    {
      lookupName: 'States',
      lookupValue: 'HI',
      type: 'Edm.Int32'
    },
    {
      lookupName: 'PropertyEnums.AccessibilityFeatures',
      lookupValue: '_23923049',
      type: 'Edm.Int32',
      annotations: [
        {
          term: ANNOTATION_TERM_STANDARD_NAME,
          value: 'Accessible Approach with Ramp'
        }
      ]
    },
    {
      lookupName: 'PropertyEnums.AccessibilityFeatures',
      lookupValue: 'ReinforcedFloors',
      type: 'Edm.Int32'
    },
    {
      lookupName: 'PropertyEnums.AccessibilityFeatures',
      lookupValue: 'PrivateElevator',
      type: 'Edm.Int32'
    },
    {
      lookupName: 'PropertyEnums.Statuses',
      lookupValue: 'Pending',
      type: 'Edm.Int32',
      annotations: [{ term: ANNOTATION_TERM_STANDARD_NAME, value: 'Pending' }]
    },
    {
      lookupName: 'PropertyEnums.Statuses',
      lookupValue: 'ACTIVE_UC',
      type: 'Edm.Int32',
      annotations: [
        {
          term: ANNOTATION_TERM_STANDARD_NAME,
          value: 'Active Under Contract'
        }
      ]
    },
    {
      lookupName: 'CustomLookups.LookupField123',
      lookupValue: 'LookupField123',
      type: 'Edm.Int32',
      annotations: [{ term: 'LocalFields', value: 'Distance to Volcano' }]
    }
  ]
};

module.exports = { metadataReport };
