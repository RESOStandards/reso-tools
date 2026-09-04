import { describe, it, expect } from 'vitest';
import { createCoreProgressView } from '../../src/cli/render.js';
import type { CoreProgressDetail } from '../../src/sdk/types.js';

// Assertions check plain substrings — chalk may or may not add ANSI depending on the test TTY, but the
// underlying text (resource names, phase words, counts, URL) is present either way.
const d = (x: Partial<CoreProgressDetail>): CoreProgressDetail => ({ kind: 'core-progress', event: 'phase', ...x }) as CoreProgressDetail;

describe('createCoreProgressView', () => {
  it('renders nothing before init', () => {
    const v = createCoreProgressView();
    expect(v.hasData()).toBe(false);
    expect(v.render()).toBe('');
  });

  it('init seeds all resources as queued, preserving order', () => {
    const v = createCoreProgressView();
    v.apply(d({ event: 'init', resources: ['Property', 'Member', 'Office'] }));
    expect(v.hasData()).toBe(true);
    const out = v.render();
    expect(out).toContain('Property');
    expect(out).toContain('Member');
    expect(out).toContain('Office');
    expect(out).toContain('queued');
    expect(out.indexOf('Property')).toBeLessThan(out.indexOf('Member'));
    expect(out.indexOf('Member')).toBeLessThan(out.indexOf('Office'));
  });

  it('phase transitions update one resource: sampling → testing → done with a passed/total tally', () => {
    const v = createCoreProgressView();
    v.apply(d({ event: 'init', resources: ['Property'] }));
    v.apply(d({ resource: 'Property', phase: 'sampling' }));
    expect(v.render()).toContain('sampling');
    v.apply(d({ resource: 'Property', phase: 'testing' }));
    expect(v.render()).toContain('testing');
    v.apply(d({ resource: 'Property', phase: 'done', outcome: 'passed', counts: { passed: 45, failed: 0, skipped: 9 } }));
    const out = v.render();
    expect(out).toContain('45/54'); // passed / (passed+failed+skipped)
    expect(out).not.toContain('sampling');
    expect(out).not.toContain('testing');
  });

  it('a done resource with failures shows the failed count', () => {
    const v = createCoreProgressView();
    v.apply(d({ event: 'init', resources: ['Property'] }));
    v.apply(d({ resource: 'Property', phase: 'done', outcome: 'failed', counts: { passed: 40, failed: 5, skipped: 9 } }));
    const out = v.render();
    expect(out).toContain('40/54');
    expect(out).toContain('5 failed');
  });

  it('a request event surfaces the current URL; the resource finishing clears the stale line', () => {
    const v = createCoreProgressView();
    v.apply(d({ event: 'init', resources: ['Property'] }));
    v.apply(d({ event: 'request', url: 'https://api.example.com/Property?$top=1' }));
    expect(v.render()).toContain('https://api.example.com/Property?$top=1');
    v.apply(d({ resource: 'Property', phase: 'done', outcome: 'passed', counts: { passed: 1, failed: 0, skipped: 0 } }));
    expect(v.render()).not.toContain('https://api.example.com/Property?$top=1');
  });

  it('a masked resource (not-applicable / could-not-sample) shows its note, no counts', () => {
    const v = createCoreProgressView();
    v.apply(d({ event: 'init', resources: ['Media'] }));
    v.apply(d({ resource: 'Media', phase: 'done', outcome: 'not-applicable', note: 'not served (expansion-only)' }));
    expect(v.render()).toContain('not served');
  });

  it('a phase event for an unseen resource still registers it (no init race)', () => {
    const v = createCoreProgressView();
    v.apply(d({ resource: 'LateResource', phase: 'testing' }));
    expect(v.hasData()).toBe(true);
    expect(v.render()).toContain('LateResource');
  });
});
