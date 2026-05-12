/**
 * Web-client glue for variations → CSV export. Maps the UI's
 * BlendedVariation/action model onto the canonical CSV row shape
 * defined in `@reso-standards/reso-client`, then triggers a browser
 * download. The serialization itself lives in the SDK so the cert
 * tool can produce identical CSVs.
 */

import { variationsToCsv, buildVariationKey, type VariationCsvRow } from '@reso-standards/reso-client';
import type { BlendedVariation } from './variations-blender.js';

type ActionStatus = 'pending' | 'ignored' | 'fast-track' | 'remove';

const ACTION_TO_OUTCOME: Readonly<Record<ActionStatus, string>> = {
  'fast-track': 'Fast Track',
  'ignored': 'Ignore',
  'remove': 'Remove',
  'pending': '',
};

const keyOf = (v: BlendedVariation): string =>
  buildVariationKey(v.resourceName, v.fieldName, v.lookupValue);

const toRow = (
  v: BlendedVariation,
  actions: ReadonlyMap<string, ActionStatus>
): VariationCsvRow => {
  const primary = v.suggestions[0];
  const action = actions.get(keyOf(v));
  return {
    resourceName: v.resourceName,
    fieldName: v.fieldName,
    lookupValue: v.lookupValue,
    suggestedResourceName: primary?.suggestedResourceName,
    suggestedFieldName: primary?.suggestedFieldName,
    suggestedLookupValue: primary?.suggestedLookupValue,
    suggestedRelatedResourceName: primary?.suggestedRelatedResourceName,
    suggestedRelatedFieldName: primary?.suggestedRelatedFieldName,
    suggestedRelatedLookupValue: primary?.suggestedRelatedLookupValue,
    outcome: action ? ACTION_TO_OUTCOME[action] : '',
  };
};

export const downloadVariationsCsv = (
  filename: string,
  variations: ReadonlyArray<BlendedVariation>,
  actions: ReadonlyMap<string, ActionStatus>
): void => {
  const csv = variationsToCsv(variations.map(v => toRow(v, actions)));
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
