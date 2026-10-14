const valuePayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const nonValuePayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser'
};

const expansionPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  Media: [
    {
      ResourceName: 'Property',
      MediaCategory: 'BrandedVirtualTour',
      MediaURL: 'https://youriguide.com/39_starwood_rd_ottawa_on/'
    },
    {
      ResourceName: 'Property',
      MediaCategory: 'UnbrandedVirtualTour',
      MediaURL: 'https://unbranded.youriguide.com/39_starwood_rd_ottawa_on/'
    },
    {
      ResourceName: 'Property',
      MediaCategory: 'FloorPlan',
      MediaType: 'Pdf',
      MediaURL: 'https://youriguide.com/39_starwood_rd_ottawa_on/doc/floorplan_imperial.pdf',
      ShortDescription: 'imperial'
    },
    {
      ResourceName: 'Property',
      MediaCategory: 'FloorPlan',
      MediaType: 'Pdf',
      MediaURL: 'https://youriguide.com/39_starwood_rd_ottawa_on/doc/floorplan_metric.pdf',
      ShortDescription: 'metric'
    },
    {
      MediaObjectID: '39_starwood_rd_ottawa_on:2ANGWI9SPOJ5.jpg',
      PreferredPhotoYN: true,
      ResourceName: 'Property',
      MediaCategory: 'Photo',
      MediaType: 'Jpeg',
      MediaURL: 'https://youriguide.com/39_starwood_rd_ottawa_on/f/2ANGWI9SPOJ5.jpg',
      ImageHeight: 2456,
      ImageWidth: 3689
    }
  ]
};

const simpleTypeMismatchErrorPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: true,
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser'
};

const enumMismatchPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'InvalidEnum'
    }
  ]
};

const odataKeyPayload = {
  '@odata.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser'
};

const maxLengthPayload = {
  '@odata.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  TestMaxLengthField: 'MoreThan5Chars'
};

const maxLengthPayloadRCF = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  TestMaxLengthField: 'MoreThan5Chars'
};

const invalidPayloadContext = {
  '@invalid.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser'
};

const stringListValidPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser,Assessor'
    }
  ]
};

const specialEnumFieldsValidPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      MLSAreaMinor: 'TestEnumValuer'
    }
  ]
};

const stringListInvalidPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser,InvalidEnum'
    }
  ]
};

const stringListWithSpacesAfterCommaValidPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      StringListTestField: 'My Company, LLC'
    }
  ]
};

const additionalPropertyPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  AdditionalProperty: 'foo'
};

const integerOverflowPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  Foo: 2 ** 32 + 1
};

const nestedPayloadError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      ListAgent: {
        Foo: 'bar',
        MemberAlternateId: 'fooo',
        MemberDesignation: ['Graduate, REALTOR Institute / GRI']
      },
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const nestedCollectionPayloadError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Media: [
        {
          ChangedByMemberID: 'id',
          Foo: 'bar'
        },
        {
          ChangedByMemberID: 'id',
          ImageHeight: 10
        }
      ],
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const nestedPayloadErrorWithNullExpansion = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      ListAgent: null,
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const nestedCollectionPayloadErrorWithNull = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Media: null,
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const nestedExpansionTypeError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      ListAgent: {
        MemberAlternateId: 12
      },
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ]
};

const atFieldPayloadError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      'AboveGradeFinishedAreaSource@core': 'Appraiser'
    }
  ]
};

const invalidOdataIdentifierInvalidPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue,invalidSimpleIdentifier$',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39'
    }
  ]
};

const validNonStringNonIsflagsPayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      SampleField: 'sampleEnumValue$',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39'
    }
  ]
};

const expansionErrorMultiValuePayload = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Media: [
        {
          ChangedByMemberID: 'id',
          Foo: 'bar'
        },
        {
          ChangedByMemberID: 'id',
          ImageHeight: 10
        }
      ],
      BuyerAgentAOR: [],
      Country: 'CA',
      StateOrProvince: 'ON',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39'
    },
    {
      Media: [
        {
          ChangedByMemberID: 'id',
          Foo: 'baz'
        },
        {
          ChangedByMemberID: 'id',
          ImageHeight: 10
        }
      ],
      BuyerAgentAOR: [],
      Country: 'IN',
      StateOrProvince: 'ON',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39'
    }
  ]
};

const collectionExpansionError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Media: [
        {
          ChangedByMemberID: 'id'
        },
        {
          ChangedByMemberID: 'id',
          ImageHeight: 'foo'
        }
      ],
      Country: 'CA',
      StateOrProvince: 'ON',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39'
    }
  ]
};

const expansionIgnoredItem = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser',
      Media: [{ ImageSizeDescription: 'Foo' }]
    }
  ]
};

const singleValueExpansionError = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  Country: 'CA',
  StateOrProvince: 'ON',
  City: 'SampleCityEnumValue',
  PostalCode: 'K2G 1Y9',
  StreetName: 'Starwood Rd',
  StreetNumber: '39',
  AboveGradeFinishedAreaSource: 'Appraiser',
  Media: [{ ImageSizeDescription: 'Foo' }]
};

const topLevelUnadvertisedField = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'SampleCityEnumValue',
      PostalCode: 'K2G 1Y9',
      StreetName: 'Starwood Rd',
      StreetNumber: '39',
      AboveGradeFinishedAreaSource: 'Appraiser'
    }
  ],
  Foo: false
};

const keyFieldPayloadMulti = {
  '@reso.context': 'urn:reso:metadata:1.7:resource:property',
  value: [
    {
      Country: 'CA',
      StateOrProvince: 'ON',
      City: 'NYC',
      ListingKey: 'listingkey1',
      Media: [
        {
          ResourceName: 'Property',
          MediaCategory: 'Branded Virtual Tour',
          MediaURL: 'https://example.com/vJVDL415WZ7GE1/',
          ShortDescription: 'Example',
          MediaKey: 'mediakey1'
        },
        {
          ResourceName: 'Property',
          MediaCategory: 'Branded Virtual Tour',
          MediaURL: 'https://example.com/vJVDL415WZ7GE1/doc/floorplan_imperial.pdf',
          ShortDescription: 'imperial',
          MediaKey: 'mediakey2'
        }
      ],
      Rooms: [
        {
          RoomWidth: 4.409,
          RoomLength: 2.977,
          RoomLengthWidthUnits: 'Meters',
          RoomKey: 'roomkey1',
          RoomLengthWidthSource: 'LocalProvider'
        },
        {
          RoomWidth: 4.3,
          RoomLength: 5.998,
          RoomLengthWidthUnits: 'Meters',
          RoomKey: 'roomkey2',
          RoomLengthWidthSource: 'LocalProvider'
        }
      ]
    }
  ]
};

module.exports = {
  valuePayload,
  nonValuePayload,
  expansionPayload,
  simpleTypeMismatchErrorPayload,
  enumMismatchPayload,
  odataKeyPayload,
  invalidPayloadContext,
  stringListValidPayload,
  stringListInvalidPayload,
  additionalPropertyPayload,
  integerOverflowPayload,
  stringListWithSpacesAfterCommaValidPayload,
  specialEnumFieldsValidPayload,
  maxLengthPayload,
  maxLengthPayloadRCF,
  nestedPayloadError,
  nestedCollectionPayloadError,
  nestedPayloadErrorWithNullExpansion,
  nestedCollectionPayloadErrorWithNull,
  nestedExpansionTypeError,
  atFieldPayloadError,
  invalidOdataIdentifierInvalidPayload,
  validNonStringNonIsflagsPayload,
  expansionErrorMultiValuePayload,
  expansionIgnoredItem,
  collectionExpansionError,
  singleValueExpansionError,
  topLevelUnadvertisedField,
  keyFieldPayloadMulti
};
