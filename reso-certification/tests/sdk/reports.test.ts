import { describe, it, expect } from 'vitest';
import {
  serializeAddEditRemarks,
  serializeEntityEventRemarks,
  serializeCoreRemarks,
  createGenericReportGenerator,
  createDetailedReportGenerator,
  addEditReportGenerators,
  entityEventReportGenerators,
  coreReportGenerators,
} from '../../src/sdk/reports.js';
import type { PipelineResult, StepResult } from '../../src/sdk/types.js';

const makeResult = (overrides: Partial<PipelineResult> = {}): PipelineResult => ({
  status: 'passed',
  endorsement: 'test',
  steps: [],
  context: {},
  duration: 100,
  ...overrides,
});

const makeStep = (overrides: Partial<StepResult> = {}): StepResult => ({
  name: 'test-step',
  endorsement: 'test',
  status: 'passed',
  duration: 50,
  ...overrides,
});

describe('serializeAddEditRemarks', () => {
  it('summarizes passed results with field count', () => {
    const result = makeResult({
      context: { resource: 'Property' },
      steps: [
        makeStep({ name: 'Fetch metadata', counts: { fields: 632 } }),
        makeStep({ name: 'Run Add/Edit scenarios', counts: { total: 8, passed: 8, failed: 0 } }),
      ],
    });

    const remarks = serializeAddEditRemarks(result);

    expect(remarks).toContain('8 of 8');
    expect(remarks).toContain('632 fields');
    expect(remarks).toContain('Property');
  });

  it('includes failure info when tests fail', () => {
    const result = makeResult({
      status: 'failed',
      context: { resource: 'Property' },
      steps: [
        makeStep({ name: 'Run Add/Edit scenarios', counts: { total: 8, passed: 6, failed: 2 }, errors: ['create failed', 'delete failed'] }),
      ],
    });

    const remarks = serializeAddEditRemarks(result);

    expect(remarks).toContain('6 of 8');
    expect(remarks).toContain('create failed');
  });

  it('handles missing test step gracefully', () => {
    const result = makeResult({ status: 'failed' });
    const remarks = serializeAddEditRemarks(result);

    expect(remarks).toContain('failed');
  });
});

describe('serializeEntityEventRemarks', () => {
  it('includes mode and scenario counts', () => {
    const result = makeResult({
      context: { mode: 'full' },
      steps: [
        makeStep({ name: 'Run EntityEvent scenarios', counts: { total: 11, passed: 11 } }),
      ],
    });

    const remarks = serializeEntityEventRemarks(result);

    expect(remarks).toContain('11 of 11');
    expect(remarks).toContain('full mode');
  });
});

describe('serializeCoreRemarks', () => {
  it('includes all count categories', () => {
    const result = makeResult({
      steps: [
        makeStep({ counts: { total: 45, passed: 42, failed: 0, skipped: 3 } }),
      ],
    });

    const remarks = serializeCoreRemarks(result);

    expect(remarks).toContain('42 passed');
    expect(remarks).toContain('0 failed');
    expect(remarks).toContain('3 skipped');
  });
});

describe('createGenericReportGenerator', () => {
  it('produces Cert API compatible report shape', () => {
    const generator = createGenericReportGenerator('Web API Add/Edit', '2.0.0', () => 'test remarks');
    const report = generator.generate(makeResult());

    expect(report.description).toBe('Web API Add/Edit');
    expect(report.version).toBe('2.0.0');
    expect(report.generatedOn).toBeTruthy();
    expect(report.remarks).toBe('test remarks');
    // Should only have the 4 base fields
    expect(Object.keys(report)).toEqual(['description', 'version', 'generatedOn', 'remarks']);
  });

  it('has correct filename', () => {
    const generator = createGenericReportGenerator('Test', '1.0', () => '');
    expect(generator.filename).toBe('report.json');
    expect(generator.name).toBe('Generic');
  });
});

describe('createDetailedReportGenerator', () => {
  it('extends generic with outcome, steps, and duration', () => {
    const generator = createDetailedReportGenerator('Web API Add/Edit', '2.0.0', () => 'remarks');
    const result = makeResult({
      steps: [
        makeStep({ name: 'step-1', summary: 'did stuff', counts: { x: 1 } }),
      ],
    });

    const report = generator.generate(result);

    expect(report.description).toBe('Web API Add/Edit');
    expect(report.outcome).toBe('passed');
    expect(report.endorsement).toBe('test');
    expect(report.duration).toBe(100);
    expect(report.steps).toHaveLength(1);
    const step = (report.steps as ReadonlyArray<Record<string, unknown>>)[0];
    expect(step.name).toBe('step-1');
    expect(step.summary).toBe('did stuff');
    expect(step.counts).toEqual({ x: 1 });
  });

  it('has correct filename', () => {
    const generator = createDetailedReportGenerator('Test', '1.0', () => '');
    expect(generator.filename).toBe('report-detailed.json');
    expect(generator.name).toBe('Detailed');
  });

  it('omits empty optional fields from steps', () => {
    const generator = createDetailedReportGenerator('Test', '1.0', () => '');
    const result = makeResult({
      steps: [makeStep({ name: 'clean' })],
    });

    const report = generator.generate(result);
    const step = (report.steps as ReadonlyArray<Record<string, unknown>>)[0];

    expect(step).not.toHaveProperty('summary');
    expect(step).not.toHaveProperty('params');
    expect(step).not.toHaveProperty('errors');
  });
});

describe('createDetailedReportGenerator — resourceReports', () => {
  it('includes resourceReports from pipeline context when present', () => {
    const generator = createDetailedReportGenerator('Web API Core', '2.1.0', () => 'remarks');
    const result = makeResult({
      context: {
        resourceReports: [
          {
            resource: 'Property',
            summary: { total: 54, passed: 45, failed: 2, skipped: 7 },
            scenarios: [
              {
                name: 'Filter: eq integer',
                tag: 'filter-eq-integer',
                passed: true,
                skipped: false,
                duration: 120,
                requestUrl: 'http://localhost/Property?$filter=BedroomsTotal eq 3',
                assertions: [{ message: 'Status 200', passed: true }],
              },
              {
                name: 'String enum collection: all()',
                tag: 'string-enum-collection-all',
                passed: false,
                skipped: false,
                duration: 85,
                assertions: [{ message: '21 records failed validation', passed: false }],
              },
            ],
          },
        ],
      },
      steps: [makeStep({ name: 'Run Core scenarios' })],
    });

    const report = generator.generate(result);

    expect(report.resourceReports).toBeDefined();
    const rr = report.resourceReports as ReadonlyArray<Record<string, unknown>>;
    expect(rr).toHaveLength(1);
    expect(rr[0].resource).toBe('Property');
    expect(rr[0].summary).toEqual({ total: 54, passed: 45, failed: 2, skipped: 7 });

    const scenarios = rr[0].scenarios as ReadonlyArray<Record<string, unknown>>;
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].name).toBe('Filter: eq integer');
    expect(scenarios[0].passed).toBe(true);
    expect(scenarios[1].passed).toBe(false);
  });

  it('maps assertion message field to description in serialized output', () => {
    const generator = createDetailedReportGenerator('Web API Core', '2.1.0', () => '');
    const result = makeResult({
      context: {
        resourceReports: [
          {
            resource: 'Property',
            summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
            scenarios: [
              {
                name: 'Test scenario',
                tag: 'test',
                passed: false,
                skipped: false,
                duration: 50,
                assertions: [{ message: 'Expected 200 but got 400', passed: false }],
              },
            ],
          },
        ],
      },
      steps: [],
    });

    const report = generator.generate(result);
    const rr = report.resourceReports as ReadonlyArray<Record<string, unknown>>;
    const scenarios = rr[0].scenarios as ReadonlyArray<Record<string, unknown>>;
    const assertions = scenarios[0].assertions as ReadonlyArray<Record<string, unknown>>;

    expect(assertions[0].description).toBe('Expected 200 but got 400');
    expect(assertions[0].passed).toBe(false);
  });

  it('omits resourceReports when not present in context', () => {
    const generator = createDetailedReportGenerator('Web API Add/Edit', '2.0.0', () => '');
    const result = makeResult({ steps: [] });

    const report = generator.generate(result);

    expect(report).not.toHaveProperty('resourceReports');
  });
});

describe('pre-built report generator sets', () => {
  it('addEditReportGenerators produces 2 generators', () => {
    const generators = addEditReportGenerators('2.0.0');
    expect(generators).toHaveLength(2);
    expect(generators[0].name).toBe('Generic');
    expect(generators[1].name).toBe('Detailed');
  });

  it('entityEventReportGenerators produces 2 generators', () => {
    const generators = entityEventReportGenerators('RCP-027');
    expect(generators).toHaveLength(2);
  });

  it('coreReportGenerators produces 2 generators', () => {
    const generators = coreReportGenerators('2.0.0');
    expect(generators).toHaveLength(2);
  });
});
