import { describe, it, expect } from 'vitest';
import { buildInsertQuery, coerceServedInteger, deserializeRow, isServedAsInteger } from '../src/db/queries.js';
import type { ResoField } from '../src/metadata/types.js';

// #286 — integer-served fields must serialize as JS integers against their advertised type. The EDMX generator
// promotes a DD Edm.Decimal/Edm.Double with scale 0 (or absent) to Edm.Int64 ("scale 0 denotes a whole number"),
// so deserializeRow must coerce those to integers too — not only the Edm.Int* types. The real #286 fields
// (Media.ImageHeight, GreenVerificationMetric, PowerProductionAnnual) are declared Edm.Decimal scale 0. SQLite
// returns a REAL for a decimal stored in such a column; Postgres returns BIGINT/NUMERIC as strings. Both must coerce.

const field = (fieldName: string, type: string, scale?: number): ResoField =>
  ({ fieldName, type, isCollection: false, ...(scale !== undefined && { scale }) } as ResoField);

const fields: ReadonlyArray<ResoField> = [
  field('ImageHeight', 'Edm.Decimal', 0), // the REAL #286 shape: DD Decimal scale 0 → advertised Edm.Int64
  field('GreenVerificationMetric', 'Edm.Decimal', 0),
  field('PowerProductionAnnual', 'Edm.Decimal', 0),
  field('BedroomsTotal', 'Edm.Int32'), // a genuine Edm.Int* field
  field('LotSizeSquareFeet', 'Edm.Int64'),
  field('ListPrice', 'Edm.Decimal', 2), // scale > 0 → a true decimal, must NOT be coerced
  field('Ratio', 'Edm.Double', 3),
  field('MediaKey', 'Edm.String')
];

describe('deserializeRow — integer coercion (#286)', () => {
  it('truncates a NUMBER decimal on a scale-0 Decimal field (SQLite REAL case — the real #286 fields)', () => {
    const row = deserializeRow({ ImageHeight: 98.9, GreenVerificationMetric: 59.4, PowerProductionAnnual: 271.1 }, fields);
    expect(row.ImageHeight).toBe(98);
    expect(row.GreenVerificationMetric).toBe(59);
    expect(row.PowerProductionAnnual).toBe(271);
    expect(Number.isInteger(row.ImageHeight as number)).toBe(true);
  });

  it('truncates a STRING decimal on a scale-0 Decimal field (Postgres NUMERIC-as-string case)', () => {
    const row = deserializeRow({ ImageHeight: '115.2', PowerProductionAnnual: '154' }, fields);
    expect(row.ImageHeight).toBe(115);
    expect(row.PowerProductionAnnual).toBe(154);
  });

  it('also truncates genuine Edm.Int* fields (number and string)', () => {
    const row = deserializeRow({ BedroomsTotal: 3.0, LotSizeSquareFeet: '7500' }, fields);
    expect(row.BedroomsTotal).toBe(3);
    expect(row.LotSizeSquareFeet).toBe(7500);
  });

  it('leaves an already-integer value untouched', () => {
    expect(deserializeRow({ ImageHeight: 82 }, fields).ImageHeight).toBe(82);
  });

  it('does NOT coerce a scale>0 Decimal or Double — they keep their fractional part', () => {
    const row = deserializeRow({ ListPrice: '100000.50', Ratio: 0.75 }, fields);
    expect(row.ListPrice).toBe(100000.5);
    expect(row.Ratio).toBe(0.75);
  });

  it('leaves a null integer-served field as null (nullable columns)', () => {
    expect(deserializeRow({ ImageHeight: null }, fields).ImageHeight).toBeNull();
  });

  it('leaves a non-numeric string on an integer-served field alone (never NaN it)', () => {
    expect(deserializeRow({ ImageHeight: 'n/a' }, fields).ImageHeight).toBe('n/a');
  });
});

describe('isServedAsInteger — mirrors the EDMX generator (Int* ∪ scale-0 Decimal/Double)', () => {
  it('true for Edm.Int* and scale-0 Decimal/Double; false for scale>0 and non-numeric', () => {
    expect(isServedAsInteger(field('a', 'Edm.Int64'))).toBe(true);
    expect(isServedAsInteger(field('a', 'Edm.Decimal', 0))).toBe(true);
    expect(isServedAsInteger(field('a', 'Edm.Double', 0))).toBe(true);
    expect(isServedAsInteger(field('a', 'Edm.Decimal'))).toBe(true); // scale absent → treated as 0 (as the generator does)
    expect(isServedAsInteger(field('a', 'Edm.Decimal', 2))).toBe(false);
    expect(isServedAsInteger(field('a', 'Edm.String'))).toBe(false);
  });
});

describe('insert coercion (#286 filter consistency) — stored value matches the served type', () => {
  // The live cert re-run surfaced this: a deserialize-only fix served integers but left the DB storing decimals, so
  // an integer `$filter`/`$orderby` on the column disagreed with the served value. The insert path must coerce too.
  it('coerceServedInteger truncates a scale-0 Decimal value (the shared insert+read rule)', () => {
    expect(coerceServedInteger(98.9, field('ImageHeight', 'Edm.Decimal', 0))).toBe(98);
    expect(coerceServedInteger('271.1', field('x', 'Edm.Decimal', 0))).toBe(271);
    expect(coerceServedInteger(100000.5, field('ListPrice', 'Edm.Decimal', 2))).toBe(100000.5); // scale>0 untouched
  });

  it('buildInsertQuery stores a scale-0 Decimal as an integer in its parameter values', () => {
    const q = buildInsertQuery('Media', { MediaKey: 'm1', ImageHeight: 98.9, ListPrice: 100000.5 },
      [field('MediaKey', 'Edm.String'), field('ImageHeight', 'Edm.Decimal', 0), field('ListPrice', 'Edm.Decimal', 2)]);
    // values order follows the record's own key order (MediaKey, ImageHeight, ListPrice)
    expect(q.values).toContain(98); // ImageHeight truncated for storage
    expect(q.values).not.toContain(98.9);
    expect(q.values).toContain(100000.5); // scale-2 decimal preserved
  });
});
