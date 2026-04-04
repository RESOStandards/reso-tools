import { describe, it, expect } from 'vitest';
import { humanizeError } from '../src/hooks/use-collection';

describe('humanizeError', () => {
  it('shows rate limiting message for 429', () => {
    const result = humanizeError('Too many requests', 429);
    expect(result).toContain('exceeded the maximum number of requests');
    expect(result).toContain('Too many requests');
  });

  it('attributes 5xx errors to the remote server', () => {
    const result = humanizeError('Internal Server Error', 500);
    expect(result).toContain('problem with the server, not the client');
    expect(result).toContain('500');
  });

  it('shows server response for other HTTP errors', () => {
    const result = humanizeError('Not Found', 404);
    expect(result).toContain('remote server returned an error (404)');
    expect(result).toContain('Not Found');
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

  it('prefixes unknown errors with Server response', () => {
    const result = humanizeError('Something went wrong');
    expect(result).toContain('Server response:');
    expect(result).toContain('Something went wrong');
  });

  it('handles 502 gateway errors', () => {
    const result = humanizeError('Bad Gateway', 502);
    expect(result).toContain('problem with the server');
  });

  it('handles 503 service unavailable', () => {
    const result = humanizeError('Service Unavailable', 503);
    expect(result).toContain('problem with the server');
  });
});
