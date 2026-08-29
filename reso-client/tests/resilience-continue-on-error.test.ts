import { describe, expect, it } from 'vitest';
import { runSettled, settle, skip, type UnitOutcome } from '../src/http/resilience/continue-on-error.js';
import { isResilienceError, resilienceError } from '../src/http/resilience/errors.js';

type Behavior = 'ok' | 'fail' | 'skip' | 'fatal';

/** A `run` over string items whose behavior is looked up per item; records what actually ran. */
const runner =
  (behaviors: Record<string, Behavior> = {}, ran?: string[]) =>
  async (item: string): Promise<string> => {
    ran?.push(item);
    const behavior = behaviors[item] ?? 'ok';
    if (behavior === 'fail') throw new Error(`fail:${item}`);
    if (behavior === 'skip') return skip(`skip:${item}`);
    if (behavior === 'fatal') throw resilienceError('fatal-auth', `fatal:${item}`);
    return `ok:${item}`;
  };

describe('settle (generator primitive)', () => {
  it('is lazy — breaking early leaves later items un-run (streaming/backpressure)', async () => {
    const ran: string[] = [];
    const seen: string[] = [];
    for await (const outcome of settle(['a', 'b', 'c', 'd', 'e'], runner({}, ran))) {
      seen.push(outcome.item);
      if (seen.length === 2) break; // pull only two
    }
    expect(seen).toEqual(['a', 'b']);
    expect(ran).toEqual(['a', 'b']); // c/d/e never ran — proof of pull semantics
  });

  it('returns stoppedEarly=false when every item runs', async () => {
    const generator = settle(['a', 'b'], runner({}));
    let step = await generator.next();
    while (!step.done) step = await generator.next();
    expect(step.value).toBe(false);
  });

  it('yields the fatal failure, then stops without running the rest', async () => {
    const ran: string[] = [];
    const outcomes: UnitOutcome<string, string>[] = [];
    const generator = settle(['a', 'b', 'c'], runner({ b: 'fatal' }, ran));
    let step = await generator.next();
    while (!step.done) {
      outcomes.push(step.value);
      step = await generator.next();
    }
    expect(step.value).toBe(true); // stopped early
    expect(ran).toEqual(['a', 'b']); // c never ran
    expect(outcomes.map((o) => o.status)).toEqual(['ok', 'failed']);
  });
});

describe('runSettled (collector)', () => {
  it('collects all successes', async () => {
    const r = await runSettled(['a', 'b', 'c'], runner({}));
    expect(r.succeeded).toEqual(['ok:a', 'ok:b', 'ok:c']);
    expect(r.failed).toEqual([]);
    expect(r.stoppedEarly).toBe(false);
  });

  it('continues past a per-unit failure, recording it', async () => {
    const ran: string[] = [];
    const r = await runSettled(['a', 'b', 'c'], runner({ b: 'fail' }, ran), { onError: 'continue' });
    expect(ran).toEqual(['a', 'b', 'c']); // all ran
    expect(r.succeeded).toEqual(['ok:a', 'ok:c']);
    expect(r.failed.map((f) => f.item)).toEqual(['b']);
    expect(r.stoppedEarly).toBe(false);
  });

  it('stops at the first failure under fail-fast', async () => {
    const ran: string[] = [];
    const r = await runSettled(['a', 'b', 'c'], runner({ b: 'fail' }, ran), { onError: 'fail-fast' });
    expect(ran).toEqual(['a', 'b']); // c not run
    expect(r.failed.map((f) => f.item)).toEqual(['b']);
    expect(r.stoppedEarly).toBe(true);
  });

  it('always stops on a fatal, even under continue', async () => {
    const ran: string[] = [];
    const r = await runSettled(['a', 'b', 'c'], runner({ b: 'fatal' }, ran), { onError: 'continue' });
    expect(ran).toEqual(['a', 'b']); // c not run
    expect(r.stoppedEarly).toBe(true);
    expect(isResilienceError(r.fatalError) && r.fatalError.resilienceKind).toBe('fatal-auth');
  });

  it('records skips distinctly and keeps going', async () => {
    const r = await runSettled(['a', 'b', 'c'], runner({ b: 'skip' }));
    expect(r.succeeded).toEqual(['ok:a', 'ok:c']);
    expect(r.skipped).toEqual([{ item: 'b', reason: 'skip:b' }]);
    expect(r.failed).toEqual([]);
  });

  it('fires onOutcome as each unit settles (checkpoint hook)', async () => {
    const seen: string[] = [];
    await runSettled(['a', 'b'], runner({ b: 'fail' }), {
      onOutcome: (o) => seen.push(`${o.status}:${o.item}`)
    });
    expect(seen).toEqual(['ok:a', 'failed:b']);
  });

  it('honors a custom isFatal', async () => {
    const r = await runSettled(['a', 'b', 'c'], runner({ b: 'fail' }), { isFatal: () => true });
    expect(r.stoppedEarly).toBe(true);
    expect(r.fatalError).toBeDefined();
  });
});
