/**
 * Normalizing a RESO service address.
 *
 * Two problems, one function. A legacy configuration carries a bare host – `services.reso.org`
 * rather than `https://services.reso.org` – and a bare host concatenated into a request path makes a
 * relative URL that fails at `fetch` naming neither the variable nor the value. And an address
 * written as `http://` sends a bearer token, or mints one from a client secret, in the clear.
 *
 * The decision worth pinning is that plain HTTP is UPGRADED rather than refused. Refusing fails a run
 * over something nobody can have intended, and upgrading fixes it.
 *
 * The exception is loopback, where HTTP is the real local setup. Upgrading there protects nothing,
 * because the traffic never leaves the machine, and costs something real, because the only way to
 * satisfy it is to generate and trust a local certificate. The exemption is matched by exact
 * hostname so that a lookalike host is still upgraded, which is the case worth testing.
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

describe('loopback keeps plain http', () => {
  // Named for the failure each would allow: every one of these is an address a developer runs a
  // local RESO service on, and upgrading it makes the run fail with a connection error that names
  // neither the rewrite nor the variable.
  it('leaves localhost alone, so a local service does not need a certificate', () => {
    expect(ensureHttps('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('leaves 127.0.0.1 alone', () => {
    expect(ensureHttps('http://127.0.0.1:8080/oauth/token')).toBe('http://127.0.0.1:8080/oauth/token');
  });

  it('covers the whole 127.0.0.0/8 block, not only 127.0.0.1', () => {
    expect(ensureHttps('http://127.0.0.2:8080')).toBe('http://127.0.0.2:8080');
    expect(ensureHttps('http://127.1.2.3:8080')).toBe('http://127.1.2.3:8080');
  });

  it('leaves the IPv6 loopback alone, brackets and all', () => {
    expect(ensureHttps('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('matches regardless of case, since URL lowercases the hostname', () => {
    expect(ensureHttps('http://LOCALHOST:8080')).toBe('http://localhost:8080');
  });

  it('still upgrades https-on-loopback to nothing, leaving it as given', () => {
    expect(ensureHttps('https://localhost:8080')).toBe('https://localhost:8080');
  });
});

describe('the exemption is exact-match, so a lookalike host is still upgraded', () => {
  // This is the control. A suffix or substring test would read these as loopback and send a
  // credential in the clear to someone else's server.
  it('upgrades a host that merely ends in localhost', () => {
    expect(ensureHttps('http://localhost.evil.com/token')).toBe('https://localhost.evil.com/token');
  });

  it('upgrades a host that merely starts with a loopback address', () => {
    expect(ensureHttps('http://127.0.0.1.evil.com/token')).toBe('https://127.0.0.1.evil.com/token');
  });

  it('upgrades a host that merely contains localhost', () => {
    expect(ensureHttps('http://not-localhost-really.com')).toBe('https://not-localhost-really.com');
  });

  it('upgrades a host that ENDS in localhost, which a suffix test would let through', () => {
    // The load-bearing case against `hostname.endsWith('localhost')`. A host ending in the
    // allowlisted name is the shape an attacker registers, and the other lookalikes above do not
    // catch that mutation because they end in their own domain instead.
    expect(ensureHttps('http://evil-localhost/token')).toBe('https://evil-localhost/token');
    expect(ensureHttps('http://attacker.example.localhost/token')).toBe('https://attacker.example.localhost/token');
  });

  it('upgrades host.docker.internal, which resolves off the container', () => {
    // Deliberately not exempt. Docker can reach a loopback address directly, so the exemption
    // stays with addresses that are loopback by definition.
    expect(ensureHttps('http://host.docker.internal:8080/oauth/token')).toBe('https://host.docker.internal:8080/oauth/token');
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
