import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  checkDisallowedSynonyms, checkClosedEnumValues, checkFieldTypes, checkSuggestedMaxConstraints,
  checkLookupResourceFields, checkLookupNameAnnotations, checkLookupNameIntegrity, runDdMetadataChecks,
} from '../../src/metadata/dd-metadata-checks.js';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import { generateReferenceArtifacts } from '../../src/metadata/reference-artifacts.js';
import type { MetadataReport, MetadataReportLookup } from '../../src/metadata/serializer.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const SN = 'RESO.OData.Metadata.StandardName';

const emptyReport = (fields: ReadonlyArray<{ resourceName: string; fieldName: string }>): MetadataReport => ({
  description: 'test', version: '2.1', generatedOn: '2026-06-21T00:00:00.000Z',
  resources: [], fields: fields.map((f) => ({ ...f, type: 'Edm.String', annotations: [] })), lookups: [], actions: [], functions: [],
});

const makeReport = (
  fields: ReadonlyArray<{ resourceName: string; fieldName: string; type: string; isCollection?: boolean; isFlags?: boolean; isEnumeration?: boolean; isExpansion?: boolean; maxLength?: number; precision?: number; scale?: number; annotations?: ReadonlyArray<{ term: string; value: string }> }>,
  lookups: ReadonlyArray<MetadataReportLookup>,
): MetadataReport => ({
  description: 'test', version: '2.1', generatedOn: '2026-06-21T00:00:00.000Z',
  resources: [], fields: fields.map((f) => ({ ...f, annotations: f.annotations ?? [] })), lookups, actions: [], functions: [],
});

describe('checkDisallowedSynonyms', () => {
  // The Commander's StandardStatus scenario: NormalizedListingStatus / RetsStatus must NOT exist.
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', synonyms: 'NormalizedListingStatus, RetsStatus' },
      { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' },
    ],
    lookups: [],
  };

  it('flags a provider field that uses a disallowed synonym', () => {
    const findings = checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Property', fieldName: 'ListPrice' },
      { resourceName: 'Property', fieldName: 'NormalizedListingStatus' },
    ]), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'disallowed-synonym', resourceName: 'Property', fieldName: 'NormalizedListingStatus' });
    expect(findings[0].message).toContain('StandardStatus');
  });

  it('passes a provider that uses only standard field names', () => {
    expect(checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Property', fieldName: 'StandardStatus' },
      { resourceName: 'Property', fieldName: 'ListPrice' },
    ]), reference)).toEqual([]);
  });

  it('is resource-scoped: the synonym name in a DIFFERENT resource is not flagged', () => {
    expect(checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Member', fieldName: 'NormalizedListingStatus' },
    ]), reference)).toEqual([]);
  });

  it('does not flag a synonym that is itself a standard field (collision guard)', () => {
    const refWithCollision: DdReference = {
      fields: [
        { resourceName: 'Property', fieldName: 'A', type: 'Edm.String', synonyms: 'B' },
        { resourceName: 'Property', fieldName: 'B', type: 'Edm.String' }, // B is also a standard field
      ],
      lookups: [],
    };
    expect(checkDisallowedSynonyms(emptyReport([{ resourceName: 'Property', fieldName: 'B' }]), refWithCollision)).toEqual([]);
  });

  // Self-test invariant: the DD reference, checked against itself, MUST be clean — the standard
  // never uses its own synonyms as field names. (Verified across dd-1.7/2.0/2.1.)
  it.each(['2.0', '2.1'])('DD %s reference passes the disallowed-synonym gate clean', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkDisallowedSynonyms(ref, ref)).toEqual([]);
  });
});

describe('checkClosedEnumValues', () => {
  const SS = 'org.reso.metadata.enums.StandardStatus';
  const OPEN = 'org.reso.metadata.enums.OpenEnum';
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'StandardStatus', type: SS, lookupStatus: 'Locked with Enumerations' },
      { resourceName: 'Property', fieldName: 'OpenField', type: OPEN, lookupStatus: 'Open with Enumerations' },
    ],
    lookups: [
      { lookupName: SS, lookupValue: 'Active', annotations: [{ term: SN, value: 'Active' }] },
      { lookupName: SS, lookupValue: 'ActiveUnderContract', annotations: [{ term: SN, value: 'Active Under Contract' }] },
      { lookupName: OPEN, lookupValue: 'A', annotations: [{ term: SN, value: 'A' }] },
    ],
  };

  it('flags a value outside a closed enumeration', () => {
    const findings = checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      [
        { lookupName: SS, lookupValue: 'Active', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active' }] },
        { lookupName: SS, lookupValue: 'Foreclosure', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Foreclosure' }] }, // LOCAL
      ]), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'closed-enum-value', resourceName: 'Property', fieldName: 'StandardStatus' });
    expect(findings[0].message).toContain('Foreclosure');
  });

  it('passes when all closed-enum values are standard', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      [
        { lookupName: SS, lookupValue: 'Active', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active' }] },
        { lookupName: SS, lookupValue: 'ActiveUnderContract', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active Under Contract' }] },
      ]), reference)).toEqual([]);
  });

  it('permits a value that matches by StandardName even if the machine value differs', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      // machine 'AUC' is non-standard, but its StandardName is the standard display form → allowed.
      [{ lookupName: SS, lookupValue: 'AUC', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active Under Contract' }] }]), reference)).toEqual([]);
  });

  it('does NOT check open enumerations (local values there are mapping variations)', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'OpenField', type: OPEN }],
      [{ lookupName: OPEN, lookupValue: 'SomethingLocal', type: 'Edm.Int32', annotations: [] }]), reference)).toEqual([]);
  });

  // Self-test invariant: the DD reference's closed enums contain exactly the standard values, so the
  // reference checked against itself MUST be clean.
  it.each(['2.0', '2.1'])('DD %s reference passes the closed-enum gate clean', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkClosedEnumValues(ref, ref)).toEqual([]);
  });
});

describe('checkFieldTypes', () => {
  const SS = 'org.reso.metadata.enums.StandardStatus';
  // Reference declares: a String, an Integer, a Single Enumeration, and a Multiple Enumeration.
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'PublicRemarks', type: 'Edm.String' },
      { resourceName: 'Property', fieldName: 'BedroomsTotal', type: 'Edm.Int64' },
      { resourceName: 'Property', fieldName: 'StandardStatus', type: SS, isEnumeration: true, isCollection: false },
      { resourceName: 'Property', fieldName: 'Appliances', type: 'org.reso.metadata.enums.Appliances', isEnumeration: true, isCollection: true },
    ],
    lookups: [],
  };
  const enumLookup = (name: string): MetadataReportLookup => ({ lookupName: name, lookupValue: 'X', type: 'Edm.Int32', annotations: [] });

  it('passes a primitive that maps to the DD type', () => {
    expect(checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'PublicRemarks', type: 'Edm.String' }], []), reference)).toEqual([]);
  });

  it('flags a primitive with the wrong EDM type', () => {
    const findings = checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'BedroomsTotal', type: 'Edm.String' }], []), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'field-type', fieldName: 'BedroomsTotal' });
    expect(findings[0].message).toContain('Integer');
  });

  it('accepts a single enumeration as Edm.String + Lookup Resource', () => {
    expect(checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'Edm.String', isEnumeration: true }], []), reference)).toEqual([]);
  });

  it('accepts a single enumeration as an EnumType FQDN with an Int underlying type', () => {
    expect(checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS, isEnumeration: true }], [enumLookup(SS)]), reference)).toEqual([]);
  });

  it('flags a single enumeration declared as a collection', () => {
    const findings = checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS, isEnumeration: true, isCollection: true }], [enumLookup(SS)]), reference);
    expect(findings[0].message).toContain('cannot be collections');
  });

  it('flags a single enumeration EnumType with IsFlags=true', () => {
    const findings = checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS, isEnumeration: true, isFlags: true }], [enumLookup(SS)]), reference);
    expect(findings[0].message).toContain('IsFlags');
  });

  it('accepts a multiple enumeration as Collection(Edm.String)', () => {
    expect(checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'Appliances', type: 'Collection(Edm.String)', isEnumeration: true, isCollection: true }], []), reference)).toEqual([]);
  });

  it('flags a multiple enumeration declared as a non-collection Edm.String', () => {
    const findings = checkFieldTypes(makeReport([{ resourceName: 'Property', fieldName: 'Appliances', type: 'Edm.String', isEnumeration: true, isCollection: false }], []), reference);
    expect(findings[0].message).toContain('Collection(Edm.String)');
  });

  // Self-test invariant: the DD reference's own field types MUST satisfy their declared DD types.
  it.each(['2.0', '2.1'])('DD %s reference passes the field-type gate clean', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkFieldTypes(ref, ref)).toEqual([]);
  });
});

describe('checkSuggestedMaxConstraints (SHOULD warnings)', () => {
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'PublicRemarks', type: 'Edm.String', maxLength: 4000 },
      { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal', precision: 14, scale: 2 },
    ],
    lookups: [],
  };

  it('warns (warning severity, not error) when a Suggested Max attribute differs', () => {
    const findings = checkSuggestedMaxConstraints(makeReport([{ resourceName: 'Property', fieldName: 'PublicRemarks', type: 'Edm.String', maxLength: 2000 }], []), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'suggested-max', severity: 'warning', fieldName: 'PublicRemarks' });
    expect(findings[0].message).toContain('Suggested Max Length of 4000 but was 2000');
  });

  it('emits a warning per differing attribute (precision and scale)', () => {
    const findings = checkSuggestedMaxConstraints(makeReport([{ resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal', precision: 10, scale: 4 }], []), reference);
    expect(findings).toHaveLength(2);
    const joined = findings.map((f) => f.message).join(' ');
    expect(joined).toContain('Precision');
    expect(joined).toContain('Scale');
  });

  it('is silent when the attributes match the suggested maxima', () => {
    expect(checkSuggestedMaxConstraints(makeReport([
      { resourceName: 'Property', fieldName: 'PublicRemarks', type: 'Edm.String', maxLength: 4000 },
      { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal', precision: 14, scale: 2 },
    ], []), reference)).toEqual([]);
  });

  it.each(['2.0', '2.1'])('DD %s reference is silent under suggested-max (provider == reference)', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkSuggestedMaxConstraints(ref, ref)).toEqual([]);
  });
});

describe('Lookup Resource checks', () => {
  const LN = 'RESO.OData.Metadata.LookupName';
  const reference: DdReference = {
    fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', isEnumeration: true }],
    lookups: [],
  };

  describe('checkLookupResourceFields', () => {
    it('skips when there is no Lookup resource (EnumType representation)', () => {
      expect(checkLookupResourceFields(makeReport([{ resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' }], []), reference)).toEqual([]);
    });

    it('passes when the Lookup resource declares all mandatory fields', () => {
      const fields = ['LookupKey', 'LookupName', 'LookupValue', 'ModificationTimestamp'].map((fieldName) => ({ resourceName: 'Lookup', fieldName, type: 'Edm.String' }));
      expect(checkLookupResourceFields(makeReport(fields, []), reference)).toEqual([]);
    });

    it('flags a missing mandatory Lookup field', () => {
      const fields = ['LookupKey', 'LookupName', 'LookupValue'].map((fieldName) => ({ resourceName: 'Lookup', fieldName, type: 'Edm.String' })); // no ModificationTimestamp
      const findings = checkLookupResourceFields(makeReport(fields, []), reference);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ check: 'lookup-resource-fields', fieldName: 'ModificationTimestamp', severity: 'error' });
    });
  });

  describe('checkLookupNameAnnotations', () => {
    it('flags a string-enum field missing the LookupName annotation', () => {
      const findings = checkLookupNameAnnotations(makeReport([{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'Edm.String', isEnumeration: true }], []), reference);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ check: 'lookup-name-annotation', fieldName: 'StandardStatus', severity: 'error' });
    });

    it('passes a string-enum field that carries the annotation', () => {
      const field = { resourceName: 'Property', fieldName: 'StandardStatus', type: 'Edm.String', isEnumeration: true, annotations: [{ term: LN, value: 'StandardStatus' }] };
      expect(checkLookupNameAnnotations(makeReport([field], []), reference)).toEqual([]);
    });

    it('exempts the EnumType representation (nominal type needs no annotation)', () => {
      const field = { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', isEnumeration: true };
      expect(checkLookupNameAnnotations(makeReport([field], []), reference)).toEqual([]);
    });
  });

  describe('checkLookupNameIntegrity', () => {
    const annotated = (value: string) => ({ resourceName: 'Property', fieldName: 'StandardStatus', type: 'Edm.String', annotations: [{ term: LN, value }] });

    it('flags an annotation that does not resolve to the Lookup data', () => {
      const report = makeReport([annotated('Nonexistent')], [{ lookupName: 'StandardStatus', lookupValue: 'Active', type: 'Edm.String', annotations: [] }]);
      const findings = checkLookupNameIntegrity(report, reference);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ check: 'lookup-name-integrity', fieldName: 'StandardStatus', severity: 'error' });
      expect(findings[0].message).toContain('Nonexistent');
    });

    it('passes when the annotation resolves to a Lookup Resource entry', () => {
      const report = makeReport([annotated('StandardStatus')], [{ lookupName: 'StandardStatus', lookupValue: 'Active', type: 'Edm.String', annotations: [] }]);
      expect(checkLookupNameIntegrity(report, reference)).toEqual([]);
    });
  });

  // Self-test: the generated string-rep reference is internally consistent — its Lookup resource has
  // the mandatory fields, every string-enum field carries the LookupName annotation, and every
  // annotation resolves to the Lookup data.
  it('the generated DD 2.1 string-rep reference passes all Lookup Resource checks clean', () => {
    const ref = getReferenceMetadata('2.1') as MetadataReport & DdReference;
    const { metadataReport } = generateReferenceArtifacts(ref, ref.resources as unknown as string[], 'string', '2.1');
    expect(checkLookupResourceFields(metadataReport, ref)).toEqual([]);
    expect(checkLookupNameAnnotations(metadataReport, ref)).toEqual([]);
    expect(checkLookupNameIntegrity(metadataReport, ref)).toEqual([]);
  });
});

describe('runDdMetadataChecks', () => {
  it('aggregates findings (currently the disallowed-synonym check)', () => {
    const reference: DdReference = {
      fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'x', synonyms: 'RetsStatus' }],
      lookups: [],
    };
    expect(runDdMetadataChecks(emptyReport([{ resourceName: 'Property', fieldName: 'RetsStatus' }]), reference)).toHaveLength(1);
  });
});
