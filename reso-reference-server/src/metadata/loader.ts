import { readFile } from 'node:fs/promises';
import { isEnumType } from '@reso-standards/reso-validation';
import type { ResoField, ResoMetadata } from './types.js';

export { isEnumType };
// Pure metadata helpers now live in the shared reso-common package (universal, zero-dep).
export { getFieldsForResource, getKeyFieldForResource, getLookupsForType } from '@reso-standards/reso-common';

/** Reads and parses a RESO metadata JSON file from disk. */
export const loadMetadata = async (filePath: string): Promise<ResoMetadata> => {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as ResoMetadata;
};

/** Extracts the lookup name from a field type string. For enums, returns the type itself. */
export const getLookupNameFromType = (type: string): string => type;

/** Returns the standard name annotation value for a field, if present. */
export const getStandardName = (field: ResoField): string | undefined =>
  field.annotations.find(a => a.term === 'RESO.OData.Metadata.StandardName')?.value;

/** Returns the description annotation value for a field, if present. */
export const getDescription = (field: ResoField): string | undefined => field.annotations.find(a => a.term === 'Core.Description')?.value;
