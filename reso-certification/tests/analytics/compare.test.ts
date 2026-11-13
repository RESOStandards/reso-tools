import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_RESOURCES,
  type MetricChange,
  type RunMetrics,
  compareRunMetrics,
  compareRuns,
  findPreviousRun,
  isNoPreviousRunError,
  readRunMetrics,
  renderComparisonText,
  runMetricsFromReports,
  runPlacement
} from '../../src/analytics/index.js';
import { COMPARE_EXIT, compareExitCode } from '../../src/cli/analytics-command.js';

// Three Property fields from the DD 2.1 reference (standard) and one local field.
const STANDARD_A = 'AboveGradeFinishedArea';
const STANDARD_B = 'AboveGradeFinishedAreaSource';
const STANDARD_C = 'AboveGradeFinishedAreaUnits';
const LOCAL = 'LocalThing';

interface RunShape {
  readonly version?: string;
  readonly generatedOn: string;
  readonly fields: ReadonlyArray<string>;
  /** Field → records with a value, of `sampled`. */
  readonly frequency?: Readonly<Record<string, number>>;
  readonly sampled?: number;
  readonly averageMs?: number;
  readonly medianMs?: number;
  readonly averageBytes?: number;
  readonly samples?: number;
  readonly withAvailability?: boolean;
  readonly schemaErrors?: number;
}

const FIELD_TYPES: Readonly<Record<string, string>> = {
  [STANDARD_A]: 'Edm.Decimal',
  [STANDARD_B]: 'org.reso.metadata.enums.AreaSource',
  [STANDARD_C]: 'org.reso.metadata.enums.AreaUnits',
  [LOCAL]: 'Edm.String'
};

const metadataReport = (shape: RunShape): Record<string, unknown> => ({
  description: 'RESO Data Dictionary Metadata Report',
  version: shape.version ?? '2.1',
  generatedOn: shape.generatedOn,
  fields: shape.fields.map(fieldName => ({ resourceName: 'Property', fieldName, type: FIELD_TYPES[fieldName] })),
  lookups: []
});

const availabilityReport = (shape: RunShape): Record<string, unknown> => ({
  description: 'RESO Data Availability Report',
  version: shape.version ?? '2.1',
  generatedOn: shape.generatedOn,
  resources: [
    {
      resourceName: 'Property',
      numUniqueRecordsFetched: shape.sampled ?? 10,
      numRecordsFetched: shape.sampled ?? 10,
      numSamples: shape.samples ?? 2,
      averageResponseTimeMs: shape.averageMs ?? 200,
      medianResponseTimeMs: shape.medianMs ?? 180,
      averageResponseBytes: shape.averageBytes ?? 50_000
    }
  ],
  fields: shape.fields.map(fieldName => ({ resourceName: 'Property', fieldName, frequency: shape.frequency?.[fieldName] ?? 0 })),
  lookupValues: []
});

const metricsOf = (shape: RunShape, path = '/runs/x'): Promise<RunMetrics> =>
  runMetricsFromReports(
    {
      metadataReport: metadataReport(shape),
      ...(shape.withAvailability === false ? {} : { availabilityReport: availabilityReport(shape) }),
      ...(shape.schemaErrors ? { schemaErrorsReport: { totalErrors: shape.schemaErrors } } : {})
    },
    { path, endorsement: 'Data Dictionary', providerUoi: null, providerUsi: null, recipientUoi: null }
  );

const metricValue = (metrics: RunMetrics, id: string, scope = ALL_RESOURCES): number | null =>
  metrics.metrics.find(m => m.id === id && m.scope === scope)?.value ?? null;

const changeOf = (changes: ReadonlyArray<MetricChange>, id: string, scope = ALL_RESOURCES): MetricChange | undefined =>
  changes.find(c => c.id === id && c.scope === scope);

const BEFORE: RunShape = {
  generatedOn: '2026-11-01T00:00:00.000Z',
  fields: [STANDARD_A, STANDARD_B, LOCAL],
  frequency: { [STANDARD_A]: 10, [STANDARD_B]: 5, [LOCAL]: 0 },
  averageMs: 200
};

const AFTER: RunShape = {
  generatedOn: '2026-11-13T00:00:00.000Z',
  fields: [STANDARD_A, STANDARD_B, STANDARD_C, LOCAL],
  frequency: { [STANDARD_A]: 10, [STANDARD_B]: 10, [STANDARD_C]: 10, [LOCAL]: 4 },
  averageMs: 180
};

describe('runMetricsFromReports', () => {
  it('counts fields the way the certification site does, and rates them as percentages', async () => {
    const m = await metricsOf(BEFORE);
    expect(metricValue(m, 'fields.total')).toBe(3);
    expect(metricValue(m, 'fields.standard')).toBe(2);
    expect(metricValue(m, 'fields.local')).toBe(1);
    expect(metricValue(m, 'fields.standardRate')).toBeCloseTo(66.667, 2);
    expect(metricValue(m, 'fields.standardRate', 'Property')).toBeCloseTo(66.667, 2);
  });

  it('reads availability and performance from the availability report', async () => {
    const m = await metricsOf(BEFORE);
    expect(metricValue(m, 'fields.withData')).toBe(2);
    // The mean over the standard fields: 100% and 50%.
    expect(metricValue(m, 'fields.standardAvailability')).toBe(75);
    expect(metricValue(m, 'records.sampled')).toBe(10);
    expect(metricValue(m, 'responses.averageTime')).toBe(200);
    expect(metricValue(m, 'responses.medianTime', 'Property')).toBe(180);
    // 50,000 bytes in 0.2 s.
    expect(metricValue(m, 'responses.throughput')).toBe(250_000);
  });

  it('marks availability and performance as not measured, never zero, when the run has no availability report', async () => {
    const m = await metricsOf({ ...BEFORE, withAvailability: false });
    expect(m.run.measured.availability).toBe(false);
    expect(metricValue(m, 'responses.averageTime')).toBeNull();
    expect(metricValue(m, 'fields.withData')).toBeNull();
    expect(metricValue(m, 'fields.total')).toBe(3);
  });

  it('refuses a metadata report with no version', async () => {
    await expect(
      runMetricsFromReports(
        { metadataReport: { fields: [], lookups: [] } },
        { path: '/runs/x', endorsement: 'Data Dictionary', providerUoi: null, providerUsi: null, recipientUoi: null }
      )
    ).rejects.toThrow(/no version/);
  });
});

describe('compareRunMetrics', () => {
  it('states a rate change in points and a performance change in percent', async () => {
    const c = compareRunMetrics(await metricsOf(BEFORE), await metricsOf(AFTER));
    const rate = changeOf(c.changes, 'fields.standardRate');
    expect(rate?.unit).toBe('points');
    // 66.7% → 75.0%: up 8.3 points, not up 12.5%.
    expect(rate?.change).toBe(8.3);
    expect(rate?.verdict).toBe('better');
    const time = changeOf(c.changes, 'responses.averageTime');
    expect(time?.unit).toBe('percent');
    expect(time?.change).toBe(-10);
    expect(time?.verdict).toBe('better');
  });

  it('calls a neutral metric changed, never better or worse', async () => {
    const c = compareRunMetrics(await metricsOf(BEFORE), await metricsOf(AFTER));
    expect(changeOf(c.changes, 'fields.total')?.verdict).toBe('changed');
    expect(changeOf(c.changes, 'fields.standard')?.verdict).toBe('better');
  });

  it('calls an unchanged metric the same, and counts the verdicts', async () => {
    const c = compareRunMetrics(await metricsOf(BEFORE), await metricsOf(BEFORE));
    expect(c.summary.better).toBe(0);
    expect(c.summary.worse).toBe(0);
    expect(c.changes.every(change => change.verdict === 'same' || change.verdict === 'not-measured')).toBe(true);
  });

  it('calls slower responses and lost standard fields worse', async () => {
    const c = compareRunMetrics(await metricsOf(AFTER), await metricsOf({ ...BEFORE, averageMs: 400 }));
    expect(changeOf(c.changes, 'responses.averageTime')?.verdict).toBe('worse');
    expect(changeOf(c.changes, 'fields.standard')?.verdict).toBe('worse');
  });

  it('counts a timing within the tolerance as the same, and still says how far it moved', async () => {
    const c = compareRunMetrics(await metricsOf(BEFORE), await metricsOf({ ...BEFORE, averageMs: 204 }));
    const time = changeOf(c.changes, 'responses.averageTime');
    expect(time?.change).toBe(2);
    expect(time?.verdict).toBe('same');
    expect(renderComparisonText(c, { all: true })).toMatch(/Average response time\s+200 ms → 204 ms\s+2\.0% slower\s+same/);
    // Just past the tolerance it is a verdict again.
    expect(
      changeOf(compareRunMetrics(await metricsOf(BEFORE), await metricsOf({ ...BEFORE, averageMs: 212 })).changes, 'responses.averageTime')
        ?.verdict
    ).toBe('worse');
  });

  it('never counts a rate or a count as the same because it is small', async () => {
    const c = compareRunMetrics(
      await metricsOf(BEFORE),
      await metricsOf({ ...BEFORE, sampled: 10, frequency: { ...BEFORE.frequency, [STANDARD_B]: 6 } })
    );
    expect(changeOf(c.changes, 'fields.standardAvailability')?.verdict).toBe('better');
  });

  it('notes runs that test different Data Dictionary versions, and marks them not comparable', async () => {
    const c = compareRunMetrics(await metricsOf({ ...BEFORE, version: '2.0' }), await metricsOf(AFTER));
    expect(c.comparable).toBe(false);
    expect(c.notes.join(' ')).toMatch(/different Data Dictionary versions \(2\.0 and 2\.1\)/);
  });

  it('notes a run with no availability report, and calls what it lacks gone', async () => {
    const c = compareRunMetrics(await metricsOf(BEFORE), await metricsOf({ ...AFTER, withAvailability: false }));
    expect(c.notes.join(' ')).toMatch(/This run has no data availability report/);
    expect(changeOf(c.changes, 'responses.averageTime')?.verdict).toBe('gone');
  });
});

describe('renderComparisonText', () => {
  it('says every change in words, with its unit and verdict', async () => {
    const text = renderComparisonText(compareRunMetrics(await metricsOf(BEFORE), await metricsOf(AFTER)));
    expect(text).toMatch(/^Data Dictionary 2\.1/);
    expect(text).toMatch(/Field standardization\s+66\.7% → 75\.0%\s+up 8\.3 points\s+better/);
    expect(text).toMatch(/Average response time\s+200 ms → 180 ms\s+10\.0% faster\s+better/);
    expect(text).toMatch(/Standard fields\s+2 → 3\s+up 1\s+better/);
    expect(text).toMatch(/--json for the comparison as JSON \(schemaVersion 1\)/);
  });

  it('shows short times to a tenth of a millisecond, so two different times never print the same', async () => {
    const text = renderComparisonText(
      compareRunMetrics(await metricsOf({ ...BEFORE, averageMs: 8.3 }), await metricsOf({ ...BEFORE, averageMs: 7.9 })),
      { all: true }
    );
    expect(text).toMatch(/Average response time\s+8\.3 ms → 7\.9 ms/);
  });

  it('hides a resource’s unchanged metrics unless asked for all of them', async () => {
    const comparison = compareRunMetrics(await metricsOf(BEFORE), await metricsOf({ ...BEFORE, averageMs: 220 }));
    const quiet = renderComparisonText(comparison);
    const all = renderComparisonText(comparison, { all: true });
    expect(quiet).toMatch(/\(\d+ metrics unchanged\)/);
    expect(all).not.toMatch(/metrics? unchanged\)/);
    expect(all.split('\n').length).toBeGreaterThan(quiet.split('\n').length);
  });
});

describe('finding the previous run on disk', () => {
  let root = '';
  const connection = (): string => join(root, 'data-dictionary-2.1', 'PROVIDER-SYSTEM', 'RECIPIENT');

  const writeRun = async (dir: string, shape: RunShape): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata-report.json'), JSON.stringify(metadataReport(shape)));
    await writeFile(join(dir, 'data-availability-report.json'), JSON.stringify(availabilityReport(shape)));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reso-compare-'));
    await writeRun(join(connection(), 'current'), AFTER);
    await writeRun(join(connection(), 'archived', '2026-11-10T000000000Z'), BEFORE);
    await writeRun(join(connection(), 'archived', '2026-11-01T000000000Z'), BEFORE);
    // A newer archive with no metadata report is skipped: an interrupted run.
    await mkdir(join(connection(), 'archived', '2026-11-12T000000000Z'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the newest archived run with a metadata report for a current run', async () => {
    expect(await findPreviousRun(join(connection(), 'current'))).toBe(join(connection(), 'archived', '2026-11-10T000000000Z'));
  });

  it('finds the next older run for an archived one, and none for the oldest', async () => {
    expect(await findPreviousRun(join(connection(), 'archived', '2026-11-10T000000000Z'))).toBe(
      join(connection(), 'archived', '2026-11-01T000000000Z')
    );
    expect(await findPreviousRun(join(connection(), 'archived', '2026-11-01T000000000Z'))).toBeUndefined();
  });

  it('finds none for a run outside a results tree', async () => {
    expect(await findPreviousRun(root)).toBeUndefined();
  });

  it('reads the connection from where the run sits', async () => {
    const run = await readRunMetrics(join(connection(), 'current'));
    expect(run.run.providerUoi).toBe('PROVIDER');
    expect(run.run.providerUsi).toBe('SYSTEM');
    expect(run.run.recipientUoi).toBe('RECIPIENT');
    expect(runPlacement(root).providerUoi).toBeNull();
  });

  it('compares a run with the previous one it finds', async () => {
    const c = await compareRuns(join(connection(), 'current'));
    expect(c.before.path).toBe(join(connection(), 'archived', '2026-11-10T000000000Z'));
    expect(changeOf(c.changes, 'fields.standard')?.verdict).toBe('better');
    expect(compareExitCode()).toBe(COMPARE_EXIT.compared);
  });

  it('says there is no earlier run, with its own exit code', async () => {
    const oldest = join(connection(), 'archived', '2026-11-01T000000000Z');
    const error = await compareRuns(oldest).catch((e: unknown) => e);
    expect(isNoPreviousRunError(error)).toBe(true);
    expect(compareExitCode(error)).toBe(COMPARE_EXIT.noPreviousRun);
  });

  it('refuses a directory with no Data Dictionary run, with the error exit code', async () => {
    const error = await compareRuns(root, root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/has no metadata-report\.json/);
    expect(compareExitCode(error)).toBe(COMPARE_EXIT.failed);
  });

  it('calls a path that holds no run an error, not a run with nothing before it', async () => {
    const error = await compareRuns(join(root, 'no-such-run')).catch((e: unknown) => e);
    expect(isNoPreviousRunError(error)).toBe(false);
    expect(compareExitCode(error)).toBe(COMPARE_EXIT.failed);
  });
});
