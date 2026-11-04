/**
 * The checks an Add/Edit run makes before it writes anything, kept apart from the pipeline so that a service that
 * starts runs for others can make them without loading the rest of the package. Pure: no network and no files.
 */

import type { AddEditConfig } from '../sdk/types.js';
import { type AddEditPayloadName, type AddEditTestPlan, PAYLOAD_FILES, payloadsFor, planAddEditTests } from './plan.js';

/** The provider's payloads, by name. */
export type Payloads = Readonly<Partial<Record<AddEditPayloadName, Record<string, unknown>>>>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const named = (value: unknown): boolean => value !== undefined && value !== null && String(value) !== '';

/**
 * What stops the provider's payloads from running as given: one the plan needs and is missing or is not a record,
 * or an update or a delete that names no record when no create test runs to make one.
 */
export const providedPayloadProblems = (plan: AddEditTestPlan, payloads: Payloads, keyField: string | undefined): ReadonlyArray<string> => {
  const needed = payloadsFor(plan);
  const missing = needed.filter(name => !isRecord(payloads[name]));
  if (missing.length > 0) {
    return [`Each action tested needs its succeeds and its fails payload. Missing: ${missing.map(name => PAYLOAD_FILES[name]).join(', ')}`];
  }
  const creates = plan.actions.includes('create');
  const unnamedUpdates =
    creates || keyField === undefined
      ? []
      : (['updateSucceeds', 'updateFails'] as const).filter(name => needed.includes(name) && !named(payloads[name]?.[keyField]));
  const deleteSucceeds = payloads.deleteSucceeds;
  const deleteFails = payloads.deleteFails;
  return [
    ...unnamedUpdates.map(name => `${PAYLOAD_FILES[name]} names no ${keyField}, and no create test runs to make a record it could update`),
    ...(needed.includes('deleteSucceeds') && !creates && !named(deleteSucceeds?.url) && !named(deleteSucceeds?.id)
      ? ['delete-succeeds.json names no id or url, and no create test runs to make a record it could delete']
      : []),
    ...(needed.includes('deleteFails') && !named(deleteFails?.url) && !named(deleteFails?.id)
      ? ['delete-fails.json names no id or url. It needs a record that does not exist.']
      : [])
  ];
};

/** Why the payloads cannot be had: given none, or given more than one way. */
export const payloadSourceProblems = (config: Pick<AddEditConfig, 'payloads' | 'payloadsDir' | 'autoPayloads'>): ReadonlyArray<string> => {
  const sources = [
    config.payloadsDir ? 'a payloads folder' : '',
    config.payloads ? 'payloads in the configuration' : '',
    config.autoPayloads ? 'auto payloads' : ''
  ].filter(Boolean);
  if (sources.length > 1) return [`Give the payloads one way, not ${sources.join(' and ')}`];
  if (sources.length === 0) {
    return [
      'Add/Edit needs the payloads to test with: a payloads folder, or payloads in the configuration. Auto payloads are for the reference server and the mock.'
    ];
  }
  return [];
};

/**
 * Why a run of these actions, formats and payloads would be refused before it writes anything, as far as can be told
 * without the server; empty when nothing stops it. The run checks the same things first. A server's key field comes
 * from its metadata, so an update that names no record is checked when the run starts, and a payloads folder is read
 * then. A service that starts runs for others, such as RESO's cloud, refuses with this what the run would refuse.
 */
export const addEditRunProblems = (
  config: Pick<AddEditConfig, 'actions' | 'formats' | 'payloads' | 'payloadsDir' | 'autoPayloads'>
): ReadonlyArray<string> => {
  const planned = planAddEditTests({ actions: config.actions, formats: config.formats });
  if ('problems' in planned) return planned.problems;
  const sourceProblems = payloadSourceProblems(config);
  if (sourceProblems.length > 0) return sourceProblems;
  return config.payloads ? providedPayloadProblems(planned.plan, config.payloads, undefined) : [];
};
