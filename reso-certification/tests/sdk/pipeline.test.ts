import { describe, it, expect, vi } from 'vitest';
import { createPipeline } from '../../src/sdk/pipeline.js';
import type { PipelineStep, StepProgress, PipelineContext } from '../../src/sdk/types.js';

describe('createPipeline', () => {
  const makeStep = (
    name: string,
    result: Partial<Awaited<ReturnType<PipelineStep['run']>>> = {},
  ): PipelineStep => ({
    name,
    run: async (ctx) => ({
      context: { ...ctx, [`${name}_ran`]: true },
      ...result,
    }),
  });

  it('runs steps sequentially and accumulates context', async () => {
    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2'),
      makeStep('step-3'),
    ]);

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
    const pipeline = createPipeline('test', [makeStep('slow', {
      summary: 'did something',
    })]);

    const result = await pipeline.run({});

    expect(result.steps[0].duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('stops on first failure when failFast is true', async () => {
    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2', { status: 'failed', errors: ['broke'] }),
      makeStep('step-3'),
    ]);

    const result = await pipeline.run({}, undefined, { failFast: true });

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].errors).toEqual(['broke']);
    expect(result.steps[2].status).toBe('skipped');
  });

  it('continues after failure when failFast is false', async () => {
    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      makeStep('step-2', { status: 'failed' }),
      makeStep('step-3'),
    ]);

    const result = await pipeline.run({}, undefined, { failFast: false });

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('passed');
  });

  it('catches thrown errors and marks step as failed', async () => {
    const throwingStep: PipelineStep = {
      name: 'throws',
      run: async () => { throw new Error('unexpected'); },
    };

    const pipeline = createPipeline('test', [
      makeStep('step-1'),
      throwingStep,
      makeStep('step-3'),
    ]);

    const result = await pipeline.run({});

    expect(result.status).toBe('failed');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].errors).toEqual(['unexpected']);
    expect(result.steps[2].status).toBe('skipped');
  });

  it('emits progress callbacks for each step', async () => {
    const progressEvents: StepProgress[] = [];
    const onProgress = (p: StepProgress) => progressEvents.push(p);

    const pipeline = createPipeline('test', [
      makeStep('step-1', { summary: 'done' }),
      makeStep('step-2'),
    ]);

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
      run: async (ctx) => ({
        context: ctx,
        summary: '14 resources processed',
        params: { resource: 'Property' },
        counts: { resources: 14, fields: 1727 },
        artifacts: [{ label: 'Report', path: '/tmp/report.json' }],
      }),
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
      run: async (ctx) => {
        const steps = ctx.pipelineSteps as ReadonlyArray<unknown>;
        return {
          context: { ...ctx, priorStepCount: steps?.length ?? 0 },
        };
      },
    };

    const pipeline = createPipeline('test', [
      makeStep('first'),
      checkContext,
    ]);

    const result = await pipeline.run({});
    expect(result.context.priorStepCount).toBe(1);
  });

  it('defaults failFast to true', async () => {
    const pipeline = createPipeline('test', [
      makeStep('step-1', { status: 'failed' }),
      makeStep('step-2'),
    ]);

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
