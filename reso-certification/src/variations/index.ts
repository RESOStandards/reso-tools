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
  type VariationsServiceErrorCode
} from './service.js';

export {
  listVariationReviewItemsViaService,
  listMyEndorsementsViaService,
  listEndorsementsByReviewStatusViaService,
  type ListVariationReviewItemsInput,
  type ListMyEndorsementsInput,
  type ListEndorsementsByReviewStatusInput,
  type EndorsementReviewStatus,
  type VariationReviewItem,
  type VariationReviewProvenance,
  type VariationReviewElementType,
  type EndorsementStatusRow
} from './review.js';
export { findVariations, type FindVariationsInput } from './find-variations.js';

export { parseVariationsCsv, type VariationSuggestionItem, type ParsedVariationsCsv } from './csv.js';
export { parseDecisionsCsv, type DecisionCsvItem, type ParsedDecisionsCsv } from './csv.js';

export {
  applySheetToReport,
  countEntries,
  SHEET_ACTIONS,
  type AppliedRow,
  type ApplySheetResult,
  type DecisionReport,
  type DecisionSheetRow,
  type ReportComment,
  type SheetAction
} from './decisions.js';

export {
  submitVariationsReportViaService,
  type SubmitVariationsReportInput,
  type SubmitVariationsReportResult
} from './submit.js';

export {
  DEFAULT_DD_VERSION,
  DEFAULT_FUZZINESS,
  VARIATIONS_REPORT_FILENAME,
  VARIATION_LEVEL_KEYS,
  countBucketedEntries,
  type LevelBuckets,
  type ReportEntry,
  type VariationLevelKey
} from './constants.js';
