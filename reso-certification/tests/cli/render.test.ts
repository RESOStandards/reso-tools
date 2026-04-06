import { describe, it, expect } from 'vitest';
import { resolveRenderMode } from '../../src/cli/render.js';

describe('resolveRenderMode', () => {
  it('returns silent for --output json', () => {
    expect(resolveRenderMode({ output: 'json' })).toBe('silent');
  });

  it('returns verbose for --verbose', () => {
    expect(resolveRenderMode({ verbose: true })).toBe('verbose');
  });

  it('returns default when no flags', () => {
    expect(resolveRenderMode({})).toBe('default');
  });

  it('returns default for --output console', () => {
    expect(resolveRenderMode({ output: 'console' })).toBe('default');
  });

  it('json takes precedence over verbose', () => {
    expect(resolveRenderMode({ verbose: true, output: 'json' })).toBe('silent');
  });
});
