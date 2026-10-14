import { describe, expect, it } from 'vitest';
import { sanitizeBearerToken } from '../src/http/auth.js';

describe('sanitizeBearerToken', () => {
  it('returns a clean token unchanged', () => {
    expect(sanitizeBearerToken('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeBearerToken('  abc123  ')).toBe('abc123');
    expect(sanitizeBearerToken('\nabc123\t')).toBe('abc123');
  });

  it('strips wrapping straight double quotes', () => {
    expect(sanitizeBearerToken('"abc123"')).toBe('abc123');
  });

  it('strips wrapping straight single quotes', () => {
    expect(sanitizeBearerToken("'abc123'")).toBe('abc123');
  });

  it('strips wrapping curly double quotes (U+201C / U+201D — Word smart quote)', () => {
    expect(sanitizeBearerToken('“abc123”')).toBe('abc123');
  });

  it('strips wrapping curly single quotes (U+2018 / U+2019)', () => {
    expect(sanitizeBearerToken('‘abc123’')).toBe('abc123');
  });

  it('strips mixed wrapping quote types', () => {
    expect(sanitizeBearerToken('“abc123"')).toBe('abc123');
  });

  it('iteratively strips nested wrapping quotes', () => {
    expect(sanitizeBearerToken('"“abc123”"')).toBe('abc123');
  });

  it('does not strip interior quotes (loud failure preserved for corrupted tokens)', () => {
    expect(sanitizeBearerToken('abc“def')).toBe('abc“def');
  });

  it('does not strip a single leading quote without a matching trailing quote', () => {
    expect(sanitizeBearerToken('"abc')).toBe('"abc');
    expect(sanitizeBearerToken('abc"')).toBe('abc"');
  });

  it('handles empty and minimal inputs', () => {
    expect(sanitizeBearerToken('')).toBe('');
    expect(sanitizeBearerToken('""')).toBe('');
    expect(sanitizeBearerToken('"')).toBe('"');
  });
});
