const simpleNonEnumSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: { AboveGradeFinishedArea: { type: ['number', 'null'] }, BuyerTeamName: { type: ['string', 'null'] } },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        AboveGradeFinishedArea: {
          type: 'Edm.Decimal',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/AboveGradeFinishedArea+Field',
          typeName: '',
          nullable: true,
          isCollection: false
        },
        BuyerTeamName: {
          type: 'Edm.String',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field',
          typeName: '',
          nullable: true,
          isCollection: false
        }
      }
    }
  }
};

const schemaWithMaxLength = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        BuyerTeamName: {
          type: ['string', 'null'],
          maxLength: 50,
          errorMessage: { maxLength: 'SHOULD have a maximum suggested length of 50 characters' }
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        BuyerTeamName: {
          type: 'Edm.String',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field',
          typeName: '',
          nullable: true,
          isCollection: false
        }
      }
    }
  }
};

const schemaWithImplicitNullable = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        BuyerTeamName: {
          type: ['string', 'null'],
          maxLength: 50,
          errorMessage: { maxLength: 'SHOULD have a maximum suggested length of 50 characters' }
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        BuyerTeamName: {
          type: 'Edm.String',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          typeName: '',
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field',
          nullable: true,
          isCollection: false
        }
      }
    }
  }
};

const nonNullableSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        BuyerTeamName: {
          type: 'string',
          maxLength: 50,
          errorMessage: { maxLength: 'SHOULD have a maximum suggested length of 50 characters' }
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        BuyerTeamName: {
          type: 'Edm.String',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          typeName: '',
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field',
          nullable: false,
          isCollection: false
        }
      }
    }
  }
};

const enumFieldsAndLookupsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        AboveGradeFinishedAreaSource: {
          type: ['string', 'null'],
          enum: ['Appraiser', 'Assessor', 'Builder', 'Estimated', 'Other', 'Owner', 'Plans', 'PublicRecords', 'SeeRemarks', null]
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        AboveGradeFinishedAreaSource: {
          type: 'org.reso.metadata.enums.AreaSource',
          isExpansion: false,
          isLookupField: true,
          isComplexType: false,
          typeName: 'AreaSource',
          isCollection: false,
          nullable: true,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/AboveGradeFinishedAreaSource+Field',
          lookupValues: {
            Appraiser: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Appraiser',
              legacyODataValue: 'Appraiser',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appraiser',
              isStringEnumeration: undefined
            },
            Assessor: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Assessor',
              legacyODataValue: 'Assessor',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Assessor',
              isStringEnumeration: undefined
            },
            Builder: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Builder',
              legacyODataValue: 'Builder',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Builder',
              isStringEnumeration: undefined
            },
            Estimated: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Estimated',
              legacyODataValue: 'Estimated',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Estimated',
              isStringEnumeration: undefined
            },
            Other: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Other',
              legacyODataValue: 'Other',
              ddWikiUrl: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1136224',
              isStringEnumeration: undefined
            },
            Owner: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Owner',
              legacyODataValue: 'Owner',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Owner',
              isStringEnumeration: undefined
            },
            Plans: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Plans',
              legacyODataValue: 'Plans',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Plans',
              isStringEnumeration: undefined
            },
            'Public Records': {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Public Records',
              legacyODataValue: 'PublicRecords',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Public+Records',
              isStringEnumeration: undefined
            },
            'See Remarks': {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'See Remarks',
              legacyODataValue: 'SeeRemarks',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/See+Remarks',
              isStringEnumeration: undefined
            }
          },
          legacyODataValues: {
            Appraiser: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Appraiser',
              legacyODataValue: 'Appraiser',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Appraiser'
            },
            Assessor: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Assessor',
              legacyODataValue: 'Assessor',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Assessor'
            },
            Builder: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Builder',
              legacyODataValue: 'Builder',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Builder'
            },
            Estimated: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Estimated',
              legacyODataValue: 'Estimated',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Estimated'
            },
            Other: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Other',
              legacyODataValue: 'Other',
              ddWikiUrl: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1136224'
            },
            Owner: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Owner',
              legacyODataValue: 'Owner',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Owner'
            },
            Plans: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Plans',
              legacyODataValue: 'Plans',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Plans'
            },
            PublicRecords: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'Public Records',
              legacyODataValue: 'PublicRecords',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Public+Records'
            },
            SeeRemarks: {
              type: 'org.reso.metadata.enums.AreaSource',
              lookupName: 'AreaSource',
              lookupValue: 'See Remarks',
              legacyODataValue: 'SeeRemarks',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/See+Remarks'
            }
          }
        }
      }
    }
  }
};

const collectionFieldsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        AvailableLeaseType: {
          type: 'array',
          items: {
            type: ['string'],
            enum: ['AbsoluteNet', 'CpiAdjustment', 'EscalationClause', 'Gross', 'GroundLease', 'Net', 'Nn', 'Nnn', 'Oral']
          }
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        AvailableLeaseType: {
          type: 'org.reso.metadata.enums.ExistingLeaseType',
          isExpansion: false,
          isLookupField: true,
          isComplexType: false,
          typeName: 'ExistingLeaseType',
          isCollection: true,
          nullable: false,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/AvailableLeaseType+Field',
          lookupValues: {
            'Absolute Net': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Absolute Net',
              legacyODataValue: 'AbsoluteNet',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Absolute+Net',
              isStringEnumeration: undefined
            },
            'CPI Adjustment': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'CPI Adjustment',
              legacyODataValue: 'CpiAdjustment',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/CPI+Adjustment',
              isStringEnumeration: undefined
            },
            'Escalation Clause': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Escalation Clause',
              legacyODataValue: 'EscalationClause',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Escalation+Clause',
              isStringEnumeration: undefined
            },
            Gross: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Gross',
              legacyODataValue: 'Gross',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Gross',
              isStringEnumeration: undefined
            },
            'Ground Lease': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Ground Lease',
              legacyODataValue: 'GroundLease',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Ground+Lease',
              isStringEnumeration: undefined
            },
            Net: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Net',
              legacyODataValue: 'Net',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Net',
              isStringEnumeration: undefined
            },
            NN: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NN',
              legacyODataValue: 'Nn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NN',
              isStringEnumeration: undefined
            },
            NNN: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NNN',
              legacyODataValue: 'Nnn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NNN',
              isStringEnumeration: undefined
            },
            Oral: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Oral',
              legacyODataValue: 'Oral',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Oral',
              isStringEnumeration: undefined
            }
          },
          legacyODataValues: {
            AbsoluteNet: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Absolute Net',
              legacyODataValue: 'AbsoluteNet',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Absolute+Net'
            },
            CpiAdjustment: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'CPI Adjustment',
              legacyODataValue: 'CpiAdjustment',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/CPI+Adjustment'
            },
            EscalationClause: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Escalation Clause',
              legacyODataValue: 'EscalationClause',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Escalation+Clause'
            },
            Gross: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Gross',
              legacyODataValue: 'Gross',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Gross'
            },
            GroundLease: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Ground Lease',
              legacyODataValue: 'GroundLease',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Ground+Lease'
            },
            Net: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Net',
              legacyODataValue: 'Net',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Net'
            },
            Nn: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NN',
              legacyODataValue: 'Nn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NN'
            },
            Nnn: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NNN',
              legacyODataValue: 'Nnn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NNN'
            },
            Oral: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Oral',
              legacyODataValue: 'Oral',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Oral'
            }
          }
        }
      }
    }
  }
};

const expansionFieldsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Teams: {
      type: 'object',
      properties: { ModificationTimestamp: { type: ['string', 'null'] }, OriginalEntryTimestamp: { type: ['string', 'null'] } },
      additionalProperties: false
    },
    Property: { type: 'object', properties: { ListTeam: { $ref: '#/definitions/Teams' } }, additionalProperties: false },
    MetadataMap: {
      Teams: {
        ModificationTimestamp: {
          type: 'Edm.DateTimeOffset',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          typeName: '',
          nullable: true,
          isCollection: false,
          ddWikiUrl: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1135641'
        },
        OriginalEntryTimestamp: {
          type: 'Edm.DateTimeOffset',
          isExpansion: false,
          isLookupField: false,
          isComplexType: false,
          typeName: '',
          nullable: true,
          ddWikiUrl: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1135646',
          isCollection: false
        }
      },
      Property: {
        ListTeam: {
          type: 'org.reso.metadata.Teams',
          isExpansion: true,
          isLookupField: false,
          isComplexType: false,
          typeName: 'Teams',
          nullable: true,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/ListTeam+Field',
          isCollection: false
        }
      }
    }
  }
};

const nullableCollectionFieldsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    { properties: { '@reso.context': { type: 'string' } }, additionalProperties: false },
    { properties: { '@reso.context': { type: 'string' }, value: { type: 'array' } }, additionalProperties: false }
  ],
  definitions: {
    Property: {
      type: 'object',
      properties: {
        AvailableLeaseType: {
          type: 'array',
          items: {
            type: ['string'],
            enum: ['AbsoluteNet', 'CpiAdjustment', 'EscalationClause', 'Gross', 'GroundLease', 'Net', 'Nn', 'Nnn', 'Oral', null]
          }
        }
      },
      additionalProperties: false
    },
    MetadataMap: {
      Property: {
        AvailableLeaseType: {
          type: 'org.reso.metadata.enums.ExistingLeaseType',
          isExpansion: false,
          isLookupField: true,
          isComplexType: false,
          isCollection: true,
          typeName: 'ExistingLeaseType',
          nullable: true,
          ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/AvailableLeaseType+Field',
          lookupValues: {
            'Absolute Net': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Absolute Net',
              legacyODataValue: 'AbsoluteNet',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Absolute+Net',
              isStringEnumeration: undefined
            },
            'CPI Adjustment': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'CPI Adjustment',
              legacyODataValue: 'CpiAdjustment',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/CPI+Adjustment',
              isStringEnumeration: undefined
            },
            'Escalation Clause': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Escalation Clause',
              legacyODataValue: 'EscalationClause',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Escalation+Clause',
              isStringEnumeration: undefined
            },
            Gross: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Gross',
              legacyODataValue: 'Gross',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Gross',
              isStringEnumeration: undefined
            },
            'Ground Lease': {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Ground Lease',
              legacyODataValue: 'GroundLease',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Ground+Lease',
              isStringEnumeration: undefined
            },
            Net: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Net',
              legacyODataValue: 'Net',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Net',
              isStringEnumeration: undefined
            },
            NN: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NN',
              legacyODataValue: 'Nn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NN',
              isStringEnumeration: undefined
            },
            NNN: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NNN',
              legacyODataValue: 'Nnn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NNN',
              isStringEnumeration: undefined
            },
            Oral: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Oral',
              legacyODataValue: 'Oral',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Oral',
              isStringEnumeration: undefined
            }
          },
          legacyODataValues: {
            AbsoluteNet: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Absolute Net',
              legacyODataValue: 'AbsoluteNet',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Absolute+Net'
            },
            CpiAdjustment: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'CPI Adjustment',
              legacyODataValue: 'CpiAdjustment',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/CPI+Adjustment'
            },
            EscalationClause: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Escalation Clause',
              legacyODataValue: 'EscalationClause',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Escalation+Clause'
            },
            Gross: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Gross',
              legacyODataValue: 'Gross',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Gross'
            },
            GroundLease: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Ground Lease',
              legacyODataValue: 'GroundLease',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Ground+Lease'
            },
            Net: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Net',
              legacyODataValue: 'Net',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Net'
            },
            Nn: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NN',
              legacyODataValue: 'Nn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NN'
            },
            Nnn: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'NNN',
              legacyODataValue: 'Nnn',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/NNN'
            },
            Oral: {
              type: 'org.reso.metadata.enums.ExistingLeaseType',
              lookupName: 'ExistingLeaseType',
              lookupValue: 'Oral',
              legacyODataValue: 'Oral',
              ddWikiUrl: 'https://ddwiki.reso.org/display/DDW20/Oral'
            }
          }
        }
      }
    }
  }
};

module.exports = {
  simpleNonEnumSchema,
  schemaWithMaxLength,
  schemaWithImplicitNullable,
  nonNullableSchema,
  enumFieldsAndLookupsSchema,
  collectionFieldsSchema,
  expansionFieldsSchema,
  nullableCollectionFieldsSchema
};
