import { describe, it, expect } from 'vitest';
import { formatError } from '../src/utils/error-messages';

describe('formatError', () => {
  it('detects 429 status code and provides rate limit explanation', () => {
    const result = formatError('Failed to fetch $metadata: 429');
    expect(result.title).toBe('Too Many Requests');
    expect(result.description).toContain('rate limit');
    expect(result.statusCode).toBe(429);
  });

  it('detects 401 and explains authentication', () => {
    const result = formatError('Failed to fetch $metadata: 401 Unauthorized');
    expect(result.title).toBe('Not Authorized');
    expect(result.description).toContain('authentication');
    expect(result.statusCode).toBe(401);
  });

  it('detects 500 and attributes to server', () => {
    const result = formatError('Internal Server Error: 500');
    expect(result.title).toBe('Server Error');
    expect(result.description).toContain('data provider');
    expect(result.statusCode).toBe(500);
  });

  it('detects 403 and explains permissions', () => {
    const result = formatError('Forbidden: 403');
    expect(result.title).toBe('Access Denied');
    expect(result.description).toContain('permission');
  });

  it('handles network errors', () => {
    const result = formatError('Failed to fetch');
    expect(result.title).toBe('Connection Error');
    expect(result.description).toContain('connect');
  });

  it('handles timeout errors', () => {
    const result = formatError('Request timeout');
    expect(result.title).toBe('Request Timeout');
  });

  it('handles unknown errors gracefully', () => {
    const result = formatError('Something unexpected happened');
    expect(result.title).toBe('Something Went Wrong');
    expect(result.description).toBe('Something unexpected happened');
  });

  it('preserves server response as separate field', () => {
    const result = formatError('Failed to fetch $metadata: 429', 'The request exceeds our performance threshold.');
    expect(result.serverMessage).toBe('The request exceeds our performance threshold.');
  });

  it('detects status code anywhere in the message', () => {
    const result = formatError('The server returned status 503 for this request');
    expect(result.statusCode).toBe(503);
    expect(result.title).toBe('Service Unavailable');
  });
});
