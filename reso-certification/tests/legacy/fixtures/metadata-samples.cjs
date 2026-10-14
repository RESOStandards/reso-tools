const simpleNonEnumFields = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'AboveGradeFinishedArea',
      type: 'Edm.Decimal',
      nullable: true,
      scale: 2,
      precision: 14,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Above Grade Finished Area' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/AboveGradeFinishedArea+Field' },
        { term: 'Core.Description', value: 'The finished area within the structure that is at or above the surface of the ground.' }
      ]
    },
    {
      resourceName: 'Property',
      fieldName: 'BuyerTeamName',
      type: 'Edm.String',
      nullable: true,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Buyer Team Name' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field' },
        { term: 'Core.Description', value: 'The name of the team representing the buyer.' }
      ]
    }
  ],
  lookups: []
};

const fieldsWithMaxLength = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'BuyerTeamName',
      type: 'Edm.String',
      nullable: true,
      maxLength: 50,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Buyer Team Name' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field' },
        { term: 'Core.Description', value: 'The name of the team representing the buyer.' }
      ]
    }
  ],
  lookups: []
};

const fieldsWithImplicitNullable = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'BuyerTeamName',
      type: 'Edm.String',
      maxLength: 50,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Buyer Team Name' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field' },
        { term: 'Core.Description', value: 'The name of the team representing the buyer.' }
      ]
    }
  ],
  lookups: []
};

const nonNullableField = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'BuyerTeamName',
      type: 'Edm.String',
      maxLength: 50,
      nullable: false,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Buyer Team Name' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/BuyerTeamName+Field' },
        { term: 'Core.Description', value: 'The name of the team representing the buyer.' }
      ]
    }
  ],
  lookups: []
};

const enumFieldsAndLookups = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'AboveGradeFinishedAreaSource',
      type: 'org.reso.metadata.enums.AreaSource',
      typeName: 'AreaSource',
      nullable: true,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Above Grade Finished Area Source' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/AboveGradeFinishedAreaSource+Field' },
        {
          term: 'Core.Description',
          value:
            'The source of the measurements. This is a pick list of options showing the source of the measurement (e.g., Agent, Assessor, Estimate).'
        }
      ]
    }
  ],
  lookups: [
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Appraiser',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Appraiser' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Appraiser' },
        { term: 'Core.Description', value: 'An appraiser provided the measurement of the area.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Assessor',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Assessor' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Assessor' },
        { term: 'Core.Description', value: 'The assessor provided the measurement of the area.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Builder',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Builder' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Builder' },
        { term: 'Core.Description', value: 'The builder provided the measurement of the area.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Estimated',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Estimated' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Estimated' },
        { term: 'Core.Description', value: 'The measurement of the area is an estimate.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Other',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Other' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1136224' },
        { term: 'Core.Description', value: 'The measurement of the area was provided by another party not listed.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Owner',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Owner' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Owner' },
        { term: 'Core.Description', value: 'The owner provided the measurement of the area.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'Plans',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Plans' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Plans' },
        { term: 'Core.Description', value: 'The measurement of the area was taken from building plans.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'PublicRecords',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Public Records' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Public+Records' },
        { term: 'Core.Description', value: 'The measurement of the area was received from public records.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.AreaSource',
      lookupValue: 'SeeRemarks',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'See Remarks' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/See+Remarks' },
        { term: 'Core.Description', value: 'See remarks for information about the source of the area measurement.' }
      ]
    }
  ]
};

const collectionFields = {
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'AvailableLeaseType',
      type: 'org.reso.metadata.enums.ExistingLeaseType',
      typeName: 'ExistingLeaseType',
      nullable: false,
      isCollection: true,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Available Lease Type' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/AvailableLeaseType+Field' },
        {
          term: 'Core.Description',
          value:
            'Information about the available types of lease for the property (i.e., Net, NNN, NN, Gross, Absolute Net, Escalation Clause, Ground Lease, etc.).'
        }
      ]
    }
  ],
  lookups: [
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'AbsoluteNet',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Absolute Net' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Absolute+Net' },
        {
          term: 'Core.Description',
          value: 'Also known as a bondable lease, the tenant carries every risk in addition to the costs of an NNN lease.'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'CpiAdjustment',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'CPI Adjustment' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/CPI+Adjustment' },
        {
          term: 'Core.Description',
          value:
            'An escalation clause/provision in a lease to adjust the amount paid by the tenant (lessee) where the adjustment will follow the Consumer Price Index (CPI).'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'EscalationClause',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Escalation Clause' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Escalation+Clause' },
        {
          term: 'Core.Description',
          value: 'A clause or provision in a lease document that set a formula for how rent will increase over time.'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'Gross',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Gross' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Gross' },
        {
          term: 'Core.Description',
          value:
            'A lease agreement where the owner (lessor) pays all property changes normal to ownership. The opposite to net leases where the tenant (lessee) may pay taxes, insurance, maintenance and even for damages that were not caused by the tenant.'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'GroundLease',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Ground Lease' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Ground+Lease' },
        {
          term: 'Core.Description',
          value: 'Typically a long-term lease of land where the tenant (lessee) has the right to develop or make improvements.'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'Net',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Net' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Net' },
        { term: 'Core.Description', value: 'A lease agreement where the tenant pays the real estate taxes.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'Nn',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'NN' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/NN' },
        { term: 'Core.Description', value: 'A lease agreement where the tenant pays real estate taxes and building insurance.' }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'Nnn',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'NNN' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/NNN' },
        {
          term: 'Core.Description',
          value: 'A lease agreement where the tenant pays real estate taxes, building insurance and maintenance.'
        }
      ]
    },
    {
      lookupName: 'org.reso.metadata.enums.ExistingLeaseType',
      lookupValue: 'Oral',
      type: 'Edm.Int32',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Oral' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/Oral' },
        {
          term: 'Core.Description',
          value:
            'The terms of the lease are agreed upon orally (not in writing) between the lessee and lessor. Legal restrictions around oral agreements vary from state to state.'
        }
      ]
    }
  ]
};

const expansionFields = {
  fields: [
    {
      resourceName: 'Teams',
      fieldName: 'ModificationTimestamp',
      type: 'Edm.DateTimeOffset',
      nullable: true,
      precision: 27,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Modification Timestamp' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1135641' },
        { term: 'Core.Description', value: 'The date/time the roster (team or office) record was last modified.' }
      ]
    },
    {
      resourceName: 'Teams',
      fieldName: 'OriginalEntryTimestamp',
      type: 'Edm.DateTimeOffset',
      nullable: true,
      precision: 27,
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'Original Entry Timestamp' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/pages/viewpage.action?pageId=1135646' },
        {
          term: 'Core.Description',
          value: 'The date/time the roster (team or office) record was originally input into the source system.'
        }
      ]
    },
    {
      resourceName: 'Property',
      fieldName: 'ListTeam',
      isExpansion: true,
      isCollection: false,
      type: 'org.reso.metadata.Teams',
      typeName: 'Teams',
      annotations: [
        { term: 'RESO.OData.Metadata.StandardName', value: 'List Team' },
        { term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/display/DDW20/ListTeam+Field' },

        { term: 'Core.Description', value: 'Two or more agents working on the listing agent\'s team.' }
      ]
    }
  ],
  lookups: []
};

const nullableCollectionFields = {
  fields: collectionFields.fields.map(f => ({ ...f, nullable: true })),
  lookups: collectionFields.lookups
};

module.exports = {
  simpleNonEnumFields,
  fieldsWithMaxLength,
  fieldsWithImplicitNullable,
  nonNullableField,
  enumFieldsAndLookups,
  collectionFields,
  expansionFields,
  nullableCollectionFields
};
