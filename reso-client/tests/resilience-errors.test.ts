import { describe, expect, it } from 'vitest';
import { classifyResponse, classifyStatus, classifyThrown } from '../src/http/resilience/errors.js';

describe('classifyStatus', () => {
  it('classifies 429 as a retryable throttle', () => {
    const c = classifyStatus(429);
    expect(c.kind).toBe('throttle-429');
    expect(c.retryable).toBe(true);
    expect(c.fatal).toBe(false);
  });

  it('classifies 401 as fatal auth, never retryable (whole run is doomed)', () => {
    const c = classifyStatus(401);
    expect(c.kind).toBe('fatal-auth');
    expect(c.retryable).toBe(false);
    expect(c.fatal).toBe(true);
  });

  it('classifies 403 as terminal (unit-level), never retryable', () => {
    const c = classifyStatus(403);
    expect(c.kind).toBe('terminal-4xx');
    expect(c.retryable).toBe(false);
    expect(c.fatal).toBe(false);
  });

  it('classifies other 4xx as terminal', () => {
    for (const s of [400, 404, 405, 409, 422]) {
      expect(classifyStatus(s).kind).toBe('terminal-4xx');
      expect(classifyStatus(s).retryable).toBe(false);
    }
  });

  it('classifies 501 as terminal even though it is a 5xx', () => {
    expect(classifyStatus(501).kind).toBe('terminal-4xx');
    expect(classifyStatus(501).retryable).toBe(false);
  });

  it('classifies 500/502/503/504 as retryable transient', () => {
    for (const s of [500, 502, 503, 504]) {
      const c = classifyStatus(s);
      expect(c.kind).toBe('transient-5xx');
      expect(c.retryable).toBe(true);
      expect(c.fatal).toBe(false);
    }
  });
});

describe('classifyResponse', () => {
  it('returns null for a non-error status', () => {
    expect(classifyResponse({ status: 200 })).toBeNull();
    expect(classifyResponse({ status: 204 })).toBeNull();
  });

  it('classifies an error status', () => {
    expect(classifyResponse({ status: 503 })?.kind).toBe('transient-5xx');
    expect(classifyResponse({ status: 404 })?.kind).toBe('terminal-4xx');
  });
});

describe('classifyThrown', () => {
  it('classifies an AbortError as a retryable timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const c = classifyThrown(err);
    expect(c.kind).toBe('timeout');
    expect(c.retryable).toBe(true);
  });

  it('classifies a generic transport error as network and preserves err.code', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const c = classifyThrown(err);
    expect(c.kind).toBe('network');
    expect(c.retryable).toBe(true);
    expect(c.code).toBe('ECONNRESET');
    expect(c.message).toBe('socket hang up');
  });

  it('recovers a transport code nested under err.cause (undici shape)', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const c = classifyThrown(err);
    expect(c.kind).toBe('network');
    expect(c.code).toBe('ENOTFOUND');
  });

  it('recovers detail a {...err} spread would silently drop', () => {
    const err = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    // Documents the legacy bug: Error.message is non-enumerable, so the spread loses it.
    expect({ ...err }).toEqual({ code: 'ETIMEDOUT' });
    const c = classifyThrown(err);
    expect(c.message).toBe('boom');
    expect(c.code).toBe('ETIMEDOUT');
  });

  it('handles a thrown string', () => {
    const c = classifyThrown('nope');
    expect(c.kind).toBe('network');
    expect(c.message).toBe('nope');
  });
});
