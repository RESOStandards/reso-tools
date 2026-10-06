import { describe, expect, it, vi } from 'vitest';
import { createPipeline } from '../../src/sdk/pipeline.js';
import type { PipelineStep, StepProgress } from '../../src/sdk/types.js';

describe('createPipeline', () => {
  const makeStep = (name: string, result: Partial<Awaited<ReturnType<NonNullable<PipelineStep['run']>>>> = {}): PipelineStep => ({
    name,
    run: async ctx => ({
      context: { ...ctx, [`${name}_ran`]: true },
      ...result
    })
  });

  it('runs steps sequentially and accumulates context', async () => {
    const pipeline = createPipeline('test', [makeStep('step-1'), makeStep('step-2'), makeStep('step-3')]);

    const result = await pipeline.run({});

    expect(result.status).toBe('passed');
    expect(result.endorsement).toBe('test');
    expect(result.context['step-1_ran']).toBe(true);
    expect(result.context['step-2_ran']).toBe(true);
    expect(result.context['step-3_ran']).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === 'passed')).toBe(true);
  });

  it('records step durations', async () => {
    const pipeline = createPipeline('test', [
      makeStep('slow', {
        summary: 'did something'
      })
    ]);

    const result = await pipeline.run({});

    expect(result.steps[0].duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('stops on first failure when failFast is true', async () => {
    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2', { status: 'failed', errors: ['broke'] }),
      makeStep('step-3')
    ]);

    const result = await pipeline.run({}, undefined, { failFast: true });

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].errors).toEqual(['broke']);
    expect(result.steps[2].status).toBe('skipped');
  });

  it('runs alwaysRun finalizer steps after a failFast break, leaves intermediates skipped', async () => {
    // Pipeline: step-1 (passes) → step-2 (fails) → step-3 (would normally
    // be skipped) → write-reports (alwaysRun, must still run). After the
    // break, write-reports executes and gets 'passed'; step-3 stays
    // 'skipped' because it really did not run. Result order matches
    // the original step declaration order.
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => ({ context: { ...ctx, reports_written: true } })
    };

    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2', { status: 'failed', errors: ['boom'] }),
      makeStep('step-3'),
      writeReports
    ]);

    const result = await pipeline.run({}, undefined, { failFast: true });

    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('skipped');
    expect(result.steps[3].name).toBe('write-reports');
    expect(result.steps[3].status).toBe('passed');
    expect(result.context.reports_written).toBe(true);
  });

  it('records alwaysRun step failure without changing the original failure narrative', async () => {
    // If write-reports itself fails, the pipeline is still 'failed'
    // (it already was) and the alwaysRun step's status reflects what
    // happened — it does not silently swallow its own error.
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async () => {
        throw new Error('disk full');
      }
    };

    const pipeline = createPipeline('test', [makeStep('step-1', { status: 'failed' }), writeReports]);

    const result = await pipeline.run({}, undefined, { failFast: true });

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].errors).toEqual(['disk full']);
  });

  it('does not invoke alwaysRun finalizer if it already ran in the main loop', async () => {
    // When all main-loop steps succeed, write-reports runs in the main
    // loop normally. The post-break alwaysRun pass should not run it
    // again.
    const runCount = vi.fn();
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        runCount();
        return { context: ctx };
      }
    };

    const pipeline = createPipeline('test', [makeStep('step-1'), writeReports]);
    const result = await pipeline.run({});

    expect(result.status).toBe('passed');
    expect(runCount).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(2);
  });

  it('shows a finalizer the step that THREW, not just steps that returned a failure', async () => {
    // A report written from inside the pipeline can only be as truthful as what the finalizer can
    // see. The pipeline's own status is not computed until after the step loop, so a finalizer
    // derives its verdict from ctx.pipelineSteps — and the catch path used to push the failed step
    // into stepResults without refreshing the context, leaving the finalizer looking at a stale
    // array in which nothing had failed. A DD report written on that path claimed compliance.
    const seen: Array<Array<[string, string]>> = [];
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        const steps = (ctx.pipelineSteps as ReadonlyArray<{ name: string; status: string }>) ?? [];
        seen.push(steps.map(s => [s.name, s.status]));
        return { context: ctx };
      }
    };
    const throwingStep: PipelineStep = {
      name: 'validate',
      run: async () => {
        throw new Error('metadata fetch exploded');
      }
    };

    const result = await createPipeline('test', [makeStep('step-1'), throwingStep, writeReports]).run({});

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContainEqual(['validate', 'failed']);
    // And the pipeline's own verdict is unchanged by the fix.
    expect(result.status).toBe('failed');
  });

  it('preserves accumulated context when a step throws, replacing only pipelineSteps', async () => {
    // The catch path has no output.context to spread — the step threw before returning one — so the
    // refresh must build on the context already accumulated. Losing it would break every later step
    // and finalizer across all four endorsements, not just the report verdict.
    let finalizerCtx: Record<string, unknown> = {};
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        finalizerCtx = { ...ctx };
        return { context: ctx };
      }
    };
    const throwingStep: PipelineStep = {
      name: 'validate',
      run: async () => {
        throw new Error('boom');
      }
    };

    await createPipeline('test', [makeStep('step-1'), makeStep('step-2'), throwingStep, writeReports]).run({
      seeded: 'value'
    });

    expect(finalizerCtx.seeded).toBe('value');
    expect(finalizerCtx['step-1_ran']).toBe(true);
    expect(finalizerCtx['step-2_ran']).toBe(true);
  });

  it('shows a finalizer every declared step, with the unrun ones marked skipped', async () => {
    // A report written from inside the pipeline is only as complete as ctx.pipelineSteps. Before this,
    // the context carried just the steps that had finished, so a report written by an alwaysRun
    // finalizer silently omitted the steps failFast skipped — a reader could not tell replication had
    // been skipped rather than passed. The pipeline appends those as 'skipped' only AFTER the loop,
    // which is too late for the finalizer that is writing the artifact.
    const seen: Array<Array<[string, string]>> = [];
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        const steps = (ctx.pipelineSteps as ReadonlyArray<{ name: string; status: string }>) ?? [];
        seen.push(steps.map(s => [s.name, s.status]));
        return { context: ctx };
      }
    };

    await createPipeline('test', [makeStep('step-1'), makeStep('step-2', { status: 'failed' }), makeStep('step-3'), writeReports]).run({});

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      ['step-1', 'passed'],
      ['step-2', 'failed'],
      ['step-3', 'skipped']
    ]);
  });

  it('does not seed an alwaysRun step as skipped, since one is never skipped', async () => {
    // Seeding the finalizer itself would make the report describe itself as skipped while it runs,
    // which is a false statement rather than a missing one. An alwaysRun step appears only once it
    // has a real result, which it cannot have while it is the thing writing.
    let seenNames: ReadonlyArray<string> = [];
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        seenNames = ((ctx.pipelineSteps as ReadonlyArray<{ name: string }>) ?? []).map(s => s.name);
        return { context: ctx };
      }
    };
    await createPipeline('test', [makeStep('step-1', { status: 'failed' }), makeStep('step-2'), writeReports]).run({});
    expect(seenNames).not.toContain('write-reports');
    expect(seenNames).toEqual(['step-1', 'step-2']);
  });

  it('leaves the RETURNED steps array unchanged — one entry per step, declaration order', async () => {
    // The invariant the seed must not break: the terminal renders from the returned result, and the
    // pipeline already appends skipped steps after the loop. A seed that leaked into stepResults would
    // double-add them.
    const writeReports: PipelineStep = { name: 'write-reports', alwaysRun: true, run: async ctx => ({ context: ctx }) };
    const result = await createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2', { status: 'failed' }),
      makeStep('step-3'),
      writeReports
    ]).run({});

    expect(result.steps.map(s => [s.name, s.status])).toEqual([
      ['step-1', 'passed'],
      ['step-2', 'failed'],
      ['step-3', 'skipped'],
      ['write-reports', 'passed']
    ]);
    expect(result.steps).toHaveLength(4);
    expect(new Set(result.steps.map(s => s.name)).size).toBe(4);
  });

  it('is invisible on a clean run — every step carries its real result', async () => {
    const seen: Array<Array<[string, string]>> = [];
    const writeReports: PipelineStep = {
      name: 'write-reports',
      alwaysRun: true,
      run: async ctx => {
        const steps = (ctx.pipelineSteps as ReadonlyArray<{ name: string; status: string }>) ?? [];
        seen.push(steps.map(s => [s.name, s.status]));
        return { context: ctx };
      }
    };
    await createPipeline('test', [makeStep('step-1'), makeStep('step-2'), writeReports]).run({});
    expect(seen[0]).toEqual([
      ['step-1', 'passed'],
      ['step-2', 'passed']
    ]);
  });

  it('continues after failure when failFast is false', async () => {
    const pipeline = createPipeline('test', [makeStep('step-1'), makeStep('step-2', { status: 'failed' }), makeStep('step-3')]);

    const result = await pipeline.run({}, undefined, { failFast: false });

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('passed');
  });

  it('catches thrown errors and marks step as failed', async () => {
    const throwingStep: PipelineStep = {
      name: 'throws',
      run: async () => {
        throw new Error('unexpected');
      }
    };

    const pipeline = createPipeline('test', [makeStep('step-1'), throwingStep, makeStep('step-3')]);

    const result = await pipeline.run({});

    expect(result.status).toBe('failed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].errors).toEqual(['unexpected']);
    expect(result.steps[2].status).toBe('skipped');
  });

  it('emits progress callbacks for each step', async () => {
    const progressEvents: StepProgress[] = [];
    const onProgress = (p: StepProgress) => progressEvents.push(p);

    const pipeline = createPipeline('test', [makeStep('step-1', { summary: 'done' }), makeStep('step-2')]);

    await pipeline.run({}, onProgress);

    // Each step emits 'running' then 'passed'
    expect(progressEvents.filter(p => p.step === 'step-1')).toHaveLength(2);
    expect(progressEvents.find(p => p.step === 'step-1' && p.status === 'running')).toBeTruthy();
    expect(progressEvents.find(p => p.step === 'step-1' && p.status === 'passed')).toBeTruthy();
    expect(progressEvents.find(p => p.step === 'step-1' && p.status === 'passed')?.message).toBe('done');
  });

  it('preserves step metadata in results', async () => {
    const step: PipelineStep = {
      name: 'detailed',
      run: async ctx => ({
        context: ctx,
        summary: '14 resources processed',
        params: { resource: 'Property' },
        counts: { resources: 14, fields: 1727 },
        artifacts: [{ label: 'Report', path: '/tmp/report.json' }]
      })
    };

    const pipeline = createPipeline('test', [step]);
    const result = await pipeline.run({});

    expect(result.steps[0].summary).toBe('14 resources processed');
    expect(result.steps[0].params).toEqual({ resource: 'Property' });
    expect(result.steps[0].counts).toEqual({ resources: 14, fields: 1727 });
    expect(result.steps[0].artifacts).toEqual([{ label: 'Report', path: '/tmp/report.json' }]);
  });

  it('passes accumulated step results through context as pipelineSteps', async () => {
    const checkContext: PipelineStep = {
      name: 'checker',
      run: async ctx => {
        const steps = ctx.pipelineSteps as ReadonlyArray<unknown>;
        return {
          context: { ...ctx, priorStepCount: steps?.length ?? 0 }
        };
      }
    };

    const pipeline = createPipeline('test', [makeStep('first'), checkContext]);

    const result = await pipeline.run({});
    expect(result.context.priorStepCount).toBe(1);
  });

  it('defaults failFast to true', async () => {
    const pipeline = createPipeline('test', [makeStep('step-1', { status: 'failed' }), makeStep('step-2')]);

    const result = await pipeline.run({});

    expect(result.steps[1].status).toBe('skipped');
  });

  it('handles empty pipeline', async () => {
    const pipeline = createPipeline('test', []);
    const result = await pipeline.run({});

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(0);
  });
});
