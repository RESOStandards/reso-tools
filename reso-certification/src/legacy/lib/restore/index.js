'use strict';

//const conf = new (require('conf'))();
const chalk = require('chalk');
const { promises: fs } = require('fs');
const { resolve, join } = require('path');
const { getOrgsMap, getOrgSystemsMap, processDataDictionaryResults } = require('../misc/data-access/cert-api-client');
const { CERTIFICATION_FILES } = require('../../common');

const { processLookupResourceMetadataFiles } = require('../../../etl/index.cjs');

const CERTIFICATION_RESULTS_DIRECTORY = 'current',
  PATH_DATA_SEPARATOR = '-';

const IGNORED_SYSTEM_FILES = ['.DS_Store'];

const areRequiredFilesPresent = (fileNames = []) =>
  fileNames.filter(fileName =>
    [CERTIFICATION_FILES.METADATA_REPORT, CERTIFICATION_FILES.DATA_AVAILABILITY_REPORT].find(f => fileName === f)
  ).length === 2;

const readDirectory = async (path = '') => {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
};

const readFile = async filePath => {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    console.error(`Could not read file from path '${filePath}'! Error: ${err}`);
  }
};

/**
 * Determines whether the given path is an S3 path
 * @param {String} path the path to test
 * @returns true if S3 path, false otherwise
 */
const isS3Path = (path = '') => path.trim().toLowerCase().startsWith('s3://');

/**
 * Determines whether the given path is a valid local file path
 * @param {String} path the path to test
 * @returns true if valid local path, false otherwise
 */
const isLocalPath = (path = '') => !isS3Path(path);

const fetchOrgData = async () => {
  //fetch org data
  console.log(chalk.cyanBright.bold('\nFetching org data...'));
  const orgMap = (await getOrgsMap()) || {};
  if (!Object.keys(orgMap)?.length) throw new Error('Error: could not fetch orgs!');
  console.log(chalk.cyanBright.bold('Done!'));
  return orgMap;
};

const fetchSystemData = async () => {
  //fetch system data
  console.log(chalk.cyanBright.bold('\nFetching system data...'));
  const orgSystemMap = (await getOrgSystemsMap()) || {};
  if (!Object.keys(orgSystemMap)?.length) throw new Error('Error: could not fetch systems!');
  console.log(chalk.cyanBright.bold('Done!'));
  return orgSystemMap;
};

const isValidUrl = url => {
  try {
    new URL(url);
    return true;
  } catch {
    console.log(chalk.redBright.bold(`Error: Cannot parse given url: ${url}`));
    return false;
  }
};

/**
 * Restores a RESO Certification Server from either a local or S3 path.
 * @param {String} path
 * @throws Error if path is not a valid S3 or local path
 */
const restore = async (options = {}) => {
  const START_TIME = new Date();

  const STATS = {
    processed: [],
    skippedProviderUoiPaths: [],
    skippedUsiPaths: [],
    skippedRecipientPaths: [],
    missingResultsPaths: [],
    missingResultsFilePaths: []
  };

  const { pathToResults, url } = options;

  if (isS3Path(pathToResults)) {
    console.log(chalk.redBright.bold(`S3 path provided but not supported at this time!\nPath: ${pathToResults}`));
    return;
  }

  if (!isValidUrl(url)) return;

  console.log(chalk.bold(`\nCertification API URL: ${url}`));
  console.log(chalk.bold(`Path to results: ${pathToResults}`));

  if (isLocalPath(pathToResults)) {
    const orgMap = await fetchOrgData();
    const orgSystemMap = await fetchSystemData();

    console.log(chalk.greenBright.bold('\nRestore process starting...'));

    const providerUoiAndUsiPaths = await readDirectory(pathToResults);

    if (!providerUoiAndUsiPaths?.length) {
      console.log(chalk.redBright.bold(`Error: Could not find provider UOI and USI paths in '${pathToResults}'`));
      return;
    }

    for await (const providerUoiAndUsiPath of providerUoiAndUsiPaths) {
      const [providerUoi, providerUsi] = providerUoiAndUsiPath.split(PATH_DATA_SEPARATOR);

      if (!(IGNORED_SYSTEM_FILES.includes(providerUoi) || IGNORED_SYSTEM_FILES.includes(providerUsi))) {
        //is provider UOI valid?
        if (!orgMap[providerUoi]) {
          console.warn(chalk.redBright.bold(`Error: Could not find providerUoi '${providerUoi}'! Skipping...`));
          STATS.skippedProviderUoiPaths.push(providerUoi);
          break;
        }

        //is provider USI valid?
        const systems = orgSystemMap[providerUoi] || [];
        if (!systems?.length) {
          console.warn(chalk.redBright.bold(`Error: Could not find systems for providerUoi '${providerUoi}'! Skipping...`));
          STATS.skippedProviderUoiPaths.push(providerUoi);
        } else {
          if (!systems.find(system => system === providerUsi)) {
            console.log(`Error: Could not find system ${providerUsi} for providerUoi '${providerUoi}'! Skipping...`);
            STATS.skippedUsiPaths.push(providerUsi);
            break;
          }

          //read subdirectories
          const pathToRecipientResults = join(pathToResults, providerUoiAndUsiPath);
          const recipientUoiPaths = await readDirectory(pathToRecipientResults);

          if (!recipientUoiPaths?.length) {
            console.log(chalk.redBright.bold(`Error: Could not find recipient paths for ${providerUoiAndUsiPath}! Skipping...`));
            break;
          }

          for await (const recipientUoi of recipientUoiPaths) {
            if (!IGNORED_SYSTEM_FILES.includes(recipientUoi)) {
              console.log(
                chalk.cyanBright.bold(
                  `\nProcessing results for providerUoi: '${providerUoi}', providerUsi: '${providerUsi}', recipientUoi: '${recipientUoi}'...`
                )
              );

              if (!orgMap[recipientUoi]) {
                console.log(chalk.redBright.bold(`Error: '${recipientUoi}' is not a valid UOI! Skipping...`));
                STATS.skippedRecipientPaths.push(join(pathToResults, providerUoiAndUsiPath, recipientUoi));
              } else {
                const currentResultsPath = join(pathToResults, providerUoiAndUsiPath, recipientUoi, CERTIFICATION_RESULTS_DIRECTORY);
                console.log(chalk.bold(`Path: ${currentResultsPath}`));
                const results = await readDirectory(currentResultsPath);

                if (!results?.length) {
                  console.log(chalk.redBright.bold('Error: No results found to restore! Skipping...\n'));
                  STATS.missingResultsPaths.push(currentResultsPath);
                } else {
                  if (areRequiredFilesPresent(results)) {
                    STATS.processed.push(currentResultsPath);
                    console.log(chalk.green.bold('Found required results files!'));

                    try {
                      const hasLookupResourceMetadata = !!results.find(
                        result => result === CERTIFICATION_FILES.LOOKUP_RESOURCE_LOOKUP_METADATA
                      );

                      const hasProcessedMetadataReport = !!results.find(result => result === CERTIFICATION_FILES.PROCESSED_METADATA_REPORT);

                      //if the server is using the Lookup Resource then preprocess results if they're not already present
                      //TODO: add option to rescore results
                      if (hasLookupResourceMetadata && !hasProcessedMetadataReport) {
                        const pathToMetadataReport = resolve(join(currentResultsPath, CERTIFICATION_FILES.METADATA_REPORT)),
                          pathToLookupResourceData = resolve(join(currentResultsPath, CERTIFICATION_FILES.LOOKUP_RESOURCE_LOOKUP_METADATA)),
                          pathToOutputFile = resolve(join(currentResultsPath, CERTIFICATION_FILES.PROCESSED_METADATA_REPORT));
                        await processLookupResourceMetadataFiles(pathToMetadataReport, pathToLookupResourceData, pathToOutputFile);
                      }

                      const metadataReport =
                        JSON.parse(
                          await readFile(
                            join(
                              currentResultsPath,
                              hasLookupResourceMetadata
                                ? CERTIFICATION_FILES.PROCESSED_METADATA_REPORT
                                : CERTIFICATION_FILES.METADATA_REPORT
                            )
                          )
                        ) || {};

                      const dataAvailabilityReport =
                        JSON.parse(await readFile(join(currentResultsPath, CERTIFICATION_FILES.DATA_AVAILABILITY_REPORT))) || {};

                      console.log('Ingesting results...');
                      const result = await processDataDictionaryResults({
                        url,
                        providerUoi,
                        providerUsi,
                        recipientUoi,
                        metadataReport,
                        dataAvailabilityReport
                      });
                      console.log(chalk.bold(`Done! Result: ${result ? 'Succeeded!' : 'Failed!'}`));
                    } catch (err) {
                      console.log(chalk.bgRed.bold(err));
                      return false;
                    }
                  } else {
                    console.log(chalk.redBright.bold(`Error: Could not find required files in ${currentResultsPath}`));
                    STATS.missingResultsFilePaths.push(currentResultsPath);
                  }
                }
              }
            }
          }
        }
      }
    }
    console.log();
  } else {
    console.log(chalk.bgRedBright.bold(`Invalid path: ${pathToResults}! \nMust be valid S3 or local path`));
  }

  const timeTaken = Math.round((new Date() - START_TIME) / 1000);
  const totalItems = Object.values(STATS).reduce((acc, stats) => (acc += stats.length), 0);

  console.log(chalk.magentaBright.bold('------------------------------------------------------------'));

  console.log(chalk.bold(`Processing complete! Time Taken: ~${timeTaken}s`));
  console.log(chalk.magentaBright.bold('------------------------------------------------------------'));

  console.log(chalk.bold(`\nItems Processed: ${STATS.processed.length} of ${totalItems}`));
  STATS.processed.forEach(item => console.log(chalk.bold(`  • ${item}`)));

  console.log(chalk.bold(`\nProvider UOI Paths Skipped: ${STATS.skippedProviderUoiPaths.length}`));
  STATS.skippedProviderUoiPaths.forEach(item => console.log(chalk.bold(`\t * ${item}`)));

  console.log(chalk.bold(`\nProvider USI Paths Skipped: ${STATS.skippedUsiPaths.length}`));
  STATS.skippedUsiPaths.forEach(item => console.log(chalk.bold(`\t * ${item}`)));

  console.log(chalk.bold(`\nRecipient UOI Paths Skipped: ${STATS.skippedRecipientPaths.length}`));
  STATS.skippedRecipientPaths.forEach(item => console.log(chalk.bold(`\t * ${item}`)));

  console.log(chalk.bold(`\nMissing Results: ${STATS.missingResultsPaths.length}`));
  STATS.missingResultsPaths.forEach(item => console.log(chalk.bold(`\t * ${item}`)));

  console.log(chalk.bold(`\nMissing Results Files: ${STATS.missingResultsFilePaths.length}`));
  STATS.missingResultsFilePaths.forEach(item => console.log(chalk.bold(`\t * ${item}`)));

  console.log(chalk.bold('\nRestore complete! Exiting...\n'));
};

module.exports = {
  restore,
  readDirectory
};
