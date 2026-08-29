/**
 * Continue-on-error, as an async generator (the primitive) plus a thin collector.
 *
 * The generator owns the CONTROL policy and the consumer owns the STATE — the split
 * the legacy replication iterator got right, minus the bugs it earned by making the
 * parent also implement the stop logic (a cumulative-not-consecutive counter,
 * swallowed errors). `settle` runs each item, yields its outcome, and stops itself
 * on a fatal error or on any failure under `fail-fast`; the consumer just drives the
 * `for await` and accumulates whatever shape it wants.
 *
 * Why a generator: seeding/replication is millions of records — an all-at-once result
 * would hold every outcome in memory. A generator streams (yield a page, the consumer
 * processes and discards it, pulls the next) with natural backpressure, so the consumer
 * can checkpoint each unit to disk before pulling the next. `runSettled` layers on top
 * for the bounded case that just wants a summary.
 *
 * Sequential for now; a parallel variant (a pool pulling from a shared queue) is the
 * parallel-fetchers work.
 */

import { isResilienceError } from './errors.js';

export type OnError = 'continue' | 'fail-fast';

export type UnitOutcome<T, R> =
  | { readonly item: T; readonly status: 'ok'; readonly value: R }
  | { readonly item: T; readonly status: 'failed'; readonly error: unknown; readonly fatal: boolean }
  | { readonly item: T; readonly status: 'skipped'; readonly reason: string };

export interface SettleOptions {
  /** Default `'continue'`. */
  readonly onError?: OnError;
  /** Whether an error stops the whole run. Default: a ResilienceError of kind `fatal-auth`. */
  readonly isFatal?: (error: unknown) => boolean;
}

interface SkipSignal extends Error {
  readonly resilientSkip: string;
}

/** Throw from a `run` callback to record the current item as skipped (not failed). */
export const skip = (reason: string): never => {
  throw Object.assign(new Error(`skipped: ${reason}`), { resilientSkip: reason });
};

const isSkip = (err: unknown): err is SkipSignal =>
  err instanceof Error && typeof (err as { resilientSkip?: unknown }).resilientSkip === 'string';

const defaultIsFatal = (error: unknown): boolean =>
  isResilienceError(error) && error.resilienceKind === 'fatal-auth';

/**
 * The primitive. Runs each item through `run` and yields its outcome. Stops (ends the
 * generator) on a fatal error, and on any failure when `onError` is `'fail-fast'` —
 * so the consumer never re-implements the stop logic. Returns `true` when it stopped
 * early, `false` when it ran every item.
 *
 * NOTE — resume (we will likely need this): this is a ONE-WAY generator; it only yields.
 * Resumable replication wants a TWO-WAY generator, where the consumer sends a value back
 * in via `.next(cursor)` — a persisted resume cursor, or a "stop after this" — so a
 * killed run picks up where it left off instead of restarting. Deferred for now (DD 2.2 /
 * the iterator port). When it lands, widen the generator's third type parameter (today
 * `void`, the `.next()` input type) to the feedback type and read it from the `yield`
 * expression. Keeping the surface one-way until resume actually forces the change.
 */
export async function* settle<T, R>(
  items: Iterable<T>,
  run: (item: T) => Promise<R>,
  options: SettleOptions = {}
): AsyncGenerator<UnitOutcome<T, R>, boolean, void> {
  const onError = options.onError ?? 'continue';
  const isFatal = options.isFatal ?? defaultIsFatal;

  for (const item of items) {
    try {
      const value = await run(item);
      yield { item, status: 'ok', value };
    } catch (err) {
      if (isSkip(err)) {
        yield { item, status: 'skipped', reason: err.resilientSkip };
        continue;
      }
      const fatal = isFatal(err);
      yield { item, status: 'failed', error: err, fatal };
      if (fatal || onError === 'fail-fast') return true;
    }
  }
  return false;
}

export interface SettledResult<T, R> {
  readonly outcomes: ReadonlyArray<UnitOutcome<T, R>>;
  readonly succeeded: ReadonlyArray<R>;
  readonly failed: ReadonlyArray<{ readonly item: T; readonly error: unknown }>;
  readonly skipped: ReadonlyArray<{ readonly item: T; readonly reason: string }>;
  /** True when a fatal error or a fail-fast failure stopped the run before all items ran. */
  readonly stoppedEarly: boolean;
  readonly fatalError?: unknown;
}

export interface RunSettledOptions<T, R> extends SettleOptions {
  /** Fires as each unit settles — the checkpoint-as-you-go hook. */
  readonly onOutcome?: (outcome: UnitOutcome<T, R>) => void;
}

/** Drains `settle` into a structured summary — for the bounded case that just wants the totals. */
export const runSettled = async <T, R>(
  items: Iterable<T>,
  run: (item: T) => Promise<R>,
  options: RunSettledOptions<T, R> = {}
): Promise<SettledResult<T, R>> => {
  const outcomes: UnitOutcome<T, R>[] = [];
  const generator = settle(items, run, options);

  let step = await generator.next();
  while (!step.done) {
    outcomes.push(step.value);
    options.onOutcome?.(step.value);
    step = await generator.next();
  }
  const stoppedEarly = step.value;

  const fatalOutcome = outcomes.find(
    (o): o is Extract<UnitOutcome<T, R>, { status: 'failed' }> => o.status === 'failed' && o.fatal
  );

  return {
    outcomes,
    succeeded: outcomes.flatMap((o) => (o.status === 'ok' ? [o.value] : [])),
    failed: outcomes.flatMap((o) => (o.status === 'failed' ? [{ item: o.item, error: o.error }] : [])),
    skipped: outcomes.flatMap((o) => (o.status === 'skipped' ? [{ item: o.item, reason: o.reason }] : [])),
    stoppedEarly,
    ...(fatalOutcome ? { fatalError: fatalOutcome.error } : {})
  };
};
