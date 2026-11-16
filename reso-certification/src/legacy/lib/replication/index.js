'use strict';

const { readFile, writeFile, mkdir } = require('fs/promises');
const { join, normalize, resolve } = require('path');
const { existsSync } = require('fs');

const { REPLICATION_STRATEGIES, fetchTopLevelResourceCount, describeSchemaErrors } = require('./utils');
const { NOT_OK, getLoggers } = require('../../common');

const { replicationIterator } = require('./replication-iterator');

const authService = require('./services/auth/oauth2');

const { generateJsonSchema, validate, VALIDATION_CONFIG_FILE } = require('../schema');

const {
  DEFAULT_DD_VERSION,
  handleError,
  scorePayload,
  writeAnalyticsReports,
  withoutBoundaryRepeats,
  describeRecordDeduplication,
  removeSchemaValidationWarningsReport,
  writeSchemaValidationErrorReport,
  writeSchemaValidationWarningsReport,
  getSystemRuntimeInfo,
  prepareRequests,
  buildOutputFilePath
} = require('./utils');

const { createReplicationStateServiceInstance } = require('../../common');

const DEFAULT_RATE_LIMITED_WAIT_MINUTES = 60,
  DEFAULT_SECONDS_DELAY_BETWEEN_REQUEST = 1;

/**
 * Prepares a filter expression, accounting for OriginatingSystemName or ID
 * @param {String} filter filter expression to use
 * @param {Object} options object containing filter options
 * @returns adjusted filter with OriginatingSystemName or ID, when present
 */
const prepareFilterExpression = (filter, { originatingSystemId, originatingSystemName }) => {
  const filters = [];

  if (filter && filter?.length) {
    filters.push(filter);
  }

  if (originatingSystemName && originatingSystemName?.length) {
    filters.push(`OriginatingSystemName eq '${originatingSystemName}'`);
  } else if (originatingSystemId && originatingSystemId?.length) {
    filters.push(`OriginatingSystemID eq '${originatingSystemId}'`);
  }

  return filters && filters?.length ? filters.join(' and ') : null;
};

/**
 * What a page handler tells the driver to do with the walk the page came from.
 */
const PAGE_VERDICTS = Object.freeze({
  /** Ask the walk for its next page. */
  CONTINUE: 'continue',
  /** The walk is done (it reached the record limit); go on to the next walk. */
  STOP_WALK: 'stopWalk'
});

/**
 * @typedef {Object} ReplicationJob one strategy's pass over the run's resources and expansions
 * @property {String} strategy one of REPLICATION_STRATEGIES
 * @property {String} [filter] the $filter for every request of this job
 * @property {Number} [top] the $top for every request of this job
 * @property {String} [orderby] the $orderby for every request of this job
 * @property {Number} [maxPageSize] the page size asked for with the Prefer header (NextLink)
 * @property {String} [label] the caller's name for the job; when given, the progress payload carries it as `jobLabel`
 */

/**
 * Everything a run prepares once, whatever the number of jobs: its services, the metadata report, the JSON schema
 * and the state's metadata map.
 *
 * @param {Object} options the run's options, as given to replicateJobs
 * @returns the metadata report, the expansions as an array and, with schema validation, the schema and its settings
 */
const prepareRun = async ({
  REPLICATION_STATE_SERVICE,
  bearerToken,
  clientCredentials,
  expansions: expansionArrayOrCommaSeparatedString,
  metadataReportJson,
  pathToMetadataReportJson,
  jsonSchemaValidation,
  LOG
}) => {
  //initialize services, if needed
  REPLICATION_STATE_SERVICE.init();
  await authService.init({ bearerToken, clientCredentials });

  // expansions will be a comma-separated list if passed from the command line and array if called from a library
  const expansionsArray = Array.isArray(expansionArrayOrCommaSeparatedString)
    ? expansionArrayOrCommaSeparatedString
    : expansionArrayOrCommaSeparatedString?.split(',').map(x => x?.trim()) || [];

  // load metadata report if it's been passed in as a path
  const metadataReport =
    !pathToMetadataReportJson && !!metadataReportJson
      ? metadataReportJson
      : JSON.parse(await readFile(pathToMetadataReportJson, { encoding: 'utf8' }));

  // this needs to be done only once, and only if we're using schema validation
  // TODO: consider passing in when needed instead
  let generatedSchema, validationConfig;

  if (jsonSchemaValidation) {

    LOG('\nJSON Schema option passed. Generating schema...');

    generatedSchema = await generateJsonSchema({
      additionalProperties: false,
      metadataReportJson: metadataReport
    });

    validationConfig = JSON.parse(await readFile(VALIDATION_CONFIG_FILE)) || {};

    LOG('JSON Schema generation complete!');

  }

  REPLICATION_STATE_SERVICE.setMetadataMap(metadataReport);

  return { expansionsArray, metadataReport, generatedSchema, validationConfig };
};

/**
 * Turns each job into its requests: one per resource and expansion, built with that job's own filter, $top and
 * $orderby. The jobs keep the order they were given in and each job's requests keep prepareRequests' order, and the
 * driver walks them in that order (job-major, request-minor). That order is what fixes the responses report.
 *
 * @param {Object} options the jobs, what prepareRun returned, and the run's request options
 * @returns the jobs, each with its position in the run and its requests
 */
const createJobs = async ({
  jobs,
  run: { metadataReport, expansionsArray },
  serviceRootUri,
  resourceName,
  batchExpand,
  originatingSystemId,
  originatingSystemName
}) =>
  Promise.all(
    jobs.map(async (job, index) => ({
      ...job,
      index,
      // TODO: if scoring, need to group by similar resources/expansions
      // so we only hold one set of record hashes in memory at a time
      requests: await prepareRequests({
        serviceRootUri,
        metadataReportJson: metadataReport,
        resourceName,
        expansions: expansionsArray,
        filter: prepareFilterExpression(job.filter, { originatingSystemId, originatingSystemName }),
        top: job.top,
        orderby: job.orderby,
        batchExpand
      })
    }))
  );

/**
 * Runs each job to its end before the next one starts, and within a job each walk to its end before the next: the
 * order the separate replicate() calls of a Data Dictionary run had.
 *
 * This is the part that rotation replaces (phase 2 of the 0.14.0 plan). It knows nothing about pages, reports or
 * state: it is given the four things a run does (start a job, open a walk, handle a page, end a job) and decides
 * only when each happens.
 *
 * A walk that fails ends its job. `abandonJob` decides what that means: it throws when the run reports errors by
 * throwing, and otherwise the job is left without its end (no merge, no reports) and the next job starts, which is
 * what the next replicate() call did after one that logged its error and returned.
 *
 * @param {Object} steps the jobs from createJobs and the run's four steps
 */
const driveSequentially = async ({ jobs, startJob, openWalk, handlePage, endJob, abandonJob }) => {
  for (const job of jobs) {
    try {
      const jobState = await startJob(job);
      let isAbandoned = false;

      // Each resource and expansion will have its separate set of requests
      for (const request of job.requests) {
        try {
          const walk = await openWalk({ job, jobState, request });
          for await (const page of walk.pages) {
            if ((await handlePage(walk, page)) === PAGE_VERDICTS.STOP_WALK) break;
          }
        } catch (err) {
          abandonJob(err);
          isAbandoned = true;
          break;
        }
      }

      if (!isAbandoned) await endJob(job, jobState);
    } catch (err) {
      // Names the job an error came from, so a caller of several jobs can say which strategy stopped the run. The
      // message and everything else on the error are left as thrown.
      if (typeof err === 'object' && err !== null && !err.replicationJob) {
        err.replicationJob = { index: job.index, strategy: job.strategy, label: job.label };
      }
      throw err;
    }
  }
};

/**
 * Replicates data from the given OData service root with one or more jobs, each a replication strategy with its own
 * request options, on one run's state.
 *
 * It does what one replicate() call per job did, in the same order: the jobs run one after another, and each one
 * ends as a call ended, with its schema findings merged into the run's state and the reports written. So a run that
 * stops in a later job leaves on disk what the earlier jobs wrote.
 *
 * @param {Object} args the run's options: those of replicate(), with `jobs` in place of the strategy and its options
 * @param {ReplicationJob[]} args.jobs the jobs, in the order to run them
 * @returns this function has no return value, but will produce side effects if outputPath is used (will write files)
 */
const replicateJobs = async ({
  jobs,
  serviceRootUri,
  bearerToken,
  clientCredentials = {},
  outputPath,
  limit,
  resourceName,
  expansions,
  metadataReportJson = {},
  pathToMetadataReportJson = '',
  rateLimitedWaitTimeMinutes = DEFAULT_RATE_LIMITED_WAIT_MINUTES,
  secondsDelayBetweenRequests = DEFAULT_SECONDS_DELAY_BETWEEN_REQUEST,
  shouldGenerateReports = true,
  jsonSchemaValidation = false,
  fromCli = false,
  version = DEFAULT_DD_VERSION,
  // Strict by default, matching this module's README and the legacy CLI's own -S default. Only this
  // function default had drifted to false, so a caller that omitted the option got the opposite of
  // what both of those documented.
  strictMode = true,
  originatingSystemName,
  originatingSystemId,
  // No default state: the factory throws without a record set, which only the caller that owns the run can size.
  // A caller passes the state it created with createReplicationStateServiceInstance({ recordKeySet }).
  REPLICATION_STATE_SERVICE = createReplicationStateServiceInstance(),
  // The software that wrote the reports, stamped into the availability report. The caller passes it; absent, the
  // report carries none rather than a guess.
  softwareVersion,
  shouldSaveResults = false,
  batchExpand = false,
  throwOnError = false,
  onProgress = () => {}
}) => {

  const { LOG, LOG_ERROR } = getLoggers(fromCli);

  try {
    if (!Array.isArray(jobs) || !jobs.length) {
      throw new Error('No replication jobs were given!');
    }

    // error if unknown strategy is specified
    const unknownJob = jobs.find(job => !Object.values(REPLICATION_STRATEGIES).includes(job?.strategy));
    if (unknownJob !== undefined) {
      throw new Error(`Unknown strategy: '${unknownJob?.strategy}'!`);
    }

    const run = await prepareRun({
      REPLICATION_STATE_SERVICE,
      bearerToken,
      clientCredentials,
      expansions,
      metadataReportJson,
      pathToMetadataReportJson,
      jsonSchemaValidation,
      LOG
    });

    const { generatedSchema, validationConfig } = run;

    /**
     * What one job holds while it runs: its own schema validation results, merged into the run's state at its end,
     * and the time it started.
     */
    const startJob = async ({ strategy }) => {
      //TODO: switch to logger
      LOG(`\nReplicating data from '${serviceRootUri}' with strategy '${strategy}'!`);

      const startTime = new Date();

      if (shouldSaveResults) {
        const resolvedPath = resolve(normalize(outputPath));
        if (!existsSync(resolvedPath)) {
          await mkdir(resolvedPath, { recursive: true });
        }
      }

      return { schemaValidationResults: {}, startTime, startTimeIsoTimestamp: startTime.toISOString() };
    };

    /**
     * Opens one walk: one job's pass over one resource or expansion. Everything here belongs to the walk and goes
     * with it: the running response-time figures, the progress clock, the boundary window and the iterator, whose
     * error count is the walk's own.
     */
    const openWalk = async ({ job, jobState, request }) => {
      const { requestUri: initialRequestUri, resourceName } = request;

      // get top-level resource count if needed
      if (!REPLICATION_STATE_SERVICE.checkIfTopLevelResourceCountExists(resourceName)) {
        REPLICATION_STATE_SERVICE.setTopLevelResourceCount(
          resourceName,
          await fetchTopLevelResourceCount({
            resourceName,
            serviceRootUri,
            filter: prepareFilterExpression(job.filter, { originatingSystemId, originatingSystemName }),
            authService
          })
        );
      }

      return {
        job,
        jobState,
        request,
        resourceName,
        // Welford's online algorithm — O(1) per update for running mean / variance.
        // Global aggregates feed the chart header. Anomaly detection is per-resource
        // (see byResourceStats below) since resources have very different
        // response-time distributions — a single global threshold misses slow
        // Property responses and false-flags fast Lookups. See #206.
        wCount: 0,
        wMean: 0,
        wM2: 0,
        wAnomalyCount: 0,
        // Per-resource Welford state + anomaly tracking. One-sided slow-only
        // threshold (`rt - mean > 2 * stddev`) so cache hits / 304s / empty
        // pages don't count.
        // Shape: { [resourceName]: { count, mean, M2, anomalyCount,
        //                            maxAnomalyMs, maxAnomalyDelta } }
        byResourceStats: {},
        // What the page before left for this walk's schema validation to skip. One walk, one page: see
        // withoutBoundaryRepeats before changing its scope.
        boundaryWindow: {},
        lastProgressTime: 0,
        replicationStartTime: Date.now(),
        pages: replicationIterator({
          initialRequestUri,
          strategy: job.strategy,
          limit,
          maxPageSize: job.maxPageSize,
          secondsDelayBetweenRequests,
          authService
        })
      };
    };

    const PROGRESS_INTERVAL_MS = 500;

    /**
     * Handles one page of one walk: the running figures and the progress update, then the page itself (an error to
     * handle, or records to validate, score and save), then the record limit.
     */
    const handlePage = async (
      walk,
      { hasResults = false, hasError = false, responseJson = {}, totalRecordsFetched = 0, requestUri, ...otherIteratorInfo }
    ) => {
      const { job, jobState, request, resourceName, byResourceStats } = walk;
      const { strategy } = job;

      // Update running stats
      const responseTimeMs = otherIteratorInfo.responseTimeMs ?? 0;
      if (responseTimeMs > 0) {
        // Global running mean — drives the header "avg" display
        // and the backward-compat fields. No longer used for the
        // anomaly check.
        walk.wCount++;
        const delta = responseTimeMs - walk.wMean;
        walk.wMean += delta / walk.wCount;
        const delta2 = responseTimeMs - walk.wMean;
        walk.wM2 += delta * delta2;

        // Per-resource Welford + one-sided slow-only anomaly check.
        const rn = resourceName ?? 'unknown';
        if (!byResourceStats[rn]) byResourceStats[rn] = {
          count: 0, mean: 0, M2: 0,
          anomalyCount: 0, maxAnomalyMs: 0, maxAnomalyDelta: 0,
        };
        const s = byResourceStats[rn];
        s.count++;
        const rDelta = responseTimeMs - s.mean;
        s.mean += rDelta / s.count;
        const rDelta2 = responseTimeMs - s.mean;
        s.M2 += rDelta * rDelta2;

        if (s.count >= 3) {
          const rStddev = Math.sqrt(s.M2 / s.count);
          if (responseTimeMs - s.mean > 2 * rStddev) {
            s.anomalyCount++;
            walk.wAnomalyCount++;
            if (responseTimeMs > s.maxAnomalyMs) {
              s.maxAnomalyMs = responseTimeMs;
              s.maxAnomalyDelta = responseTimeMs - s.mean;
            }
          }
        }
      }

      // Debounce progress updates
      const now = Date.now();
      if (now - walk.lastProgressTime >= PROGRESS_INTERVAL_MS) {
        walk.lastProgressTime = now;
        const topLevelCount = REPLICATION_STATE_SERVICE.checkIfTopLevelResourceCountExists(resourceName)
          ? Number(REPLICATION_STATE_SERVICE.getTopLevelResourceCounts()[resourceName])
          : null;
        const hasCount = topLevelCount != null && !isNaN(topLevelCount);
        const hasLimit = limit != null && !isNaN(Number(limit));
        const target = hasCount && hasLimit
          ? Math.min(topLevelCount, Number(limit))
          : hasLimit ? Number(limit) : hasCount ? topLevelCount : null;
        const elapsedSec = (now - walk.replicationStartTime) / 1000;
        const throughput = elapsedSec > 0 ? totalRecordsFetched / elapsedSec : 0;

        // Aggregate stats across all strategies from the state service
        const allResponses = REPLICATION_STATE_SERVICE.getResponses();
        const globalRecordsFetched = allResponses.reduce((sum, r) => sum + (r.recordCount ?? 0), 0);
        const globalBytes = allResponses.reduce((sum, r) => sum + (r.responseBytes ?? 0), 0);

        // Per-resource breakdown
        const byResource = {};
        for (const r of allResponses) {
          const rn = r.resourceName ?? 'unknown';
          if (!byResource[rn]) byResource[rn] = { resourceName: rn, recordCount: 0, bytes: 0 };
          byResource[rn].recordCount += r.recordCount ?? 0;
          byResource[rn].bytes += r.responseBytes ?? 0;
        }
        // Merge per-resource Welford state for any resource that's
        // been seen in the response stream. Resources without timed
        // responses stay without these fields (UI handles absence).
        for (const rn of Object.keys(byResource)) {
          const s = byResourceStats[rn];
          if (s && s.count > 0) {
            byResource[rn].meanMs = Math.round(s.mean);
            byResource[rn].anomalyCount = s.anomalyCount;
            if (s.anomalyCount > 0) {
              byResource[rn].maxAnomalyMs = Math.round(s.maxAnomalyMs);
              byResource[rn].maxAnomalyDelta = Math.round(s.maxAnomalyDelta);
            }
          }
        }
        const resourceStats = Object.values(byResource);

        onProgress({
          resourceName,
          totalRecordsFetched: globalRecordsFetched,
          totalBytes: globalBytes,
          resourceStats,
          pagesFetched: otherIteratorInfo.pagesFetched ?? 0,
          strategy,
          target,
          meanResponseMs: Math.round(walk.wMean),
          throughput: Math.round(throughput),
          anomalyCount: walk.wAnomalyCount,
          totalRequests: walk.wCount,
          // Two jobs can use one strategy (the natural-order walk and the lookback walk are both NextLink), so a
          // caller that names its jobs is told which one this page belongs to.
          ...(job.label ? { jobLabel: job.label } : {})
        });
      }

      //handle errors
      if (hasError) {
        const { error } = otherIteratorInfo;
        // some errors, like HTTP 429, might be able to be handled
        await handleError({ error, rateLimitedWaitTimeMinutes });
      } else if (hasResults) {
        if (jsonSchemaValidation) {
          const unrepeated = withoutBoundaryRepeats({ jsonData: responseJson, strategy, window: walk.boundaryWindow });
          walk.boundaryWindow = unrepeated.window;

          jobState.schemaValidationResults =
            validate({
              version,
              jsonPayload: unrepeated.jsonData,
              errorMap: jobState.schemaValidationResults,
              jsonSchema: generatedSchema,
              resourceName,
              validationConfig,
              // replicated over the provider's Web API → transport rules (#298): maxLength is a MUST
              // whether or not the page carries @reso.context; the context is validated when present.
              acquisition: 'transport'
            }) ?? {};

          // One line per page that has errors, carrying the totals and the per-class breakdown. A page
          // with errors that printed nothing would read as a page that passed.
          const schemaReport = describeSchemaErrors({ errorMap: jobState.schemaValidationResults, resourceName });
          if (schemaReport.line) LOG_ERROR(schemaReport.line);

          const hasValidationErrors = schemaReport.totals !== null;

          if (hasValidationErrors) {
            if (strictMode) {
              await writeSchemaValidationErrorReport({ outputPath, errorMap: jobState.schemaValidationResults });
              if (throwOnError) {
                // The totals travel in the message as well as the attached results: a caller that only
                // surfaces `err.message` otherwise reports a failure with no magnitude.
                const err = new Error(`Schema validation errors found in the ${resourceName} payload: ${schemaReport.totals}`);
                err.schemaValidationResults = jobState.schemaValidationResults;
                throw err;
              }
              LOG_ERROR('Exiting!');
              process.exit(NOT_OK);
            }
          }
        }

        if (shouldGenerateReports) {
          scorePayload({
            ...request,
            ...otherIteratorInfo,
            requestUri,
            // Recorded on the response entry, so a reader can tell which strategy fetched a page without
            // working it out from the URL. scorePayload always read it; it was never passed.
            strategy,
            jsonData: responseJson,
            hasError,
            replicationStateServiceInstance: REPLICATION_STATE_SERVICE
          });
        }

        if (shouldSaveResults) {
          REPLICATION_STATE_SERVICE.incrementResourcePageCount(resourceName);

          const resultsPath = buildOutputFilePath({ outputPath, isoTimestamp: jobState.startTimeIsoTimestamp, resourceName });
          await mkdir(resultsPath, { recursive: true });
          await writeFile(
            resolve(normalize(join(resultsPath, `page-${REPLICATION_STATE_SERVICE.getResourcePageCount(resourceName)}.json`))),
            JSON.stringify(responseJson)
          );
        }
      }

      if (!!limit && totalRecordsFetched >= limit) {
        LOG(`Reached specified record limit of ${limit}\n`);
        return PAGE_VERDICTS.STOP_WALK;
      }

      return PAGE_VERDICTS.CONTINUE;
    };

    /**
     * What a walk's error does to its job. With throwOnError, a mid-run error (a strictMode schema-validation throw,
     * or a parse/scoring failure) goes to the top-level catch so the caller's exit code reflects it, instead of
     * silently ending the job and resolving as success (which defeated --strict). Log only when swallowing
     * (throwOnError false); on a rethrow the top-level catch logs it once.
     */
    const abandonJob = err => {
      if (throwOnError) throw err;
      LOG_ERROR(err);
    };

    /**
     * Ends one job as a replicate() call ended: the merge into the run's state, the errors and warnings files, the
     * analytics reports, and the record-deduplication line.
     */
    const endJob = async (_job, jobState) => {
      // The reports describe the run, not this call. Each strategy is a separate call with a map of its own, and
      // writing from that map left the reports describing the last strategy alone. So a call that reaches this point
      // merges its results into the run's state, and the reports below are written from the merged results. The merge
      // never sums a count across strategies (see ./schema-results).
      //
      // Both modes reach this point. Relaxed mode arrives with whatever it found. Strict mode stopped above at the
      // first page with an error and reported that call's own results, so it arrives here only when the call had no
      // error, with its warnings: warnings never fail a strict run, so they accumulate.
      const schemaValidationResults = jsonSchemaValidation
        ? REPLICATION_STATE_SERVICE.accumulateSchemaValidationResults(jobState.schemaValidationResults)
        : jobState.schemaValidationResults;

      if (shouldGenerateReports) {
        try {
          // Each report is written on its own terms rather than as an either/or. These were once
          // exclusive, which meant any run that found errors produced the error file and NOTHING
          // else — no warnings file, no availability analytics. That is backwards for the mode the
          // errors belong to: a relaxed run exists precisely to survey a feed, so the run that has
          // the most to report was the one that reported the least.
          if (jsonSchemaValidation && schemaValidationResults?.stats?.totalErrors > 0) {
            await writeSchemaValidationErrorReport({ outputPath, errorMap: schemaValidationResults });
            // The errors file now carries the run's warnings, so a warnings file an earlier strategy wrote, when the
            // run had no errors yet, is out of date. A run with nothing to report still writes neither file.
            await removeSchemaValidationWarningsReport({ outputPath });
          }
          // #298 — the transport-path context findings are warnings until DD 3.0 and were otherwise invisible.
          if (jsonSchemaValidation && schemaValidationResults?.stats?.totalWarnings > 0) {
            await writeSchemaValidationWarningsReport({ outputPath, errorMap: schemaValidationResults });
          }
          await writeAnalyticsReports({
            outputPath,
            version,
            softwareVersion,
            serviceRootUri,
            replicationStateService: REPLICATION_STATE_SERVICE
          });
        } catch (err) {
          LOG_ERROR(`Could not write report! ${err}`);
          if (throwOnError) throw err;
          process.exit(NOT_OK);
        }
      }

      // Everything the record set knows about itself, once per call. The report carries only whether its totals
      // are a floor.
      LOG(describeRecordDeduplication(REPLICATION_STATE_SERVICE));

      if (fromCli) {
        getSystemRuntimeInfo({
          version,
          startTime: jobState.startTime,
          resourceAvailabilityMap: REPLICATION_STATE_SERVICE.getResourceAvailabilityMap()
        });
      }
    };

    await driveSequentially({
      jobs: await createJobs({ jobs, run, serviceRootUri, resourceName, batchExpand, originatingSystemId, originatingSystemName }),
      startJob,
      openWalk,
      handlePage,
      endJob,
      abandonJob
    });
  } catch (err) {
    // Log only when swallowing. That is the rule the inner catches state and defer to this one for,
    // and this one did not follow it: it inspected the error object and then rethrew, so a caller that
    // reports the failure properly got it reported twice -- once as its own summary line, and once as
    // a stack trace with the entire validation result dumped beneath it. For a strict-mode schema
    // failure, which is an expected outcome of a certification run rather than a fault, that reads as
    // a crash. Every caller of the rethrow reports it: the Data Dictionary pipeline as a failed step,
    // the replicate command as a one-line message.
    if (throwOnError) throw err;
    LOG_ERROR(err);
    process.exit(NOT_OK);
  }
};

/**
 * Replicates data from the given OData request URL using the given strategy, credentials, and options
 *
 * One job: the strategy and its request options. Everything else is the run's, and replicateJobs documents it.
 *
 * @param {Object} args this function takes multiple parameters
 * @returns this function has no return value, but will produce side effects if outputPath is used (will write files)
 */
const replicate = async ({ strategy, filter, top, orderby, maxPageSize, ...runOptions }) =>
  replicateJobs({ ...runOptions, jobs: [{ strategy, filter, top, orderby, maxPageSize }] });

module.exports = {
  replicate,
  replicateJobs
};
