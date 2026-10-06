/**
 * Secret masking.
 *
 * Hand-picked cases would confirm the examples and miss the property that actually matters: that a
 * masked value carries no signal about the secret's length. That only shows up across many lengths,
 * so the exact table below is followed by a fuzz pass over lengths 0 to 200.
 *
 * Randomness is seeded, so a failure is reproducible rather than a one-off that vanishes on re-run.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { __clearSecretsForTest, __registeredCountForTest, maskSecret, maskSecrets, registerSecret } from '../../src/cli/secrets.js';

/**
 * Deterministic PRNG, so a failing case can be reproduced from the seed alone.
 *
 * The state is a local inside the closure rather than a reassigned parameter: scoped, dies with the
 * closure, and never leaks out.
 */
const lcg = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~+/=*';

const randomString = (rand: () => number, length: number): string =>
  Array.from({ length }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');

/** The rule, stated independently of the implementation so the test is not a restatement of it. */
const expectedRevealCount = (length: number): number => Math.min(Math.max(length - 4, 0), 4);

describe('maskSecret — the exact table', () => {
  // Every length at or below the star count reveals nothing. Checked exhaustively because this is
  // the range where revealing even one character would be a large fraction of the value.
  it('reveals nothing for every length from 0 to 4', () => {
    for (const value of ['', 'a', 'ab', 'abc', 'abcd']) {
      expect(maskSecret(value)).toBe('****');
    }
  });

  it('reveals one more character per length from 5 to 8, then stops', () => {
    expect(maskSecret('abcdp')).toBe('****p');
    expect(maskSecret('abcdpp')).toBe('****pp');
    expect(maskSecret('abcdppp')).toBe('****ppp');
    expect(maskSecret('abcdpppp')).toBe('****pppp');
    // capped
    expect(maskSecret('abcdppppp')).toBe('****pppp');
    expect(maskSecret('abcdefghijklmnop')).toBe('****mnop');
  });
});

describe('maskSecret — fuzz over lengths 0 to 200', () => {
  const rand = lcg(20261006);

  it('never reveals more than four characters, and always exactly the real tail', () => {
    for (let length = 0; length <= 200; length++) {
      const value = randomString(rand, length);
      const masked = maskSecret(value);
      const reveal = expectedRevealCount(length);

      expect(masked.slice(0, 4)).toBe('****');
      expect(masked.length).toBe(4 + reveal);
      expect(masked.slice(4)).toBe(reveal > 0 ? value.slice(-reveal) : '');
    }
  });

  /**
   * The security property, and the reason to fuzz rather than enumerate: for any secret of a
   * realistic length the masked form is the SAME LENGTH regardless of the secret's length, so the
   * output says nothing about how long the credential is. This is what the rejected `length % N`
   * scheme would have failed.
   */
  it('produces a constant-length result for every length of 8 or more', () => {
    const rand2 = lcg(7);
    const widths = new Set<number>();
    for (let length = 8; length <= 200; length++) {
      widths.add(maskSecret(randomString(rand2, length)).length);
    }
    expect([...widths]).toEqual([8]);
  });

  it('hides at least every character beyond the last four', () => {
    const rand3 = lcg(99);
    for (let length = 5; length <= 120; length++) {
      const value = randomString(rand3, length);
      const masked = maskSecret(value);
      // The honest statement of the property. "Never contains the whole secret" is what this test
      // asserted first, and it is FALSE: see the degenerate case below. What is always true is that
      // no more than the last four characters of the value appear in the output.
      expect(masked.slice(4).length).toBeLessThanOrEqual(4);
      expect(value.slice(0, Math.max(length - 4, 0))).not.toBe('');
      expect(masked).not.toContain(value.slice(0, Math.max(length - 4, 0)));
    }
  });

  /**
   * A documented limit, found by fuzzing and recorded rather than hidden.
   *
   * Value-based masking substitutes a fixed character, so a value composed OF that character can
   * coincide with its own mask. For lengths 4 to 8, an all-asterisk value masks to itself. No
   * credential looks like this, and no amount of cleverness removes the coincidence — any mask
   * character could also appear in a secret. It is here so the next reader knows it was considered.
   */
  it('coincides with its own mask for an all-asterisk value of length 4 to 8, which is not a credential', () => {
    expect(maskSecret('****')).toBe('****');
    expect(maskSecret('*****')).toBe('*****');
    expect(maskSecret('********')).toBe('********');
    // Beyond that length the cap takes over and the coincidence stops.
    expect(maskSecret('*********')).toBe('********');
    expect(maskSecret('*'.repeat(40))).toBe('********');
  });
});

describe('registerSecret', () => {
  beforeEach(() => __clearSecretsForTest());

  /**
   * The floor is not about how much to reveal; it is about not corrupting unrelated output.
   * Registering a short string would rewrite that sequence wherever it appeared — inside field
   * names, URLs, ordinary prose. No real credential is this short.
   */
  it('refuses to register a value short enough to corrupt unrelated text', () => {
    for (const tooShort of ['', 'a', 'abc', 'abcdefg']) registerSecret(tooShort);
    expect(__registeredCountForTest()).toBe(0);

    registerSecret('abcdefgh');
    expect(__registeredCountForTest()).toBe(1);
  });

  it('ignores undefined without throwing, so it can wrap an optional value', () => {
    expect(registerSecret(undefined)).toBeUndefined();
    expect(__registeredCountForTest()).toBe(0);
  });

  it('returns its argument unchanged, so it can wrap an expression in place', () => {
    expect(registerSecret('a-real-looking-token')).toBe('a-real-looking-token');
  });
});

describe('maskSecrets — over text', () => {
  beforeEach(() => __clearSecretsForTest());

  it('replaces a registered secret everywhere it appears, including inside JSON and a URL', () => {
    registerSecret('SENTINEL-abcdefgh');
    const text = JSON.stringify({
      context: { authToken: 'SENTINEL-abcdefgh' },
      requestDetails: [{ url: 'https://example.org/Property?access_token=SENTINEL-abcdefgh' }],
      error: 'request failed with Authorization: Bearer SENTINEL-abcdefgh'
    });

    const masked = maskSecrets(text);
    expect(masked).not.toContain('SENTINEL-abcdefgh');
    expect(masked.split('****efgh').length - 1).toBe(3);
  });

  it('leaves text alone when nothing is registered', () => {
    const text = 'nothing secret here';
    expect(maskSecrets(text)).toBe(text);
  });

  /**
   * A wrapped form contains the raw one — register `Bearer <token>` as well as the token and the
   * order of replacement decides whether the raw value survives. Longest first is what makes this
   * pass; replacing the short one first would leave `Bearer ****` and strand the raw token's tail.
   */
  it('masks a wrapped form and its raw value without leaving either behind', () => {
    const raw = 'tok-abcdefghijkl';
    registerSecret(raw);
    registerSecret(`Bearer ${raw}`);

    const masked = maskSecrets(`header was "Bearer ${raw}" and the raw value was ${raw}`);
    expect(masked).not.toContain(raw);
  });

  it('fuzz: a registered secret never survives, at any position in surrounding text', () => {
    const rand = lcg(31337);
    for (let i = 0; i < 150; i++) {
      __clearSecretsForTest();
      // Drawn from an alphabet without the mask character: an all-asterisk secret masks to itself,
      // which is a real limit of value-based masking and is asserted directly above rather than
      // smuggled into a fuzz pass that would only find it by luck.
      const secret = randomString(rand, 8 + Math.floor(rand() * 60)).replace(/\*/g, 'x');
      registerSecret(secret);
      const before = randomString(rand, Math.floor(rand() * 40));
      const after = randomString(rand, Math.floor(rand() * 40));
      expect(maskSecrets(`${before}${secret}${after}`)).not.toContain(secret);
    }
  });
});
