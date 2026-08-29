import { describe, expect, it } from 'vitest';
import { isValidRetryAfter, parseRetryAfterMs } from '../src/http/resilience/retry-after.js';

describe('isValidRetryAfter', () => {
  it('accepts non-negative integer delay-seconds', () => {
    expect(isValidRetryAfter('120')).toBe(true);
    expect(isValidRetryAfter('0')).toBe(true);
    expect(isValidRetryAfter('  120  ')).toBe(true);
  });

  it('accepts an HTTP-date', () => {
    expect(isValidRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(true);
  });

  it('rejects empty or whitespace-only values', () => {
    expect(isValidRetryAfter('')).toBe(false);
    expect(isValidRetryAfter('   ')).toBe(false);
  });

  it('rejects numeric values that are not non-negative integers', () => {
    expect(isValidRetryAfter('-5')).toBe(false);
    expect(isValidRetryAfter('3.5')).toBe(false);
    expect(isValidRetryAfter('+2')).toBe(false);
  });

  it('rejects non-numeric, non-date garbage', () => {
    expect(isValidRetryAfter('soon')).toBe(false);
    expect(isValidRetryAfter('tomorrow')).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('converts delay-seconds to milliseconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });

  it('returns the interval until a future HTTP-date (injected now)', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:29:00 GMT', now)).toBe(60_000);
  });

  it('clamps a past HTTP-date to zero', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
  });
});
