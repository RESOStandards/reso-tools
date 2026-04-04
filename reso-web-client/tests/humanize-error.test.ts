import { describe, it, expect } from 'vitest';
import { humanizeError } from '../src/hooks/use-collection';

describe('humanizeError', () => {
  it('shows rate limiting message for 429', () => {
    const result = humanizeError('Too many requests', 429);
    expect(result).toContain('rate limit');
    expect(result).toContain('Too many requests');
  });

  it('attributes 5xx errors to the remote server', () => {
    const result = humanizeError('Internal Server Error', 500);
    expect(result).toContain('data provider');
    expect(result).toContain('Internal Server Error');
  });

  it('shows friendly description for 404', () => {
    const result = humanizeError('Not Found', 404);
    expect(result).toContain('not found');
  });

  it('matches unsupported query patterns', () => {
    const result = humanizeError('cannot find property FooBar');
    expect(result).toContain('does not recognize a property');
    expect(result).toContain('cannot find property FooBar');
  });

  it('matches syntax error pattern', () => {
    const result = humanizeError('syntax error in filter');
    expect(result).toContain('could not parse this query');
  });

  it('shows description for unknown errors', () => {
    const result = humanizeError('Something went wrong');
    expect(result).toContain('Something went wrong');
  });

  it('handles 502 gateway errors', () => {
    const result = humanizeError('Bad Gateway', 502);
    expect(result).toContain('invalid response');
  });

  it('handles 503 service unavailable', () => {
    const result = humanizeError('Service Unavailable', 503);
    expect(result).toContain('temporarily unavailable');
  });
});
