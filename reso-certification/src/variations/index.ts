/**
 * Variations — DD variation detection for a metadata report.
 *
 * Public surface for the thin-client-over-backend variations check. See
 * `README.md` in this directory for the architecture (why the matcher moved
 * server-side) and the auth model.
 */

export {
  computeVariationsViaService,
  updateVariationsViaService,
  isVariationsAuthError,
  type ComputeVariationsViaServiceInput,
  type UpdateVariationsViaServiceInput,
  type UpdateVariationsResult,
  type VariationsServiceReport,
  type VariationsServiceErrorCode,
} from './service.js';

export { findVariations, type FindVariationsInput } from './find-variations.js';

export { parseVariationsCsv, type VariationSuggestionItem, type ParsedVariationsCsv } from './csv.js';

export { DEFAULT_DD_VERSION, DEFAULT_FUZZINESS, VARIATIONS_REPORT_FILENAME } from './constants.js';
