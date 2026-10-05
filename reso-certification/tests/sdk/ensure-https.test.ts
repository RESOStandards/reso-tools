/**
 * Normalizing a RESO service address.
 *
 * Two problems, one function. A legacy configuration carries a bare host – `services.reso.org`
 * rather than `https://services.reso.org` – and a bare host concatenated into a request path makes a
 * relative URL that fails at `fetch` naming neither the variable nor the value. And an address
 * written as `http://` sends a bearer token, or mints one from a client secret, in the clear.
 *
 * The decision worth pinning is that plain HTTP is UPGRADED rather than refused. Refusing fails a run
 * over something nobody can have intended; upgrading fixes it. The exception is loopback, where HTTP
 * is a real local setup and the service's own token map has a `local` environment.
 */

import { describe, expect, it } from 'vitest';
import { ensureHttps } from '../../src/sdk/common.js';

describe('a missing scheme becomes https', () => {
  it('turns a bare host into an https URL', () => {
    expect(ensureHttps('services.reso.org')).toBe('https://services.reso.org');
  });

  it('handles a bare host with a path', () => {
    expect(ensureHttps('services.reso.org/v2')).toBe('https://services.reso.org/v2');
  });

  it('handles a protocol-relative address', () => {
    expect(ensureHttps('//services.reso.org')).toBe('https://services.reso.org');
  });

  it('does not read a port as a scheme', () => {
    // `new URL('localhost:8080')` parses `localhost:` AS THE SCHEME, which would hide the missing
    // scheme completely. The check is a pattern for `name://`, not a parse.
    expect(ensureHttps('localhost:8080')).toBe('https://localhost:8080');
  });

  it('trims surrounding whitespace', () => {
    expect(ensureHttps('  services.reso.org  ')).toBe('https://services.reso.org');
  });
});

describe('plain HTTP is upgraded, not refused', () => {
  it('upgrades an explicit http address', () => {
    expect(ensureHttps('http://services.reso.org')).toBe('https://services.reso.org');
  });

  it('upgrades while keeping the path and port', () => {
    expect(ensureHttps('http://services.reso.org:8443/v2')).toBe('https://services.reso.org:8443/v2');
  });

  it('leaves an https address alone', () => {
    expect(ensureHttps('https://services.reso.org')).toBe('https://services.reso.org');
  });
});

describe('there is no loopback exemption', () => {
  it('upgrades http on localhost too', () => {
    // These variables name RESO services, never a local one. A local reference server is a PROVIDER
    // address, which travels on --url and is validated separately -- so an exemption here would be a
    // hole on a credential endpoint and would protect nothing real.
    expect(ensureHttps('http://localhost:8080')).toBe('https://localhost:8080');
  });
});

describe('a trailing slash is dropped', () => {
  it('drops one, since callers append a rooted path', () => {
    // Left on, `${url}/v2/...` produces a double slash.
    expect(ensureHttps('https://services.reso.org/')).toBe('https://services.reso.org');
  });

  it('drops several', () => {
    expect(ensureHttps('services.reso.org///')).toBe('https://services.reso.org');
  });
});

describe('what it refuses', () => {
  it('refuses an empty value, naming the variable', () => {
    expect(() => ensureHttps('   ', 'RESO_SERVICES_URL')).toThrow(/RESO_SERVICES_URL is empty/);
  });

  it('refuses a non-http scheme and says which one', () => {
    expect(() => ensureHttps('ftp://services.reso.org', 'TOKEN_URI')).toThrow(/ftp scheme/);
  });

  it('names the variable and the value it was given', () => {
    expect(() => ensureHttps('ftp://x.example', 'TOKEN_URI')).toThrow(/TOKEN_URI "ftp:\/\/x\.example"/);
  });
});
