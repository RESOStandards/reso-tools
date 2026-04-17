/**
 * Isolated XSD validator — thin wrapper around libxml2-wasm.
 *
 * Uses WebAssembly-compiled libxml2 for XSD validation.
 * No native binaries — works identically in Node.js and Electron.
 */

import { XsdValidator, XmlDocument, XmlBufferInputProvider, xmlRegisterInputProvider, xmlCleanupInputProvider } from 'libxml2-wasm';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XSD_ROOT = join(__dirname, '..', 'xsd');

/** Registers an input provider so libxml2 can resolve the edm.xsd import from the edmx.xsd schema. */
const registerEdmProvider = (version) => {
  const versionDir = version === '4.0' ? 'odata-4.0' : 'odata-4.01';
  const edmXsd = readFileSync(resolve(XSD_ROOT, versionDir, 'edm.xsd'));
  const provider = new XmlBufferInputProvider({ 'edm.xsd': edmXsd });
  xmlRegisterInputProvider(provider);
};

/** Loads and prepares the EDMX XSD schema for a given OData version. */
const loadEdmxValidator = (version) => {
  const versionDir = version === '4.0' ? 'odata-4.0' : 'odata-4.01';
  const edmxXsd = readFileSync(resolve(XSD_ROOT, versionDir, 'edmx.xsd'), 'utf-8').replace(
    '<xs:import namespace="http://docs.oasis-open.org/odata/ns/edm" />',
    '<xs:import namespace="http://docs.oasis-open.org/odata/ns/edm" schemaLocation="edm.xsd" />',
  );
  registerEdmProvider(version);
  const xsdDoc = XmlDocument.fromString(edmxXsd);
  const validator = XsdValidator.fromDoc(xsdDoc);
  xsdDoc.dispose();
  xmlCleanupInputProvider();
  return validator;
};

/** Cached validators, keyed by OData version. */
const validatorCache = new Map();

const getValidator = (version) => {
  const cached = validatorCache.get(version);
  if (cached) return cached;
  const validator = loadEdmxValidator(version);
  validatorCache.set(version, validator);
  return validator;
};

/**
 * Validate a CSDL XML string against the OASIS OData XSD schemas.
 *
 * @param {string} csdlXml - The raw CSDL XML metadata string.
 * @param {string} version - OData version ('4.0' or '4.01').
 * @returns {{ valid: boolean, errors: Array<{ message: string, line: number | null, column: number | null }> }}
 */
export const validateAgainstSchema = (csdlXml, version) => {
  const validator = getValidator(version);
  const doc = XmlDocument.fromString(csdlXml);
  try {
    validator.validate(doc);
    return { valid: true, errors: [] };
  } catch (e) {
    // libxml2-wasm throws on validation failure with the error details in the message
    const message = e.message ?? String(e);
    // Parse individual errors from the multi-line message
    const errors = message.split('\n').filter(Boolean).map(line => ({
      message: line.trim(),
      line: null,
      column: null,
    }));
    return { valid: false, errors };
  } finally {
    doc.dispose();
  }
};

/**
 * Parse an XML string into a document (for direct use if needed).
 * @param {string} xml
 * @returns {import('libxml2-wasm').XmlDocument}
 */
export const parseXml = (xml) => XmlDocument.fromString(xml);
