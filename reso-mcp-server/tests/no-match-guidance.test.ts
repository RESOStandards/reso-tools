/**
 * A filtered query that matches nothing is the one result a user cannot act on, and "no listings
 * found" is both the obvious reply and the least useful one. The server answers it by telling the
 * model to offer a per-criterion breakdown instead.
 *
 * The thing worth testing is not that the offer happens. It is that the offer STOPS happening.
 * Guidance attached to every empty result is nagging, so two gates govern it: the first miss of a
 * session earns it, and after that a run of three consecutive misses re-earns it. Each test below is
 * named for the behavior it would allow if the gate were removed, and the negative cases carry the
 * weight: a gate that always opens is not a gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_AUTH_TOKEN, ENV_BASE_URL } from '../src/auth-env.js';
import { createGuidanceGate, handlers } from '../src/handlers.js';

const SERVER = 'https://data.example.com';
const THRESHOLD = 3;

// ── The gate itself, on a fresh instance per test so the cadence is deterministic ──

describe('the guidance gate opens once, then only on a run of misses', () => {
  it('offers on the first miss, because one empty search is where the offer helps most', () => {
    const gate = createGuidanceGate(THRESHOLD);
    expect(gate(true)).toBe(true);
  });

  it('stays quiet on the second and third miss, so it is not attached to every empty result', () => {
    const gate = createGuidanceGate(THRESHOLD);
    gate(true);
    expect(gate(true)).toBe(false);
    expect(gate(true)).toBe(false);
  });

  it('offers again on the fourth miss, three misses after the last offer', () => {
    const gate = createGuidanceGate(THRESHOLD);
    expect(gate(true)).toBe(true);
    expect(gate(true)).toBe(false);
    expect(gate(true)).toBe(false);
    expect(gate(true)).toBe(true);
  });

  it('settles into a one-in-three cadence rather than firing on every miss past the threshold', () => {
    const gate = createGuidanceGate(THRESHOLD);
    const offers = Array.from({ length: 10 }, () => gate(true));

    // Misses 1, 4, 7 and 10. Without the reset on each offer this would be true from miss 3 onward.
    expect(offers).toEqual([true, false, false, true, false, false, true, false, false, true]);
  });

  it('never offers when a query returned rows, which is the case the offer does not apply to', () => {
    const gate = createGuidanceGate(THRESHOLD);
    expect(gate(false)).toBe(false);
    expect(gate(false)).toBe(false);
    expect(gate(false)).toBe(false);
    expect(gate(false)).toBe(false);
  });

  it('treats a run as consecutive, not cumulative, so a successful search resets it', () => {
    const gate = createGuidanceGate(THRESHOLD);
    gate(true); // spends the first-time offer

    expect(gate(true)).toBe(false); // run 1
    expect(gate(true)).toBe(false); // run 2
    expect(gate(false)).toBe(false); // a hit: run back to 0
    expect(gate(true)).toBe(false); // run 1 again, not 3
    expect(gate(true)).toBe(false); // run 2
    expect(gate(true)).toBe(true); // run 3
  });

  it('honors the threshold it is given rather than a hardcoded one', () => {
    const gate = createGuidanceGate(2);
    gate(true);
    expect(gate(true)).toBe(false);
    expect(gate(true)).toBe(true);
  });
});

// ── The second reader: the gate being correct proves nothing if the handler ignores it ──

describe('the handler attaches the guidance, and only when the gate says so', () => {
  const rows = [{ ListingKey: 'abc' }];

  /** Stubs fetch so each call returns either an empty collection or one row, on demand. */
  const stubFetch = (): { empty: () => void; withRows: () => void } => {
    const state = { body: { value: [] as ReadonlyArray<unknown> } };

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(state.body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );

    return {
      empty: () => {
        state.body = { value: [] };
      },
      withRows: () => {
        state.body = { value: rows };
      }
    };
  };

  // stubEnv rather than assignment, so an operator shell that already exports RESO_AUTH_TOKEN cannot
  // change what these tests exercise. Same convention as auth-resolution.test.ts.
  beforeEach(() => {
    vi.stubEnv(ENV_AUTH_TOKEN, 'test-token');
    vi.stubEnv(ENV_BASE_URL, SERVER);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ORDER IS LOAD-BEARING. The gate lives as long as the module, so the cases that need it unspent
  // run first. The no-filter case only proves anything while the gate would otherwise have opened;
  // run after the sequence below it would pass because the gate was already spent, which is a test
  // that cannot fail.

  it('says nothing on an empty result with no filter, since there are no criteria to break down', async () => {
    const fetchState = stubFetch();
    fetchState.empty();

    const result = await handlers.query({ url: SERVER, resource: 'Property' });

    expect(result.content).toHaveLength(1);
  });

  it('walks a whole session: note, quiet, quiet, note, and never on a result with rows', async () => {
    const fetchState = stubFetch();
    const query = (filter?: string) => handlers.query({ url: SERVER, resource: 'Property', ...(filter ? { filter } : {}) });

    fetchState.empty();

    const first = await query("City eq 'Austin'");
    expect(first.content).toHaveLength(2);

    // The note is the whole feature, so its load-bearing instructions are asserted here, where it is
    // known to be present, rather than in a later case whose outcome depends on gate state.
    const note = first.content[1].text;
    expect(note).toContain('no exact matches');
    expect(note).toContain('never estimate');
    expect(note).toContain('widen or change their criteria');
    expect(note).toMatch(/do not mention[\s\S]*query syntax/i);

    // And the server payload came back untouched in its own block, with no guidance key spliced in.
    const payload = JSON.parse(first.content[0].text) as Record<string, unknown>;
    expect(payload).toEqual({ value: [] });
    expect(Object.keys(payload)).not.toContain('guidance');

    expect((await query("City eq 'Austin'")).content).toHaveLength(1);
    expect((await query("City eq 'Austin'")).content).toHaveLength(1);

    const fourth = await query("City eq 'Austin'");
    expect(fourth.content).toHaveLength(2);

    fetchState.withRows();
    const hit = await query("City eq 'Dallas'");
    expect(hit.content).toHaveLength(1);
  });
});
