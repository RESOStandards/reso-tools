import { describe, expect, it } from 'vitest';
import { getGenerator, setRecordPool, clearRecordPools } from '../src/generators/index.js';
import { generateMediaRecords } from '../src/generators/media.js';
import { generateMemberRecords } from '../src/generators/member.js';
import { generateOfficeRecords } from '../src/generators/office.js';
import { generateOpenHouseRecords } from '../src/generators/open-house.js';
import { generatePropertyRecords, reflattenAgentFields } from '../src/generators/property.js';
import { generateShowingRecords } from '../src/generators/showing.js';
import type { ResoField, ResoLookup } from '../src/generators/types.js';

const makeField = (fieldName: string, type = 'Edm.String', overrides: Partial<ResoField> = {}): ResoField => ({
  resourceName: 'Property',
  fieldName,
  type,
  nullable: true,
  annotations: [],
  ...overrides
});

const PROPERTY_FIELDS: ResoField[] = [
  makeField('ListingKey'),
  makeField('ListPrice', 'Edm.Decimal', { scale: 2, precision: 14 }),
  makeField('StreetNumber'),
  makeField('StreetName', 'Edm.String', { maxLength: 50 }),
  makeField('City', 'Edm.String'),
  makeField('PostalCode', 'Edm.String', { maxLength: 10 }),
  makeField('BedroomsTotal', 'Edm.Int64'),
  makeField('BathroomsTotalInteger', 'Edm.Int64'),
  makeField('BathroomsFull', 'Edm.Int64'),
  makeField('BathroomsHalf', 'Edm.Int64'),
  makeField('LivingArea', 'Edm.Decimal', { scale: 2 }),
  makeField('LotSizeSquareFeet', 'Edm.Decimal', { scale: 2 }),
  makeField('YearBuilt', 'Edm.Int32'),
  makeField('Latitude', 'Edm.Decimal', { scale: 6, precision: 12 }),
  makeField('Longitude', 'Edm.Decimal', { scale: 6, precision: 12 }),
  makeField('StandardStatus', 'org.reso.metadata.enums.StandardStatus'),
  makeField('PropertyType', 'org.reso.metadata.enums.PropertyType'),
  makeField('PublicRemarks'),
  makeField('ListingContractDate', 'Edm.Date'),
  makeField('ModificationTimestamp', 'Edm.DateTimeOffset')
];

const MEMBER_FIELDS: ResoField[] = [
  makeField('MemberKey', 'Edm.String', { resourceName: 'Member' }),
  makeField('MemberFirstName', 'Edm.String', { resourceName: 'Member', maxLength: 50 }),
  makeField('MemberLastName', 'Edm.String', { resourceName: 'Member', maxLength: 50 }),
  makeField('MemberEmail', 'Edm.String', { resourceName: 'Member', maxLength: 80 }),
  makeField('MemberPreferredPhone', 'Edm.String', { resourceName: 'Member' }),
  makeField('MemberNationalAssociationId', 'Edm.String', { resourceName: 'Member' })
];

const OFFICE_FIELDS: ResoField[] = [
  makeField('OfficeKey', 'Edm.String', { resourceName: 'Office' }),
  makeField('OfficeName', 'Edm.String', { resourceName: 'Office', maxLength: 255 }),
  makeField('OfficePhone', 'Edm.String', { resourceName: 'Office' }),
  makeField('OfficeEmail', 'Edm.String', { resourceName: 'Office' }),
  makeField('OfficeAddress1', 'Edm.String', { resourceName: 'Office' }),
  makeField('OfficeCity', 'Edm.String', { resourceName: 'Office' }),
  makeField('OfficePostalCode', 'Edm.String', { resourceName: 'Office' })
];

const MEDIA_FIELDS: ResoField[] = [
  makeField('MediaKey', 'Edm.String', { resourceName: 'Media' }),
  makeField('MediaURL', 'Edm.String', { resourceName: 'Media', maxLength: 8000 }),
  makeField('ShortDescription', 'Edm.String', { resourceName: 'Media' }),
  makeField('Order', 'Edm.Int32', { resourceName: 'Media' }),
  makeField('MediaCategory', 'org.reso.metadata.enums.MediaCategory', { resourceName: 'Media' }),
  makeField('MediaType', 'org.reso.metadata.enums.MediaType', { resourceName: 'Media' }),
  makeField('ResourceName', 'org.reso.metadata.enums.ResourceName', { resourceName: 'Media' }),
  makeField('ResourceRecordKey', 'Edm.String', { resourceName: 'Media' })
];

const OPEN_HOUSE_FIELDS: ResoField[] = [
  makeField('OpenHouseKey', 'Edm.String', { resourceName: 'OpenHouse' }),
  makeField('OpenHouseDate', 'Edm.Date', { resourceName: 'OpenHouse' }),
  makeField('OpenHouseStartTime', 'Edm.TimeOfDay', { resourceName: 'OpenHouse' }),
  makeField('OpenHouseEndTime', 'Edm.TimeOfDay', { resourceName: 'OpenHouse' }),
  makeField('OpenHouseRemarks', 'Edm.String', { resourceName: 'OpenHouse' }),
  makeField('ListingKey', 'Edm.String', { resourceName: 'OpenHouse' })
];

const SHOWING_FIELDS: ResoField[] = [
  makeField('ShowingKey', 'Edm.String', { resourceName: 'Showing' }),
  makeField('ShowingStartTimestamp', 'Edm.DateTimeOffset', { resourceName: 'Showing' }),
  makeField('ShowingEndTimestamp', 'Edm.DateTimeOffset', { resourceName: 'Showing' }),
  makeField('ListingKey', 'Edm.String', { resourceName: 'Showing' })
];

const SAMPLE_LOOKUPS: Record<string, ReadonlyArray<ResoLookup>> = {
  'org.reso.metadata.enums.StandardStatus': [
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', type: 'Edm.Int32', annotations: [] },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending', type: 'Edm.Int32', annotations: [] }
  ],
  'org.reso.metadata.enums.MediaCategory': [
    { lookupName: 'org.reso.metadata.enums.MediaCategory', lookupValue: 'Photo', type: 'Edm.Int32', annotations: [] },
    { lookupName: 'org.reso.metadata.enums.MediaCategory', lookupValue: 'Video', type: 'Edm.Int32', annotations: [] }
  ]
};

describe('generatePropertyRecords', () => {
  it('generates the requested number of records', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 3);
    expect(records).toHaveLength(3);
  });

  it('generates realistic addresses', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    const record = records[0];
    expect(typeof record.StreetNumber).toBe('string');
    expect(typeof record.StreetName).toBe('string');
    expect(typeof record.UnparsedAddress).toBe('string');
    expect(typeof record.City).toBe('string');
    expect(typeof record.PostalCode).toBe('string');
  });

  it('generates realistic pricing', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    const price = records[0].ListPrice as number;
    expect(price).toBeGreaterThanOrEqual(50000);
    expect(price).toBeLessThanOrEqual(10000000);
  });

  it('generates realistic property characteristics', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    const record = records[0];
    expect(record.BedroomsTotal).toBeGreaterThanOrEqual(1);
    expect(record.BedroomsTotal).toBeLessThanOrEqual(6);
    expect(record.BathroomsTotalInteger).toBeGreaterThanOrEqual(1);
    expect(record.LivingArea as number).toBeGreaterThanOrEqual(500);
    expect(record.YearBuilt as number).toBeGreaterThanOrEqual(1950);
  });

  it('generates coordinates within US bounds', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    const record = records[0];
    expect(record.Latitude as number).toBeGreaterThanOrEqual(25);
    expect(record.Latitude as number).toBeLessThanOrEqual(48);
    expect(record.Longitude as number).toBeGreaterThanOrEqual(-124);
    expect(record.Longitude as number).toBeLessThanOrEqual(-71);
  });

  it('skips ListingKey (server-generated)', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(records[0].ListingKey).toBeUndefined();
  });

  it('skips ModificationTimestamp (server-computed)', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(records[0].ModificationTimestamp).toBeUndefined();
  });

  it('includes PublicRemarks', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(typeof records[0].PublicRemarks).toBe('string');
    expect((records[0].PublicRemarks as string).length).toBeGreaterThan(0);
  });

  it('calculates TaxAnnualAmount from ListPrice and state tax rate', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 20);
    for (const record of records) {
      const tax = record.TaxAnnualAmount as number;
      expect(tax).toBeGreaterThan(0);
      // Tax should be a reasonable fraction of ListPrice (between 0.1% and 3%)
      const price = record.ListPrice as number;
      expect(tax).toBeLessThanOrEqual(price * 0.03);
      expect(tax).toBeGreaterThanOrEqual(price * 0.001);
    }
  });

  it('generates TaxAssessedValue less than ListPrice', () => {
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 10);
    for (const record of records) {
      expect(record.TaxAssessedValue as number).toBeLessThanOrEqual(record.ListPrice as number);
      expect(record.TaxAssessedValue as number).toBeGreaterThan(0);
    }
  });

  it('generates expense fields within $0-$10,000 range', () => {
    const expenseFields = [
      'AssociationFee',
      'AssociationFee2',
      'InsuranceExpense',
      'ElectricExpense',
      'WaterSewerExpense',
      'TrashExpense',
      'CableTvExpense',
      'MaintenanceExpense',
      'OperatingExpense',
      'OtherExpense'
    ];
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 10);
    for (const record of records) {
      for (const field of expenseFields) {
        const value = record[field] as number;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(10000);
      }
    }
  });
});

describe('generateMemberRecords', () => {
  it('generates the requested number of records', () => {
    const records = generateMemberRecords(MEMBER_FIELDS, {}, 5);
    expect(records).toHaveLength(5);
  });

  it('generates realistic names', () => {
    const records = generateMemberRecords(MEMBER_FIELDS, {}, 1);
    const record = records[0];
    expect(typeof record.MemberFirstName).toBe('string');
    expect(typeof record.MemberLastName).toBe('string');
    expect(typeof record.MemberFullName).toBe('string');
    expect(record.MemberFullName as string).toContain(record.MemberFirstName as string);
  });

  it('generates valid email format', () => {
    const records = generateMemberRecords(MEMBER_FIELDS, {}, 1);
    expect(records[0].MemberEmail as string).toContain('@');
  });

  it('generates phone numbers', () => {
    const records = generateMemberRecords(MEMBER_FIELDS, {}, 1);
    expect(typeof records[0].MemberPreferredPhone).toBe('string');
    expect(records[0].MemberPreferredPhone as string).toMatch(/\d{3}-\d{3}-\d{4}/);
  });
});

describe('generateOfficeRecords', () => {
  it('generates the requested number of records', () => {
    const records = generateOfficeRecords(OFFICE_FIELDS, {}, 3);
    expect(records).toHaveLength(3);
  });

  it('generates office names', () => {
    const records = generateOfficeRecords(OFFICE_FIELDS, {}, 1);
    expect(typeof records[0].OfficeName).toBe('string');
    expect((records[0].OfficeName as string).length).toBeGreaterThan(0);
  });

  it('generates office phone and email', () => {
    const records = generateOfficeRecords(OFFICE_FIELDS, {}, 1);
    expect(typeof records[0].OfficePhone).toBe('string');
    expect(records[0].OfficeEmail as string).toContain('@');
  });
});

describe('generateMediaRecords', () => {
  it('generates the requested number of records', () => {
    const records = generateMediaRecords(MEDIA_FIELDS, SAMPLE_LOOKUPS, 5);
    expect(records).toHaveLength(5);
  });

  it('sets ResourceName and ResourceRecordKey for parent linkage', () => {
    const records = generateMediaRecords(MEDIA_FIELDS, SAMPLE_LOOKUPS, 2, 'Property', 'abc-123');
    for (const record of records) {
      expect(record.ResourceName).toBe('Property');
      expect(record.ResourceRecordKey).toBe('abc-123');
    }
  });

  it('generates sequential Order values', () => {
    const records = generateMediaRecords(MEDIA_FIELDS, SAMPLE_LOOKUPS, 3);
    expect(records[0].Order).toBe(1);
    expect(records[1].Order).toBe(2);
    expect(records[2].Order).toBe(3);
  });

  it('generates MediaURL values', () => {
    const records = generateMediaRecords(MEDIA_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(typeof records[0].MediaURL).toBe('string');
    expect(records[0].MediaURL as string).toContain('https://');
  });

  it('does not include non-metadata fields', () => {
    const records = generateMediaRecords(MEDIA_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(records[0]).not.toHaveProperty('MimeType');
  });
});

describe('generateOpenHouseRecords', () => {
  it('generates the requested number of records', () => {
    const records = generateOpenHouseRecords(OPEN_HOUSE_FIELDS, {}, 2);
    expect(records).toHaveLength(2);
  });

  it('sets ListingKey for parent linkage', () => {
    const records = generateOpenHouseRecords(OPEN_HOUSE_FIELDS, {}, 1, 'Property', 'prop-key-1');
    expect(records[0].ListingKey).toBe('prop-key-1');
    expect(records[0]).not.toHaveProperty('ResourceName');
    expect(records[0]).not.toHaveProperty('ResourceRecordKey');
  });

  it('generates future dates', () => {
    const records = generateOpenHouseRecords(OPEN_HOUSE_FIELDS, {}, 1);
    const date = new Date(records[0].OpenHouseDate as string);
    expect(date.getTime()).toBeGreaterThan(Date.now());
  });

  it('generates ISO 8601 datetime ranges', () => {
    const records = generateOpenHouseRecords(OPEN_HOUSE_FIELDS, {}, 1);
    expect(records[0].OpenHouseStartTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(records[0].OpenHouseEndTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // End time should be after start time
    const start = new Date(records[0].OpenHouseStartTime as string);
    const end = new Date(records[0].OpenHouseEndTime as string);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});

describe('generateShowingRecords', () => {
  it('generates the requested number of records', () => {
    const records = generateShowingRecords(SHOWING_FIELDS, {}, 3);
    expect(records).toHaveLength(3);
  });

  it('sets ListingKey for parent linkage', () => {
    const records = generateShowingRecords(SHOWING_FIELDS, {}, 1, 'Property', 'prop-key-2');
    expect(records[0].ListingKey).toBe('prop-key-2');
    expect(records[0]).not.toHaveProperty('ResourceName');
    expect(records[0]).not.toHaveProperty('ResourceRecordKey');
  });

  it('generates DD 2.0 timestamp fields', () => {
    const records = generateShowingRecords(SHOWING_FIELDS, {}, 1);
    expect(records[0].ShowingStartTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(records[0].ShowingEndTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const start = new Date(records[0].ShowingStartTimestamp as string);
    const end = new Date(records[0].ShowingEndTimestamp as string);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('does not include non-DD 2.0 fields', () => {
    const records = generateShowingRecords(SHOWING_FIELDS, {}, 1);
    expect(records[0]).not.toHaveProperty('ShowingDate');
    expect(records[0]).not.toHaveProperty('ShowingStartTime');
    expect(records[0]).not.toHaveProperty('ShowingEndTime');
    expect(records[0]).not.toHaveProperty('ShowingInstructions');
  });
});

describe('Property relational integrity', () => {
  const offices = generateOfficeRecords(OFFICE_FIELDS, {}, 3);
  // Assign synthetic keys
  const officesWithKeys = offices.map((o, i) => ({ ...o, OfficeKey: `office-${i}` }));

  const members = generateMemberRecords(MEMBER_FIELDS, {}, 10);
  // Assign synthetic keys and link each member to an office
  const membersWithKeys = members.map((m, i) => ({
    ...m,
    MemberKey: `member-${i}`,
    OfficeKey: officesWithKeys[i % officesWithKeys.length].OfficeKey
  }));

  // Populate pools so getGenerator('Property') can access them
  clearRecordPools();
  setRecordPool('Member', membersWithKeys);
  setRecordPool('Office', officesWithKeys);

  // Use getGenerator to go through the GENERATORS registry which wires pools
  const propertyGenerator = getGenerator('Property');
  const propertyRecords = propertyGenerator(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 20);

  it('flattens ListAgent fields from the Member pool', () => {
    for (const record of propertyRecords) {
      // ListAgent is always populated when pools exist
      expect(record.ListAgentFirstName).toBeDefined();
      expect(record.ListAgentLastName).toBeDefined();
      expect(record.ListAgentFullName).toBeDefined();
      expect(record.ListAgentKey).toBeDefined();
      // The key should reference a real member from the pool
      const memberKeys = membersWithKeys.map(m => m.MemberKey);
      expect(memberKeys).toContain(record.ListAgentKey);
    }
  });

  it('flattens BuyerAgent fields from the Member pool', () => {
    for (const record of propertyRecords) {
      expect(record.BuyerAgentFirstName).toBeDefined();
      expect(record.BuyerAgentKey).toBeDefined();
      const memberKeys = membersWithKeys.map(m => m.MemberKey);
      expect(memberKeys).toContain(record.BuyerAgentKey);
    }
  });

  it('derives Office from the agent Member OfficeKey', () => {
    for (const record of propertyRecords) {
      const agentKey = record.ListAgentKey as string;
      const agent = membersWithKeys.find(m => m.MemberKey === agentKey);
      expect(agent).toBeDefined();
      // The ListOffice should match the agent's office
      const expectedOffice = officesWithKeys.find(o => o.OfficeKey === agent!.OfficeKey);
      expect(record.ListOfficeKey).toBe(expectedOffice!.OfficeKey);
      expect(record.ListOfficeName).toBe(expectedOffice!.OfficeName);
    }
  });

  it('selects co-agents from the same office as the primary agent', () => {
    // Not every record has co-agents (probabilistic), so check those that do
    const withCoList = propertyRecords.filter(r => r.CoListAgentKey !== undefined);
    for (const record of withCoList) {
      const agentKey = record.ListAgentKey as string;
      const coAgentKey = record.CoListAgentKey as string;
      const agent = membersWithKeys.find(m => m.MemberKey === agentKey);
      const coAgent = membersWithKeys.find(m => m.MemberKey === coAgentKey);
      expect(agent).toBeDefined();
      expect(coAgent).toBeDefined();
      // Same office
      expect(coAgent!.OfficeKey).toBe(agent!.OfficeKey);
      // Different person
      expect(coAgentKey).not.toBe(agentKey);
    }
  });

  it('does not produce billion-dollar values for expense fields', () => {
    for (const record of propertyRecords) {
      const expenseFields = [
        'GardenerExpense', 'ManagerExpense', 'PoolExpense',
        'SuppliesExpense', 'ProfessionalManagementExpense',
        'FurnitureReplacementExpense', 'NewTaxesExpense'
      ];
      for (const field of expenseFields) {
        const val = record[field] as number;
        expect(val).toBeLessThanOrEqual(15000);
      }
    }
  });

  it('generates realistic unit counts', () => {
    for (const record of propertyRecords) {
      expect(record.NumberOfUnitsTotal as number).toBeLessThanOrEqual(75);
      expect(record.NumberOfPads as number).toBeLessThanOrEqual(10);
      const total = record.NumberOfUnitsTotal as number;
      const leased = record.NumberOfUnitsLeased as number;
      const vacant = record.NumberOfUnitsVacant as number;
      expect(leased + vacant).toBe(total);
    }
  });

  it('generates cap rate between 3% and 12%', () => {
    for (const record of propertyRecords) {
      const cap = record.CapRate as number;
      expect(cap).toBeGreaterThanOrEqual(0.03);
      expect(cap).toBeLessThanOrEqual(0.12);
    }
  });

  it('generates without pools (no crash, no flattened fields)', () => {
    clearRecordPools();
    const records = generatePropertyRecords(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 3);
    expect(records).toHaveLength(3);
    // No ListAgentKey since pools are empty
    expect(records[0].ListAgentKey).toBeUndefined();
  });
});

describe('reflattenAgentFields', () => {
  // Simulate the server flow: generate pools, generate property, assign FK, reflatten
  const offices = generateOfficeRecords(OFFICE_FIELDS, {}, 3);
  const officesWithKeys = offices.map((o, i) => ({ ...o, OfficeKey: `office-${i}` }));

  const members = generateMemberRecords(MEMBER_FIELDS, {}, 10);
  const membersWithKeys = members.map((m, i) => ({
    ...m,
    MemberKey: `member-${i}`,
    OfficeKey: officesWithKeys[i % officesWithKeys.length].OfficeKey
  }));

  it('corrects flattened fields to match FK-assigned keys', () => {
    // Generate a property with pools (flattening picks random members)
    clearRecordPools();
    setRecordPool('Member', membersWithKeys);
    setRecordPool('Office', officesWithKeys);
    const gen = getGenerator('Property');
    const records = [...gen(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 10)];

    for (const record of records) {
      // Simulate FK resolver overwriting ListAgentKey with a specific member
      const targetMember = membersWithKeys[3];
      record.ListAgentKey = targetMember.MemberKey;

      // Before reflatten, the flattened fields may not match the FK key
      // (they were picked randomly during generation)

      // Reflatten to fix the mismatch
      reflattenAgentFields(record, membersWithKeys, officesWithKeys);

      // After reflatten, the flattened fields MUST match the FK-assigned member
      expect(record.ListAgentKey).toBe(targetMember.MemberKey);
      expect(record.ListAgentFirstName).toBe(targetMember.MemberFirstName);
      expect(record.ListAgentLastName).toBe(targetMember.MemberLastName);
      expect(record.ListAgentFullName).toBe(targetMember.MemberFullName);
      expect(record.ListAgentEmail).toBe(targetMember.MemberEmail);
      expect(record.ListAgentMlsId).toBe(targetMember.MemberMlsId);

      // Office should match the target member's office
      const expectedOffice = officesWithKeys.find(o => o.OfficeKey === targetMember.OfficeKey);
      expect(record.ListOfficeKey).toBe(expectedOffice!.OfficeKey);
      expect(record.ListOfficeName).toBe(expectedOffice!.OfficeName);
    }
  });

  it('handles missing member key gracefully (no crash)', () => {
    const record: Record<string, unknown> = { ListAgentKey: 'nonexistent-key' };
    // Should not throw, just leave fields unchanged
    reflattenAgentFields(record, membersWithKeys, officesWithKeys);
    expect(record.ListAgentFirstName).toBeUndefined();
  });

  it('skips roles with no key assigned', () => {
    const record: Record<string, unknown> = {};
    reflattenAgentFields(record, membersWithKeys, officesWithKeys);
    // No keys = no flattening
    expect(record.ListAgentFirstName).toBeUndefined();
    expect(record.BuyerAgentFirstName).toBeUndefined();
  });

  it('handles multiple roles independently', () => {
    clearRecordPools();
    setRecordPool('Member', membersWithKeys);
    setRecordPool('Office', officesWithKeys);
    const gen = getGenerator('Property');
    const records = [...gen(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 5)];

    for (const record of records) {
      // Assign different members to different roles
      const listMember = membersWithKeys[0];
      const buyerMember = membersWithKeys[5];
      record.ListAgentKey = listMember.MemberKey;
      record.BuyerAgentKey = buyerMember.MemberKey;

      reflattenAgentFields(record, membersWithKeys, officesWithKeys);

      // Each role should have the correct member's data
      expect(record.ListAgentFirstName).toBe(listMember.MemberFirstName);
      expect(record.BuyerAgentFirstName).toBe(buyerMember.MemberFirstName);
      // They should be different people
      expect(record.ListAgentFirstName).not.toBe(record.BuyerAgentFirstName);
    }
  });
});

describe('getGenerator', () => {
  it('returns Property generator for Property resource', () => {
    const gen = getGenerator('Property');
    const records = gen(PROPERTY_FIELDS, SAMPLE_LOOKUPS, 1);
    expect(records).toHaveLength(1);
    // Property generator sets StreetName
    expect(typeof records[0].StreetName).toBe('string');
  });

  it('returns generic generator for unknown resources', () => {
    const fields: ResoField[] = [
      makeField('CustomField', 'Edm.String', { resourceName: 'Custom', nullable: false }),
      makeField('CustomCount', 'Edm.Int32', { resourceName: 'Custom', nullable: false })
    ];
    const gen = getGenerator('CustomResource');
    const records = gen(fields, {}, 2);
    expect(records).toHaveLength(2);
    expect(records[0].CustomField).toBeDefined();
  });
});
