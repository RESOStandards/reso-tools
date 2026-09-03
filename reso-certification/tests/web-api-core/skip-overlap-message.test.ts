import { describe, expect, it } from 'vitest';
import { describeSkipOverlap } from '../../src/web-api-core/test-runner.js';

// The $skip "unique pages" failure message must carry its spec grounding (cert_errors_cite_sources): absent
// $orderby, OData requires a stable ordering across requests for $top/$skip, so consecutive pages are disjoint.

describe('describeSkipOverlap — grounded $skip failure message', () => {
  it('states the overlap and pluralizes correctly', () => {
    expect(describeSkipOverlap(1)).toContain('1 key appears in both pages');
    expect(describeSkipOverlap(3)).toContain('3 keys appear in both pages');
  });

  it('cites the OData sections that ground the unique-pages requirement (4.0 and 4.01)', () => {
    const m = describeSkipOverlap(2);
    expect(m).toContain('§11.2.5.4'); // OData 4.0 $skip
    expect(m).toContain('§11.2.5.3'); // OData 4.0 $top
    expect(m).toContain('4.01 §11.2.6.3'); // OData 4.01
    expect(m).toMatch(/stable ordering across requests/);
  });

  it('includes the churn caveat and the authoritative link', () => {
    const m = describeSkipOverlap(1);
    expect(m).toContain('not required to guarantee consistent results between requests');
    expect(m).toContain('https://docs.oasis-open.org/odata/odata/v4.0/errata03/');
  });
});
