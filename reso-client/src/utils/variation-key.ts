/**
 * Variation key — composite identifier for a single variation
 * `(resourceName, fieldName?, lookupValue?)`.
 *
 * Uses ASCII Unit Separator (U+001F) between subfields. The separator
 * never appears in real RESO data, so no escaping is needed for lookup
 * values that contain printable punctuation. Renders as a diamond
 * glyph in dev tools and the AWS console.
 *
 * Mirrored on the backend in
 * `reso-services-v2/src/variations-review/index.ts` — keep the
 * separator and shape in sync.
 */

export const VARIATION_KEY_SEP = '';

export const buildVariationKey = (
  resourceName: string,
  fieldName?: string,
  lookupValue?: string,
): string => {
  if (!resourceName || !resourceName.trim()) {
    throw new Error('buildVariationKey: resourceName is required');
  }
  if (lookupValue !== undefined && lookupValue !== '') {
    return `${resourceName}${VARIATION_KEY_SEP}${fieldName ?? ''}${VARIATION_KEY_SEP}${lookupValue}`;
  }
  if (fieldName !== undefined && fieldName !== '') {
    return `${resourceName}${VARIATION_KEY_SEP}${fieldName}`;
  }
  return resourceName;
};

export interface ParsedVariationKey {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
}

export const parseVariationKey = (key: string): ParsedVariationKey => {
  const parts = key.split(VARIATION_KEY_SEP);
  return {
    resourceName: parts[0],
    fieldName: parts[1] || undefined,
    lookupValue: parts[2] || undefined,
  };
};
