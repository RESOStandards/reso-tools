#! /usr/bin/env node

const { existsSync } = require('fs');
if (existsSync('.env')) process.loadEnvFile();

const { schema, combineErrors, generateJsonSchema, validate, VALIDATION_ERROR_MESSAGES } = require('./lib/schema');
const { restore } = require('./lib/restore');
const { runDDTests, DEFAULT_LIMIT } = require('./lib/certification/data-dictionary');
const { runUpiTests, parseUpi } = require('./lib/certification/upi');
const { findVariations, updateVariations, computeVariations, DEFAULT_FUZZINESS, inflateVariations } = require('./lib/variations');
const { replicate } = require('./lib/replication');
const { convertMetadata, convertAndSaveMetadata } = require('./lib/metadata');
const { DEFAULT_DD_VERSION, DEFAULT_UPI_VERSION, parseBooleanValue } = require('./common');
const { DEFAULT_PAGE_SIZE } = require('./lib/replication/utils');

//Only load commander interpreter if running from the CLI
if (require?.main === module) {
  const { program } = require('commander');
  
  /**
   * Ensure fromCli is true for anything run from the command line
   */
  const FROM_CLI = true;

  program.name('RESO Certification Utils').description('Command line batch-testing and restore utils');

  program
    .command('runDDTests')
    .description('Runs Data Dictionary tests')
    .requiredOption('-p, --pathToConfigFile <string>', 'Path to config file')
    .option('-a, --runAllTests', 'Flag to run all tests')
    .option('-v, --version <string>', 'Data Dictionary version to use', DEFAULT_DD_VERSION)
    .option('-l, --limit <int>', 'Number of records to sample per strategy, resource, and expansion', DEFAULT_LIMIT)
    .option('-S, --strictMode <boolean>', 'Use strict mode', true)
    .action(options =>
      runDDTests({
        ...options,
        fromCli: FROM_CLI,
        runAllTests: parseBooleanValue(options?.runAllTests),
        strictMode: parseBooleanValue(options?.strictMode)
      })
    );

  program
    .command('runUpiTests')
    .description('Runs UPI Tests (see: https://upi.reso.org)')
    .requiredOption('-p, --pathToResoCommonFormatJson <string>', 'Path to JSON samples in RESO Common Format')
    .option('-v, --version <string>', 'Data Dictionary version to use', DEFAULT_UPI_VERSION)
    .action(options =>
      runUpiTests({
        ...options,
        fromCli: FROM_CLI
      })
    );

  program
    .command('findVariations')
    .description('Finds possible variations in metadata using a number of methods')
    .requiredOption('-p, --pathToMetadataReportJson <string>', 'Path to metadata-report.json file')
    .option('-f, --fuzziness <float>', 'Set fuzziness to something besides the default', DEFAULT_FUZZINESS)
    .option('-v, --version <string>', 'Data Dictionary version to compare to, i.e. 1.7 or 2.0', DEFAULT_DD_VERSION)
    .option('-s, --useSuggestions <boolean>', 'Use external suggestions in addition to machine-provided ones', true)
    .action(options => findVariations({ ...options, fromCli: FROM_CLI, useSuggestions: parseBooleanValue(options?.useSuggestions) }));

  program
    .command('replicate')
    .description('Replicates data from a given resource with expansions')
    .requiredOption('-s, --strategy <string>', 'One of TopAndSkip, TimestampAsc, TimestampDesc, or NextLink')
    .option('-u, --serviceRootUri <string>', 'OData service root URI (no resource name or query)')
    .option('-b, --bearerToken <string>', 'Bearer token to use for authorization')
    .option('-i, --clientId <string>', 'OAuth2 client_id parameter, use this OR bearerToken')
    .option('-c, --clientSecret <string>', 'OAuth2 client_secret parameter, use this OR bearerToken')
    .option('-k, --tokenUri <string>', 'OAuth2 token_uri parameter, use this OR bearerToken')
    .option('-e, --scope <string>', 'Optional OAuth2 scopes for client credentials')
    .option('-p, --pathToMetadataReportJson <string>', 'Path to metadata report JSON')
    .option('-r, --resourceName <string>', 'Resource name to replicate data from')
    .option('-x, --expansions <items>', 'Comma-separated list of items to expand during the query process, e.g. Media,OpenHouse')
    .option('-f, --filter <string>', 'OData $filter expression')
    .option('-t, --top <number>', 'Optional parameter to use for OData $top')
    .option('-m, --maxPageSize <number>', 'Optional parameter for the odata.maxpagesize header', DEFAULT_PAGE_SIZE)
    .option('-o, --outputPath <string>', 'Name of directory for results')
    .option('-l, --limit <number>', 'Limit total number of records at client level')
    .option('-v, --version <string>', 'Data Dictionary version to use', DEFAULT_DD_VERSION)
    .option('-j, --jsonSchemaValidation', 'Use JSON schema validation')
    .option('-N, --originatingSystemName <string>', 'Used when additional filters are needed for OriginatingSystemName')
    .option('-I, --originatingSystemId <string>', 'Used when additional filters are needed for OriginatingSystemID')
    .option('-S, --strictMode <boolean>', 'Fail immediately on schema validation errors if strict mode is true', true)
    .action(options => {
      // TODO: if run from the command line, we don't want to generate additional reports
      // until we have the ability to understand the type and expansions from the metadata
      const {
        pathToMetadataReportJson,
        bearerToken,
        clientId,
        clientSecret,
        tokenUri,
        scope,
        strictMode = true,
        jsonSchemaValidation = false,
        maxPageSize,
        top,
        outputPath,
        ...remainingOptions
      } = options;

      const appOptions = {
        ...remainingOptions,
        pathToMetadataReportJson,
        shouldGenerateReports: !!pathToMetadataReportJson,
        fromCli: FROM_CLI,
        jsonSchemaValidation: parseBooleanValue(jsonSchemaValidation),
        strictMode: parseBooleanValue(strictMode),
        maxPageSize: parseInt(maxPageSize) ?? undefined,
        top: parseInt(top) ?? undefined,
        outputPath,
        shouldSaveResults: !!outputPath
      };

      if (bearerToken) {
        appOptions.bearerToken = bearerToken;
      } else if (clientId && clientSecret && tokenUri) {
        appOptions.clientCredentials = {
          clientId,
          clientSecret,
          tokenUri,
          scope
        };
      } else {
        throw new Error('One of bearerToken OR clientId, clientSecret, and tokenUri MUST be specified!');
      }

      replicate(appOptions);
    });

  program
    .command('schema')
    .option('-G, --generate', 'Generate a schema for payload validation')
    .option('-V, --validate', 'Validate one or multiple payloads with a schema')
    .option('-m, --metadataPath <string>', 'Path to the metadata report JSON file')
    .option('-o, --outputPath <string>', 'Path tho the directory to store the generated schema. Defaults to "./"')
    .option('-a, --additionalProperties', 'Pass this flag to allow additional properties in the schema. False by default')
    .option('-v, --version <string>', 'The DD version of the metadata report')
    .option('-p, --payloadPath <string>', 'Path to the payload file OR directory/zip containing files that need to be validated')
    .option('-r, --resourceName <string>', 'Resource name to validate against. Required if --version is passed when validating.')
    .option('-k, --disableKeys', 'Pass this flag to remove record keys from the error report')
    .description('Generate a schema or validate a payload against a schema')
    .action(options => schema({ ...options, fromCli: FROM_CLI }));

  program
    .command('metadata')
    .description('Converts metadata from OData XML to RESO Format')
    .requiredOption('-p, --pathToXmlMetadata <string>', 'Path to XML Metadata to parse')
    .action(options => convertAndSaveMetadata({ ...options, fromCli: FROM_CLI }));

  program
    .command('updateVariations')
    .description('(Admin) Updates suggestions in the Variations Service')
    .requiredOption('-p, --pathToCsvSuggestions <string>', 'Suggestions CSV file name')
    .option('-f, --isFastTrack', 'Present if Fast Track suggestions')
    .option('-a, --isAdminReview', 'Present if suggestions are from Admin Review')
    .option('-o, --overwrite', 'Required to overwrite any existing Fast Track suggestions')
    .action(options => updateVariations({ ...options, fromCli: FROM_CLI }));

  program
    .command('inflateVariations')
    .description('Inflates a gzip file of mappings')
    .requiredOption('-p, --pathToMappings <string>', 'Compressed mappings file name')
    .action(options => inflateVariations({ ...options, fromCli: FROM_CLI }));

  program
    .command('restore')
    .description('(Admin) Restores local or S3 results to a RESO Certification API instance')
    .option('-p, --pathToResults <string>', 'Path to test results')
    .option('-u, --url <string>', 'URL of Certification API')
    .action(options => restore({ ...options, fromCli: FROM_CLI }));

  program.parse();
}

module.exports = {
  VALIDATION_ERROR_MESSAGES,
  DEFAULT_DD_VERSION,
  replicate,
  restore,
  runDDTests,
  runUpiTests,
  parseUpi,
  findVariations,
  computeVariations,
  convertMetadata,
  combineErrors,
  generateJsonSchema,
  validate
};
