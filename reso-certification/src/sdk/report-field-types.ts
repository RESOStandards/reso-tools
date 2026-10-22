import { generateMetadataReport as generateRawMetadataReport } from '@reso-standards/reso-metadata-utils';
import type { MetadataReport, MetadataReportField } from '@reso-standards/reso-metadata-utils';

/**
 * A metadata report's `type` is a field's ELEMENT type. Collection-ness lives only in `isCollection`, so no
 * field ever carries a `Collection(...)` wrapper: a scalar collection reads `type: "Edm.String",
 * isCollection: true`, and an expansion reads `type: "<Namespace>.<EntityType>", isCollection: true`.
 *
 * `reso-metadata-utils` keeps that contract from 0.1.4 on. Earlier releases passed the CSDL wrapper through, and
 * every consumer here tests `type` against a bare `Edm.*`, so a wrapped type fails each test silently. The
 * JSON Schema generator falls through to `object` and rejects every string in the array ("MUST be object but
 * found string"); `isEnumType` reads it as an enumeration; the metadata map reads it as a complex type.
 *
 * The dependency floor stops a fresh install from picking an unfixed release, but an install can still resolve
 * one from a stale cache, and a report written by an older tool can arrive from disk. So the engine also
 * normalizes every report where it enters, and a report has the same shape whichever version wrote it. On
 * 2026-10-21 a `reso-metadata-utils` 0.1.3 install turned MLS Grid's `MlgCanUse` (a plain array of strings)
 * into 2,779 false errors and failed a certification run.
 */

/** CSDL's collection form: `Collection(<element type>)`. */
const COLLECTION_TYPE = /^Collection\((.+)\)$/;

const wrappedElementType = (type: unknown): string | undefined => (typeof type === 'string' ? COLLECTION_TYPE.exec(type)?.[1] : undefined);

/** One field in the report's shape: the element type in `type`, and `isCollection` set when it was wrapped. */
export const normalizeFieldType = (field: MetadataReportField): MetadataReportField => {
  const element = wrappedElementType(field.type);
  return element === undefined ? field : { ...field, type: element, isCollection: true };
};

/**
 * Every field of a report in the report's shape. Returns the SAME object when no field is wrapped, so callers
 * that compare identity to detect a no-op keep working.
 */
export const normalizeReportFieldTypes = (report: MetadataReport): MetadataReport =>
  report.fields.some(field => wrappedElementType(field.type) !== undefined)
    ? { ...report, fields: report.fields.map(normalizeFieldType) }
    : report;

/**
 * The engine's only way to turn CSDL into a metadata report: `reso-metadata-utils`' generator, normalized. Every
 * caller imports this rather than the package's own, and a test fails if one does not.
 */
export const generateMetadataReport = (...args: Parameters<typeof generateRawMetadataReport>): MetadataReport =>
  normalizeReportFieldTypes(generateRawMetadataReport(...args));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const normalizeFieldJson = (field: Record<string, unknown>): Record<string, unknown> => {
  const element = wrappedElementType(field.type);
  return element === undefined ? field : { ...field, type: element, isCollection: true };
};

/**
 * A report read from a file, in the report's shape. A file can come from any tool and any version, so this checks
 * the shape before touching it and returns anything that is not a report unchanged, for the caller to reject.
 */
export const normalizeReportJson = (json: unknown): unknown => {
  if (!isRecord(json) || !Array.isArray(json.fields)) return json;
  const fields: ReadonlyArray<unknown> = json.fields;
  if (!fields.every(isRecord)) return json;
  return fields.some(field => wrappedElementType(field.type) !== undefined) ? { ...json, fields: fields.map(normalizeFieldJson) } : json;
};
