import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import type { MetadataReport, MetadataReportField } from '@reso-standards/reso-metadata-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  generateMetadataReport,
  normalizeFieldType,
  normalizeReportFieldTypes,
  normalizeReportJson
} from '../../src/sdk/report-field-types.js';

/**
 * A metadata report's `type` is a field's ELEMENT type; collection-ness lives only in `isCollection`. A wrapped
 * `Collection(Edm.String)` reaching the schema generator falls through to `object`, and every string in the array
 * fails "MUST be object but found string". `reso-metadata-utils` 0.1.4 fixed that at its source on 2026-10-16, but on
 * 2026-10-21 an install that resolved 0.1.3 brought it back: a provider's `MlgCanUse`, a plain array of strings,
 * produced 2,779 false errors and failed a certification run. Each test below guards one way it can come back.
 */

// The fixed package normalizes on its own, so to prove the ENGINE does, its generator is made to return the old,
// wrapped shape for the one test that needs it.
const raw = vi.hoisted(() => ({ wrapped: false }));
vi.mock('@reso-standards/reso-metadata-utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@reso-standards/reso-metadata-utils')>();
  return {
    ...actual,
    generateMetadataReport: (...args: Parameters<typeof actual.generateMetadataReport>) => {
      const report = actual.generateMetadataReport(...args);
      return raw.wrapped
        ? { ...report, fields: report.fields.map(f => (f.isCollection && !f.isExpansion ? { ...f, type: `Collection(${f.type})` } : f)) }
        : report;
    }
  };
});

const require = createRequire(import.meta.url);
const { generateJsonSchema } = require(resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js'));

const field = (over: Partial<MetadataReportField>): MetadataReportField =>
  ({ resourceName: 'Property', fieldName: 'MlgCanUse', type: 'Edm.String', annotations: [], ...over }) as MetadataReportField;

const report = (fields: ReadonlyArray<MetadataReportField>): MetadataReport =>
  ({
    description: 'test',
    generatedOn: '2026-10-21T00:00:00.000Z',
    version: '2.1',
    resources: [],
    fields,
    lookups: []
  }) as unknown as MetadataReport;

/** The vendor-extension field that failed on 2026-10-21, in the shape reso-metadata-utils 0.1.3 wrote it. */
const MLG_CAN_USE_AS_0_1_3_WROTE_IT = field({ type: 'Collection(Edm.String)', maxLength: 1024, isCollection: true });

describe('normalizeFieldType', () => {
  it('unwraps a scalar collection to its element type and keeps it a collection', () => {
    expect(normalizeFieldType(MLG_CAN_USE_AS_0_1_3_WROTE_IT)).toEqual({
      ...MLG_CAN_USE_AS_0_1_3_WROTE_IT,
      type: 'Edm.String',
      isCollection: true
    });
  });

  it('marks a wrapped field as a collection even when the writer forgot to', () => {
    expect(normalizeFieldType(field({ type: 'Collection(Edm.String)' })).isCollection).toBe(true);
  });

  it('unwraps an enum collection to the enum FQDN, which enum joins key on', () => {
    expect(normalizeFieldType(field({ type: 'Collection(org.reso.metadata.enums.Feature)', isCollection: true })).type).toBe(
      'org.reso.metadata.enums.Feature'
    );
  });

  it('unwraps an expansion the way reso-metadata-utils 0.1.4 does, keeping it an expansion', () => {
    const out = normalizeFieldType(
      field({ type: 'Collection(com.example.metadata.PropertyRooms)', typeName: 'PropertyRooms', isExpansion: true })
    );
    expect(out).toMatchObject({
      type: 'com.example.metadata.PropertyRooms',
      typeName: 'PropertyRooms',
      isExpansion: true,
      isCollection: true
    });
  });

  it('leaves an element type alone, as the same object', () => {
    const scalar = field({ type: 'Edm.String', isCollection: true });
    expect(normalizeFieldType(scalar)).toBe(scalar);
  });
});

describe('normalizeReportFieldTypes', () => {
  it('returns the same report when nothing is wrapped, so identity checks for a no-op still work', () => {
    const clean = report([field({ type: 'Edm.String', isCollection: true }), field({ fieldName: 'ListPrice', type: 'Edm.Decimal' })]);
    expect(normalizeReportFieldTypes(clean)).toBe(clean);
  });

  it('normalizes only the wrapped fields and leaves everything else as it was', () => {
    const other = field({ fieldName: 'ListPrice', type: 'Edm.Decimal' });
    const out = normalizeReportFieldTypes(report([MLG_CAN_USE_AS_0_1_3_WROTE_IT, other]));
    expect(out.fields[0]?.type).toBe('Edm.String');
    expect(out.fields[1]).toBe(other);
    expect(out.fields.some(f => String(f.type).startsWith('Collection('))).toBe(false);
  });
});

describe('normalizeReportJson, for a report read from a file', () => {
  it('normalizes a report', () => {
    const out = normalizeReportJson({ fields: [{ fieldName: 'MlgCanUse', type: 'Collection(Edm.String)' }], lookups: [] });
    expect(out).toEqual({ fields: [{ fieldName: 'MlgCanUse', type: 'Edm.String', isCollection: true }], lookups: [] });
  });

  it('hands back anything that is not a report unchanged, for the caller to reject', () => {
    for (const notAReport of [null, undefined, 'text', 42, [], { fields: 'x' }, { fields: [1, 2] }, { lookups: [] }]) {
      expect(normalizeReportJson(notAReport)).toBe(notAReport);
    }
  });
});

describe('the engine never builds a report with a wrapped type', () => {
  const EDMX = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="com.example">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String" Nullable="false"/>
        <Property Name="MlgCanUse" Type="Collection(Edm.String)" MaxLength="1024"/>
      </EntityType>
      <EntityContainer Name="Default"><EntitySet Name="Property" EntityType="com.example.Property"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('even when the installed reso-metadata-utils still writes the wrapper', () => {
    raw.wrapped = true;
    try {
      const mlgCanUse = generateMetadataReport(EDMX, '2.1').fields.find(f => f.fieldName === 'MlgCanUse');
      expect(mlgCanUse?.type).toBe('Edm.String');
      expect(mlgCanUse?.isCollection).toBe(true);
    } finally {
      raw.wrapped = false;
    }
  });
});

describe('the schema generator, the one place every schema is built', () => {
  /** The item schema the generator built for one field. */
  const itemsFor = async (metadataReportJson: unknown, fieldName = 'MlgCanUse') => {
    const schema = await generateJsonSchema({ metadataReportJson });
    return schema?.definitions?.Property?.properties?.[fieldName]?.items as { type?: unknown } | undefined;
  };

  it('types the items of a wrapped string collection as strings, not objects', async () => {
    const items = await itemsFor(report([MLG_CAN_USE_AS_0_1_3_WROTE_IT]));
    expect(items?.type, 'the wrapped type fell through to object').not.toEqual('object');
    expect([items?.type].flat()).toContain('string');
  });

  it('builds the same item schema for the wrapped and the unwrapped form', async () => {
    const wrapped = await itemsFor(report([MLG_CAN_USE_AS_0_1_3_WROTE_IT]));
    const unwrapped = await itemsFor(report([normalizeFieldType(MLG_CAN_USE_AS_0_1_3_WROTE_IT)]));
    expect(wrapped).toEqual(unwrapped);
  });
});

describe('guards on the way the bug came back', () => {
  const root = resolve(import.meta.dirname, '../..');

  it('nothing in the engine builds a report with the package generator directly', () => {
    const files = (dir: string): ReadonlyArray<string> =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
      });
    const offenders = files(join(root, 'src'))
      .filter(path => !path.endsWith(join('sdk', 'report-field-types.ts')))
      .filter(path => {
        const text = readFileSync(path, 'utf-8');
        return /import\s*\{[^}]*\bgenerateMetadataReport\b[^}]*\}\s*from\s*['"]@reso-standards\/reso-metadata-utils['"]/.test(text);
      })
      .map(path => relative(root, path));
    expect(offenders, 'import generateMetadataReport from src/sdk/report-field-types.ts instead').toEqual([]);
  });

  it('requires reso-metadata-utils 0.1.4 or later, the first release that writes element types', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
    const range = pkg.dependencies['@reso-standards/reso-metadata-utils'] ?? '';
    const floor = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(range)?.slice(1).map(Number);
    expect(floor, `unrecognized range ${range}`).toBeDefined();
    const [major = 0, minor = 0, patch = 0] = floor ?? [];
    expect(major * 1e6 + minor * 1e3 + patch, `${range} admits a release that writes Collection(...) types`).toBeGreaterThanOrEqual(1004);
  });
});
