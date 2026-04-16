/**
 * XSD validation for OData CSDL XML metadata.
 *
 * Validates XML metadata documents against the official OASIS OData
 * EDM + EDMX XML schemas. Supports both OData 4.0 and 4.01.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as libxmljs from 'libxmljs2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XSD_ROOT = join(__dirname, '..', '..', 'xsd');

/** Supported OData versions for XSD validation. */
export type ODataVersion = '4.0' | '4.01';

/** Result of an XSD validation run. */
export interface XsdValidationResult {
  readonly valid: boolean;
  readonly odataVersion: ODataVersion;
  readonly errors: ReadonlyArray<XsdValidationError>;
}

/** A single XSD validation error. */
export interface XsdValidationError {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * Detects the OData version from a CSDL XML string.
 * Looks for the Version attribute on the root edmx:Edmx element.
 * Returns undefined if it cannot be determined.
 */
export const detectODataVersion = (csdlXml: string): ODataVersion | undefined => {
  const match = csdlXml.match(/Version\s*=\s*["'](\d+\.\d+)["']/);
  if (!match) return undefined;
  if (match[1] === '4.0') return '4.0';
  if (match[1] === '4.01') return '4.01';
  return undefined;
};

/**
 * Loads and prepares the EDMX XSD schema for a given OData version.
 * Adds a schemaLocation hint to the EDM import so libxmljs2 can
 * resolve the cross-schema reference.
 */
const loadEdmxSchema = (version: ODataVersion): libxmljs.Document => {
  const versionDir = version === '4.0' ? 'odata-4.0' : 'odata-4.01';
  const xsdPath = join(XSD_ROOT, versionDir, 'edmx.xsd');
  const edmxXsd = readFileSync(xsdPath, 'utf-8').replace(
    '<xs:import namespace="http://docs.oasis-open.org/odata/ns/edm" />',
    '<xs:import namespace="http://docs.oasis-open.org/odata/ns/edm" schemaLocation="edm.xsd" />',
  );
  return libxmljs.parseXml(edmxXsd, { baseUrl: join(XSD_ROOT, versionDir) + '/', huge: true, noent: true });
};

/** Cached parsed XSD documents, keyed by OData version. */
const schemaCache = new Map<ODataVersion, libxmljs.Document>();

const getSchema = (version: ODataVersion): libxmljs.Document => {
  const cached = schemaCache.get(version);
  if (cached) return cached;
  const schema = loadEdmxSchema(version);
  schemaCache.set(version, schema);
  return schema;
};

/**
 * Validates a CSDL XML string against the OASIS OData XSD schemas.
 *
 * If no OData version is provided, the version is detected from the
 * document's Version attribute.
 *
 * @param csdlXml - The raw CSDL XML metadata string.
 * @param version - Optional OData version override.
 * @returns Validation result with errors if any.
 */
export const validateCsdlXml = (csdlXml: string, version?: ODataVersion): XsdValidationResult => {
  const odataVersion = version ?? detectODataVersion(csdlXml);
  if (!odataVersion) {
    return {
      valid: false,
      odataVersion: '4.0',
      errors: [{ message: 'Cannot determine OData version from CSDL document. Expected Version="4.0" or "4.01" on the root Edmx element.', line: null, column: null }],
    };
  }

  const xmlDoc = libxmljs.parseXml(csdlXml, { huge: true, noent: true });
  const xsdDoc = getSchema(odataVersion);
  const valid = xmlDoc.validate(xsdDoc);

  const errors: ReadonlyArray<XsdValidationError> = valid
    ? []
    : xmlDoc.validationErrors.map(e => ({
        message: e.message.trim(),
        line: e.line ?? null,
        column: e.column ?? null,
      }));

  return { valid, odataVersion, errors };
};
