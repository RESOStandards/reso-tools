/**
 * Shared OData metadata validation for all certification pipelines.
 * Combines XSD structural validation and CSDL semantic validation.
 */

import { parseCsdlXml, validateCsdl } from '@reso-standards/reso-client';
import { validateCsdlXml, detectODataVersion } from '../xsd/validate-csdl.js';
import type { ODataVersion, XsdValidationError } from '../xsd/validate-csdl.js';

/** Combined metadata validation result. */
export interface MetadataValidationResult {
  readonly xsdValid: boolean;
  readonly semanticValid: boolean;
  readonly odataVersion: ODataVersion;
  readonly xsdErrors: ReadonlyArray<XsdValidationError>;
  readonly semanticErrors: ReadonlyArray<{ readonly path: string; readonly message: string; readonly specUrl?: string }>;
}

/**
 * Run both XSD and semantic validation against OData CSDL XML metadata.
 *
 * Parses the XML into a full CsdlSchema internally for semantic validation.
 *
 * @param csdlXml - Raw CSDL XML string from the server.
 * @param odataVersion - Optional OData version override.
 * @returns Combined validation result.
 */
export const validateMetadata = async (
  csdlXml: string,
  odataVersion?: ODataVersion,
): Promise<MetadataValidationResult> => {
  const detectedVersion = odataVersion ?? detectODataVersion(csdlXml) ?? '4.0';

  // XSD structural validation
  const xsdResult = await validateCsdlXml(csdlXml, detectedVersion);

  // Parse and run semantic CSDL validation
  const parsedSchema = parseCsdlXml(csdlXml);
  const semanticVersion = detectedVersion === '4.01' ? '4.01' : '4.0';
  const semanticResult = validateCsdl(parsedSchema, semanticVersion);

  return {
    xsdValid: xsdResult.valid,
    semanticValid: semanticResult.valid,
    odataVersion: detectedVersion,
    xsdErrors: xsdResult.errors,
    semanticErrors: semanticResult.errors,
  };
};

/**
 * Format validation results into a human-readable summary for pipeline step output.
 */
export const formatValidationSummary = (result: MetadataValidationResult): string => {
  const xsdMsg = result.xsdValid ? 'XSD valid' : `${result.xsdErrors.length} XSD error(s)`;
  const semMsg = result.semanticValid ? 'semantics valid' : `${result.semanticErrors.length} semantic error(s)`;
  return `OData ${result.odataVersion}: ${xsdMsg}, ${semMsg}`;
};

/**
 * Collect all error messages from a validation result for pipeline step errors array.
 */
export const collectValidationErrors = (result: MetadataValidationResult): ReadonlyArray<string> => [
  ...result.xsdErrors.map(e => `[XSD] ${e.message}${e.line ? ` (line ${e.line})` : ''}`),
  ...result.semanticErrors.map(e => `[${e.path}] ${e.message}${e.specUrl ? ` — ${e.specUrl}` : ''}`),
];
