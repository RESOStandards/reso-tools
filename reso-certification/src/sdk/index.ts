export type {
  StepStatus,
  StepProgress,
  ProgressCallback,
  PipelineContext,
  PipelineStep,
  StepOutput,
  PipelineOptions,
  StepResult,
  PipelineResult,
  BaseComplianceConfig,
  DDConfig,
  AddEditConfig,
  EntityEventConfig,
  CoreConfig,
  ComplianceConfig,
} from './types.js';

export { createPipeline } from './pipeline.js';
export { runAddEditCompliance, createAddEditPipeline } from './add-edit.js';
export { runEntityEventCompliance, createEntityEventPipeline } from './entity-event.js';
export {
  writeReports,
  addEditReportGenerators,
  entityEventReportGenerators,
  coreReportGenerators,
  createGenericReportGenerator,
  createDetailedReportGenerator,
} from './reports.js';

import type { ComplianceConfig, PipelineResult, ProgressCallback } from './types.js';
import { runAddEditCompliance } from './add-edit.js';
import { runEntityEventCompliance } from './entity-event.js';

/** Run compliance tests for any endorsement. Dispatches to the appropriate pipeline. */
export const runComplianceTests = async (
  config: ComplianceConfig,
  onProgress?: ProgressCallback,
): Promise<PipelineResult> => {
  switch (config.endorsement) {
    case 'add-edit':
      return runAddEditCompliance(config, onProgress);
    case 'entity-event':
      return runEntityEventCompliance(config, onProgress);
    case 'dd':
      throw new Error('DD compliance testing not yet implemented in the SDK pipeline');
    case 'core':
      throw new Error('Web API Core compliance testing not yet implemented in the SDK pipeline');
  }
};
