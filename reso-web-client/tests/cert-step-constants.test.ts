import { describe, it, expect } from 'vitest';
import {
  isVariationsStep,
  STEP_RESOLVE_AUTH,
  STEP_SERVICE_CHECK,
  STEP_GENERATE_METADATA,
  STEP_FETCH_METADATA,
  STEP_CHECK_VARIATIONS,
  STEP_REPLICATE_AND_VALIDATE,
  STEP_WRITE_REPORTS,
  DD_STEPS,
  CORE_STEPS,
  ADD_EDIT_STEPS,
  ENTITY_EVENT_STEPS,
} from '../src/constants/cert';

describe('isVariationsStep', () => {
  it('matches the canonical Check variations step name', () => {
    expect(isVariationsStep({ name: STEP_CHECK_VARIATIONS })).toBe(true);
    expect(isVariationsStep({ name: 'Check variations' })).toBe(true);
  });

  it('does not match arbitrary substrings containing "variation"', () => {
    // The fragile predecessor (s.name.toLowerCase().includes('variation'))
    // would match these. Direct equality should not.
    expect(isVariationsStep({ name: 'Check variations report' })).toBe(false);
    expect(isVariationsStep({ name: 'configuration step' })).toBe(false);
    expect(isVariationsStep({ name: 'Variations' })).toBe(false);
    expect(isVariationsStep({ name: 'check variations' })).toBe(false); // case-sensitive
  });

  it('does not match unrelated step names', () => {
    expect(isVariationsStep({ name: STEP_GENERATE_METADATA })).toBe(false);
    expect(isVariationsStep({ name: STEP_REPLICATE_AND_VALIDATE })).toBe(false);
    expect(isVariationsStep({ name: STEP_WRITE_REPORTS })).toBe(false);
  });
});

describe('pipeline step arrays', () => {
  it('DD pipeline steps are in canonical order', () => {
    expect(DD_STEPS).toEqual([
      STEP_RESOLVE_AUTH,
      STEP_SERVICE_CHECK,
      STEP_GENERATE_METADATA,
      STEP_CHECK_VARIATIONS,
      STEP_REPLICATE_AND_VALIDATE,
      STEP_WRITE_REPORTS,
    ]);
  });

  it('Core pipeline includes Fetch metadata, not Generate metadata', () => {
    expect(CORE_STEPS).toContain(STEP_FETCH_METADATA);
    expect(CORE_STEPS).not.toContain(STEP_GENERATE_METADATA);
  });

  it('every pipeline ends with Write reports', () => {
    for (const arr of [DD_STEPS, CORE_STEPS, ADD_EDIT_STEPS, ENTITY_EVENT_STEPS]) {
      expect(arr[arr.length - 1]).toBe(STEP_WRITE_REPORTS);
    }
  });

  it('only DD checks variations', () => {
    expect(DD_STEPS).toContain(STEP_CHECK_VARIATIONS);
    expect(CORE_STEPS).not.toContain(STEP_CHECK_VARIATIONS);
    expect(ADD_EDIT_STEPS).not.toContain(STEP_CHECK_VARIATIONS);
    expect(ENTITY_EVENT_STEPS).not.toContain(STEP_CHECK_VARIATIONS);
  });
});
