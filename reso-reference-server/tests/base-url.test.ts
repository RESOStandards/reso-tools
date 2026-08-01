import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveBaseUrl } from '../src/odata/base-url.js';

/** Minimal Express Request stub: only the fields resolveBaseUrl reads (protocol, Host header, hostname). */
const req = (protocol: string, host: string | undefined, hostname = 'fallback-host'): Request =>
  ({ protocol, hostname, get: (h: string) => (h.toLowerCase() === 'host' ? host : undefined) }) as unknown as Request;

describe('resolveBaseUrl', () => {
  it('an explicit override always wins and ignores the request (the pin-a-canonical-URL / CDN case)', () => {
    expect(resolveBaseUrl(req('http', 'localhost:53810'), 'https://reference-server.reso.org')).toBe(
      'https://reference-server.reso.org',
    );
  });

  it('derives protocol + host from the request when there is no override (local / desktop)', () => {
    expect(resolveBaseUrl(req('http', 'localhost:53810'))).toBe('http://localhost:53810');
  });

  it('carries the PUBLISHED port from the Host header — the Docker `-p 3000:8080` case', () => {
    // Docker port-publishing is L4 NAT and does not touch the HTTP Host header, so the client's Host arrives
    // as the external `localhost:3000`, not the container's internal 8080.
    expect(resolveBaseUrl(req('http', 'localhost:3000'))).toBe('http://localhost:3000');
  });

  it('honors an X-Forwarded-derived https + FQDN (Host preserved by an ALB, protocol from trust proxy)', () => {
    expect(resolveBaseUrl(req('https', 'reference-server.reso.org'))).toBe('https://reference-server.reso.org');
  });

  it('falls back to req.hostname only when the Host header is absent', () => {
    expect(resolveBaseUrl(req('http', undefined, 'internal-host'))).toBe('http://internal-host');
  });
});
