/**
 * @reso-standards/reso-metadata-utils — RESO OData metadata processing utilities.
 *
 * The Node-side processing layer: CSDL parse + validate (CSDL/XSD), serialize (EDMX → report),
 * and metadata fetching. Sits above reso-common (the pure model + EDMX generation). Symbols
 * migrate in here from reso-client and reso-certification per reso-tools #221 — the split is
 * by dependency: this is the deps-requiring side; reso-common stays the zero-dep substrate.
 */

// CSDL parser, validator, and types — moved from reso-client/csdl (reso-tools #221, Stage 1).
export {
  parseCsdlXml,
  discoverResources,
  getEntityType,
  getEnumType,
  getComplexType,
  getFieldsForResource,
  getFieldsForEntityType,
  getAllFields
} from './csdl/parser.js';
export { validateCsdl } from './csdl/validator.js';
export type {
  CsdlSchema,
  CsdlEntityType,
  CsdlProperty,
  CsdlNavigationProperty,
  CsdlReferentialConstraint,
  CsdlComplexType,
  CsdlEnumType,
  CsdlEnumMember,
  CsdlEntityContainer,
  CsdlEntitySet,
  CsdlNavigationPropertyBinding,
  CsdlSingleton,
  CsdlActionImport,
  CsdlFunctionImport,
  CsdlParameter,
  CsdlReturnType,
  CsdlAction,
  CsdlFunction,
  CsdlValidationError,
  CsdlResourceInfo,
  CsdlValidationResult,
  FieldAnnotation,
  FieldInfo
} from './csdl/types.js';
