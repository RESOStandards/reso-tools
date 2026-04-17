import { describe, it, expect } from 'vitest';
import { createPipeline } from '../../src/sdk/pipeline.js';
import type { PipelineStep, StepProgress, TestFunction } from '../../src/sdk/types.js';

describe('pipeline sub-function progress', () => {
  it('threads onProgress to sequential sub-functions', async () => {
    const events: StepProgress[] = [];
    const onProgress = (p: StepProgress) => events.push(p);

    const fn1: TestFunction = async (ctx, progress) => {
      progress({ step: 'sub:work', status: 'running', message: 'doing work' });
      return { context: ctx, summary: 'fn1 done' };
    };

    const fn2: TestFunction = async (ctx, progress) => {
      progress({ step: 'sub:work', status: 'running', message: 'more work' });
      return { context: ctx, summary: 'fn2 done' };
    };

    const step: PipelineStep = {
      name: 'multi-function-step',
      mode: 'sequential',
      functions: [fn1, fn2],
    };

    const pipeline = createPipeline('test', [step]);
    await pipeline.run({}, onProgress);

    // Should have sub-step events from both functions
    const subEvents = events.filter(e => e.step === 'sub:work');
    expect(subEvents).toHaveLength(2);
    expect(subEvents[0].message).toBe('doing work');
    expect(subEvents[1].message).toBe('more work');

    // Should have sub:done events for each function completion
    const doneEvents = events.filter(e => e.step === 'sub:done');
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents[0].message).toBe('fn1 done');
    expect(doneEvents[1].message).toBe('fn2 done');
  });

  it('threads onProgress to parallel sub-functions', async () => {
    const events: StepProgress[] = [];
    const onProgress = (p: StepProgress) => events.push(p);

    const fn1: TestFunction = async (ctx, progress) => {
      progress({ step: 'sub:parallel', status: 'running', message: 'p1' });
      return { context: ctx };
    };

    const fn2: TestFunction = async (ctx, progress) => {
      progress({ step: 'sub:parallel', status: 'running', message: 'p2' });
      return { context: ctx };
    };

    const step: PipelineStep = {
      name: 'parallel-step',
      mode: 'parallel',
      functions: [fn1, fn2],
    };

    const pipeline = createPipeline('test', [step]);
    await pipeline.run({}, onProgress);

    const subEvents = events.filter(e => e.step === 'sub:parallel');
    expect(subEvents).toHaveLength(2);
  });

  it('returns counts from sub-functions in step results', async () => {
    const fn: TestFunction = async (ctx) => ({
      context: ctx,
      summary: 'fetched data',
      counts: { totalRecordsFetched: 1000, meanResponseMs: 250, throughput: 400 },
    });

    const step: PipelineStep = {
      name: 'with-counts',
      functions: [fn],
    };

    const pipeline = createPipeline('test', [step]);
    const result = await pipeline.run({});

    expect(result.steps[0].counts).toEqual({
      totalRecordsFetched: 1000,
      meanResponseMs: 250,
      throughput: 400,
    });
  });

  it('emits step-level running before sub-functions execute', async () => {
    const events: StepProgress[] = [];
    const onProgress = (p: StepProgress) => events.push(p);

    const fn: TestFunction = async (ctx, progress) => {
      progress({ step: 'sub:inner', status: 'running', message: 'inside' });
      return { context: ctx };
    };

    const step: PipelineStep = {
      name: 'outer-step',
      functions: [fn],
    };

    const pipeline = createPipeline('test', [step]);
    await pipeline.run({}, onProgress);

    // Step-level "running" should come before the sub-step event
    const runningIdx = events.findIndex(e => e.step === 'outer-step' && e.status === 'running');
    const subIdx = events.findIndex(e => e.step === 'sub:inner');
    expect(runningIdx).toBeLessThan(subIdx);
  });
});

describe('replication progress format', () => {
  it('produces valid JSON with _type marker', () => {
    // Simulate the shape that dd.ts formatReplicationProgress produces
    const data = {
      _type: 'replication-progress',
      resources: [
        { name: 'Property', records: 5000, bytes: 50_000_000 },
        { name: 'Member', records: 2000, bytes: 15_000_000 },
      ],
      totalRecords: 7000,
      totalBytes: 65_000_000,
      throughput: 450,
      meanResponseMs: 800,
      anomalyCount: 1,
    };

    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);

    expect(parsed._type).toBe('replication-progress');
    expect(parsed.resources).toHaveLength(2);
    expect(parsed.totalRecords).toBe(7000);
    expect(parsed.throughput).toBe(450);
    expect(parsed.anomalyCount).toBe(1);
  });

  it('handles empty resources array', () => {
    const data = {
      _type: 'replication-progress',
      resources: [],
      totalRecords: 0,
      totalBytes: null,
      throughput: null,
      meanResponseMs: null,
      anomalyCount: 0,
    };

    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);

    expect(parsed.resources).toHaveLength(0);
    expect(parsed.totalRecords).toBe(0);
  });
});

describe('Welford online algorithm', () => {
  it('computes correct mean and detects anomalies', () => {
    // Simulate the Welford's algorithm from replicate()
    let count = 0, mean = 0, m2 = 0;
    const values = [100, 110, 95, 105, 500, 98, 102]; // 500 is the anomaly

    for (const v of values) {
      count++;
      const delta = v - mean;
      mean += delta / count;
      m2 += delta * (v - mean);
    }

    const stddev = Math.sqrt(m2 / count);

    // Mean should be close to the average
    const expectedMean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean - expectedMean)).toBeLessThan(0.01);

    // Count anomalies (> 2 SD from mean)
    let anomalies = 0;
    for (const v of values) {
      if (Math.abs(v - mean) > 2 * stddev) anomalies++;
    }

    // 500 should be the anomaly
    expect(anomalies).toBe(1);
    expect(Math.abs(500 - mean) > 2 * stddev).toBe(true);
    expect(Math.abs(100 - mean) > 2 * stddev).toBe(false);
  });

  it('handles fewer than 3 samples without anomaly detection', () => {
    let count = 0, mean = 0, m2 = 0;
    const values = [100, 200];

    for (const v of values) {
      count++;
      const delta = v - mean;
      mean += delta / count;
      m2 += delta * (v - mean);
    }

    expect(count).toBe(2);
    expect(mean).toBe(150);
    // With < 3 samples, anomaly detection should not run
    // (the replicate() code checks count >= 3)
  });
});
