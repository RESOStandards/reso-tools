/**
 * XSD validation for OData CSDL XML metadata.
 *
 * Validates XML metadata documents against the official OASIS OData
 * EDM + EDMX XML schemas. Supports both OData 4.0 and 4.01.
 *
 * Uses the isolated xsd-validator package (libxml2-wasm) which is
 * pure WASM — no native binaries, works identically in Node.js and Electron.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// Lazy-loaded isolated validator
// ---------------------------------------------------------------------------

type ValidateResult = {
  valid: boolean;
  errors: ReadonlyArray<{ message: string; line: number | null; column: number | null }>;
};

type XsdValidatorModule = {
  validateAgainstSchema: (csdlXml: string, version: string) => ValidateResult;
};

let validatorModule: XsdValidatorModule | null = null;

const getValidator = async (): Promise<XsdValidatorModule> => {
  if (validatorModule) return validatorModule;
  const validatorPath = join(__dirname, '..', '..', 'xsd-validator', 'index.js');
  validatorModule = await import(validatorPath) as XsdValidatorModule;
  return validatorModule;
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
export const validateCsdlXml = async (csdlXml: string, version?: ODataVersion): Promise<XsdValidationResult> => {
  const odataVersion = version ?? detectODataVersion(csdlXml);
  if (!odataVersion) {
    return {
      valid: false,
      odataVersion: '4.0',
      errors: [{ message: 'Cannot determine OData version from CSDL document. Expected Version="4.0" or "4.01" on the root Edmx element.', line: null, column: null }],
    };
  }

  const validator = await getValidator();
  const { valid, errors } = validator.validateAgainstSchema(csdlXml, odataVersion);

  return { valid, odataVersion, errors };
};
