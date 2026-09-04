/**
 * Canonical pipeline step names — the single identity shared by the pipeline that emits a step
 * (its `StepResult.name` / `StepProgress.step`) and by the report serializers that locate a step by
 * name. These strings are also persisted in `report.json` / `report-detailed.json` as `steps[].name`,
 * so they are an external contract — tests assert the literal value rather than importing the const,
 * to catch a silent rename that would break report consumers.
 */
export const FETCH_METADATA = 'Fetch metadata';
export const RUN_CORE_SCENARIOS = 'Run Core scenarios';
export const RUN_ADD_EDIT_SCENARIOS = 'Run Add/Edit scenarios';
export const RUN_ENTITY_EVENT_SCENARIOS = 'Run EntityEvent scenarios';
