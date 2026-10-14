'use strict';

const fs = require('fs');
const { resolve, normalize, join } = require('path');
const fse = require('fs-extra');
const yauzl = require('yauzl');

/**
 * common.js - Contains programmatically derived constants related to Certification.
 */

const NOT_OK = 1;

/**
 * Data Dictionary Versions
 */
const DATA_DICTIONARY_VERSIONS = Object.freeze({
  v1_7: '1.7',
  v2_0: '2.0'
});

/**
 * Web API Core versions
 */
const WEB_API_CORE_VERSIONS = Object.freeze({
  v2_0_0: '2.0.0',
  v2_1_0: '2.1.0'
});

const CERTIFICATION_FILES = {
  METADATA_REPORT: 'metadata-report.json',
  DATA_AVAILABILITY_REPORT: 'data-availability-report.json',
  DATA_AVAILABILITY_RESPONSES: 'data-availability-responses.json',
  LOOKUP_RESOURCE_LOOKUP_METADATA: 'lookup-resource-lookup-metadata.json',
  PROCESSED_METADATA_REPORT: 'metadata-report.processed.json',
  VARIATIONS_REPORT: 'data-dictionary-variations.json',
  SCHEMA_VALIDATION_ERROR_REPORT: 'data-availability-schema-validation-errors.json'
};

const CURRENT_DATA_DICTIONARY_VERSION = DATA_DICTIONARY_VERSIONS.v2_0,
  DEFAULT_DD_VERSION = DATA_DICTIONARY_VERSIONS.v2_0,
  PREVIOUS_DATA_DICTIONARY_VERSION = DATA_DICTIONARY_VERSIONS.v1_7,
  CURRENT_WEB_API_CORE_VERSION = WEB_API_CORE_VERSIONS.v2_1_0,
  PREVIOUS_WEB_API_CORE_VERSION = WEB_API_CORE_VERSIONS.v2_0_0,
  DEFAULT_WEB_API_CORE_VERSION = WEB_API_CORE_VERSIONS.v2_0_0;

const DEFAULT_UPI_VERSION = '2.0';

const COMMANDER_LOG_FILE_NAME = 'commander.log';

const EMPTY_STRING = '',
  ANNOTATION_STANDARD_NAME = 'RESO.OData.Metadata.StandardName',
  ANNOTATION_DD_WIKI_URL = 'RESO.DDWikiUrl';

/**
 * Each key refers to what the given item is called when saved the filesystem.
 */
const ENDORSEMENTS = {
  DATA_DICTIONARY: 'data-dictionary',
  WEB_API_CORE: 'web-api-server.core'
};

/**
 * Defines the currently supported versions for each endorsement.
 */
const AVAILABLE_VERSIONS = Object.freeze({
  [`${ENDORSEMENTS.DATA_DICTIONARY}`]: {
    currentVersion: CURRENT_DATA_DICTIONARY_VERSION,
    previousVersion: PREVIOUS_DATA_DICTIONARY_VERSION
  },
  [`${ENDORSEMENTS.WEB_API_CORE}`]: {
    currentVersion: CURRENT_WEB_API_CORE_VERSION,
    previousVersion: PREVIOUS_WEB_API_CORE_VERSION
  }
});

const getCurrentVersion = endorsementName =>
  endorsementName && AVAILABLE_VERSIONS?.[endorsementName] && AVAILABLE_VERSIONS?.[endorsementName]?.currentVersion;

const getPreviousVersion = endorsementName =>
  endorsementName && AVAILABLE_VERSIONS?.[endorsementName] && AVAILABLE_VERSIONS?.[endorsementName]?.previousVersion;

/**
 * Determines whether the given endorsementName is valid.
 *
 * @param {String} endorsementName the key to get the config for. @see {ENDORSEMENTS}
 * @returns true if the endorsementName is valid, false otherwise.
 * @throws error if parameters aren't valid
 */
const isValidEndorsement = endorsementName => endorsementName && !!AVAILABLE_VERSIONS?.[endorsementName];

/**
 * Determines whether the version is valid for the given endorsement.
 *
 * @param {String} endorsementName the key to get the config for. @see {ENDORSEMENTS}
 * @param {String} version the version for the given key. @see {AVAILABLE_VERSIONS}
 * @returns true if the version is valid, false otherwise.
 * @throws error if parameters aren't valid
 */
const isValidVersion = (endorsementName, version) =>
  endorsementName &&
  version &&
  AVAILABLE_VERSIONS?.[endorsementName] &&
  (AVAILABLE_VERSIONS?.[endorsementName]?.currentVersion === version || AVAILABLE_VERSIONS?.[endorsementName]?.previousVersion === version);

/**
 * Gets the appropriate config for a given endorsement
 *
 * @param {String} endorsementName the key to get the config for. @see {ENDORSEMENTS}
 * @param {String} version the version for the given key. @see {AVAILABLE_VERSIONS}
 * @returns a config consisting of constants relevant for the given endorsement.
 */
const getEndorsementMetadata = (endorsementName, version) => {
  if (!isValidEndorsement(endorsementName)) {
    throw new Error(`Invalid endorsement! endorsementKey: ${endorsementName}`);
  }

  if (!isValidVersion(endorsementName, version)) {
    throw new Error(`Invalid endorsement version! endorsementKey: ${endorsementName}, version: ${version}`);
  }

  const ddVersion = version || CURRENT_DATA_DICTIONARY_VERSION,
    webApiVersion = version || CURRENT_WEB_API_CORE_VERSION;

  if (endorsementName === ENDORSEMENTS.DATA_DICTIONARY) {
    return {
      directoryName: `${ENDORSEMENTS.DATA_DICTIONARY}`,
      version: `${ddVersion}`,
      /* TODO: add versions to JSON results file names in the Commander */
      jsonResultsFiles: [CERTIFICATION_FILES.METADATA_REPORT_JSON, CERTIFICATION_FILES.DATA_AVAILABILITY_REPORT_JSON],
      htmlReportFiles: [`data-dictionary-${ddVersion}.html`, `data-availability.dd-${ddVersion}.html`],
      logFileName: COMMANDER_LOG_FILE_NAME
    };
  }

  if (endorsementName === ENDORSEMENTS.WEB_API_CORE) {
    return {
      directoryName: `${ENDORSEMENTS.WEB_API_CORE}.${webApiVersion}`,
      jsonResultsFiles: [`${ENDORSEMENTS.WEB_API_CORE}.${webApiVersion}.json`],
      htmlReportFiles: [`${ENDORSEMENTS.WEB_API_CORE}.${webApiVersion}.html`],
      logFileName: COMMANDER_LOG_FILE_NAME
    };
  }

  throw new Error(`Invalid endorsementName: ${endorsementName ? endorsementName : '<null>'}!`);
};

/**
 * Returns the condensed version of the ISO 8601 format, e.g. 20211228T211042673Z
 * which is safe for directory naming.
 *
 * @param {Date} timestamp to convert, defaults to now.
 * @returns ISO 8601 timestamp without separators
 * @see https://en.wikipedia.org/wiki/ISO_8601
 */
const getFileSafeIso8601Timestamp = (timestamp = new Date()) => timestamp.toISOString().replaceAll(/-|:|\./gi, EMPTY_STRING);

/**
 * Creates a path to the recipient's results using the following structure:
 * - providerUoi1-usi1
 *  - recipientUoi1
 *    - current
 *      * <metadata report>
 *      * <data availability report>
 *    - archived
 *      - timestamp1
 *        * <metadata report>
 *        * <data availability report>
 *      + timestamp2
 *      + ...
 *      + timestampN
 *  + recipientUoi2
 *
 * @param {String} providerUoi the provider UOI
 * @param {String} providerUsi the provider USI
 * @param {String} recipientUoi the recipient UOI
 * @param {String} endorsementName the name of the given endorsement. @see {endorsements}
 * @param {String} version the version for the given endorsement
 * @returns Unix path for recipient
 */
const buildRecipientEndorsementPath = ({
  resultsPath,
  providerUoi,
  providerUsi,
  recipientUoi,
  endorsementName,
  version,
  currentOrArchived = 'current'
} = {}) => {
  //TODO: clean up
  if (!resultsPath) throw Error('resultsPath is required!');
  if (!providerUoi) throw Error('providerUoi is required!');
  if (!providerUsi) throw Error('providerUsi is required!');
  if (!recipientUoi) throw Error('recipientUoi is required!');
  if (!endorsementName) throw Error('endorsementName is required!');
  if (!version) throw Error('version is required!');

  if (!isValidEndorsement(endorsementName)) throw new Error(`Invalid endorsementName: ${endorsementName}`);
  if (!isValidVersion(endorsementName, version)) throw new Error(`Invalid version: ${version}`);

  return resolve(normalize(join(
    process.cwd(),
    resultsPath,
    `${endorsementName}-${version}`,
    `${providerUoi}-${providerUsi}`,
    recipientUoi,
    currentOrArchived
  )));
};

/**
 * Copies results from the current endorsement path for the given item to its archive directory,
 * which has the format recipientPath/archived/archived-at-timestamp
 *
 * @param {String} endorsementName
 * @param {String} version
 * @param {String} providerUoi
 * @param {String} providerUsi
 * @param {String} recipientUoi
 */
const archiveEndorsement = ({ resultsPath, providerUoi, providerUsi, recipientUoi, endorsementName, version } = {}) => {
  const srcPath = join(
      buildRecipientEndorsementPath({
        resultsPath,
        providerUoi,
        providerUsi,
        recipientUoi,
        endorsementName,
        version
      })
    ),
    destPath = join(
      buildRecipientEndorsementPath({
        resultsPath,
        providerUoi,
        providerUsi,
        recipientUoi,
        endorsementName,
        version,
        currentOrArchived: 'archived'
      }),
      getFileSafeIso8601Timestamp()
    );

  if (fs.existsSync(srcPath)) {
    try {
      fse.moveSync(srcPath, destPath);
    } catch (err) {
      console.error(`Could not archive path '${resultsPath}'...Skipping. \nError: ${err}`);
    }
  }
};

/**
 * Creates a legacy RESOScript configuration bearer tokens
 * @param {Object} options service root and token
 * @returns XML config for token based auth
 */
const createResoScriptBearerTokenConfig = ({ serviceRootUri, token }) =>
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<OutputScript>' +
  '  <ClientSettings>' +
  `    <WebAPIURI>${serviceRootUri}</WebAPIURI>` +
  '    <AuthenticationType>authorization_code</AuthenticationType>' +
  `    <BearerToken>${token}</BearerToken>` +
  '  </ClientSettings>' +
  '</OutputScript>';

/**
 * Creates a legacy RESOScript configuration for client credentials
 * @param {Object} options service root and client credentials
 * @returns XML config for client credentials
 */
const createResoScriptClientCredentialsConfig = ({ serviceRootUri, clientCredentials }) =>
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<OutputScript>' +
  '  <ClientSettings>' +
  `    <WebAPIURI>${serviceRootUri}</WebAPIURI>` +
  '    <AuthenticationType>client_credentials</AuthenticationType>' +
  `    <ClientIdentification>${clientCredentials.clientId}</ClientIdentification>` +
  `    <ClientSecret>${clientCredentials.clientSecret}</ClientSecret>` +
  `    <TokenURI>${clientCredentials.tokenUri}</TokenURI>` +
  `    ${clientCredentials.scope ? '<ClientScope>' + clientCredentials.scope + '</ClientScope>' : EMPTY_STRING}` +
  '  </ClientSettings>' +
  '</OutputScript>';

/**
 *
 * Sleeps for the given amount of milliseconds
 *
 * @param {int} ms Number of milliseconds to sleep
 * @returns Promise that resolves in the given time
 */
const sleep = async (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parses a lookup name from a fully qualified path
 * @param {String} lookupName name of the lookup to parse
 * @returns name of the lookup without any scope operators (.)
 */
const parseLookupName = lookupName => lookupName?.substring(lookupName.lastIndexOf('.') + 1);

/**
 * Determines whether a given type is a string enumeration
 * @param {String} type the type name
 * @returns true if the type is for a string enumeration, false otherwise
 */
const isStringEnumeration = type => type && type?.includes('Edm.String');

/**
 * Creates a metadata map for lookups from metadata report JSON
 * @param {Object} metadataReportJson to build map with
 * @returns Object containing a metadata map and accompanying stats
 */
const buildMetadataMap = ({ fields = [], lookups = [] } = {}) => {
  const STATS = {
    numResources: 0,
    numFields: 0,
    numLookups: 0,
    numExpansions: 0,
    numComplexTypes: 0
  };

  const lookupMap = lookups.reduce((acc, { lookupName, lookupValue, type, annotations = [] }) => {
    if (!acc[lookupName]) {
      acc[lookupName] = [];
    }

    const { lookupValue: annotatedLookupValue, ddWikiUrl } =
      annotations?.reduce((acc, { term, value }) => {
        if (term === ANNOTATION_STANDARD_NAME) {
          acc.lookupValue = value;
        }

        if (term === ANNOTATION_DD_WIKI_URL) {
          acc.ddWikiUrl = value;
        }
        return acc;
      }, {}) || {};

    if (
      (lookupValue?.startsWith('Sample') && lookupValue?.endsWith('EnumValue')) ||
      (annotatedLookupValue?.startsWith('Sample') && annotatedLookupValue.endsWith('EnumValue'))
    ) {
      return acc;
    }

    if (isStringEnumeration(type)) {
      // the standard lookup value in the Lookup Resource is represented as an annotated value
      acc[lookupName].push({ lookupValue, standardLookupValue: annotatedLookupValue, ddWikiUrl, isStringEnumeration: true });
    } else {
      acc[lookupName].push({ lookupValue: annotatedLookupValue, legacyODataValue: lookupValue, ddWikiUrl });
    }

    //if (!!annotatedLookupValue && annotatedLookupValue !== lookupValue) console.log(`lookupName: ${lookupName}, lookupValue: ${lookupValue}, annotatedLookupValue: ${annotatedLookupValue}`);

    STATS.numLookups++;
    return acc;
  }, {});

  return {
    metadataMap: {
      ...fields.reduce(
        (
          acc,
          { resourceName, fieldName, type, isExpansion = false, isComplexType = false, annotations, typeName = '', nullable = true, isCollection = false }
        ) => {
          if (!acc[resourceName]) {
            acc[resourceName] = {};
            STATS.numResources++;
          }

          const isLookupField = !!lookupMap?.[type];

          const { ddWikiUrl } =
            annotations?.reduce((acc, { term, value }) => {
              if (term === ANNOTATION_DD_WIKI_URL) {
                acc.ddWikiUrl = value;
              }
              return acc;
            }, {}) || {};

          //add field to map
          acc[resourceName][fieldName] = {
            type,
            typeName,
            nullable,
            isExpansion,
            isCollection,
            isLookupField,
            isComplexType: isComplexType || (!isExpansion && !type?.startsWith('Edm.') && !isLookupField),
            ddWikiUrl
          };

          if (isLookupField && lookupMap?.[type]) {
            if (!acc?.[resourceName]?.[fieldName]?.lookupValues) {
              acc[resourceName][fieldName].lookupValues = {};
            }

            if (!acc?.[resourceName]?.[fieldName]?.legacyODataValues) {
              acc[resourceName][fieldName].legacyODataValues = {};
            }

            Object.values(lookupMap?.[type]).forEach(({ lookupValue, standardLookupValue, legacyODataValue, ddWikiUrl, isStringEnumeration }) => {
              const lookupName = parseLookupName(type);

              //skip legacyOData matching if we're using string enumerations
              if (!isStringEnumeration && legacyODataValue?.length) {
                acc[resourceName][fieldName].legacyODataValues[legacyODataValue] = {
                  type,
                  lookupName,
                  lookupValue,
                  legacyODataValue,
                  ddWikiUrl
                };
              }

              if (lookupValue?.length) {
                const value = {
                  type,
                  lookupName,
                  lookupValue,
                  legacyODataValue,
                  ddWikiUrl,
                  isStringEnumeration
                };

                if (!!standardLookupValue) {
                  value.standardLookupValue = standardLookupValue;
                }

                acc[resourceName][fieldName].lookupValues[lookupValue] = value;
              }
            });
          }

          if (isExpansion) {
            STATS.numExpansions++;
          }

          if (isComplexType) {
            STATS.numComplexTypes++;
          }

          STATS.numFields++;
          return acc;
        },
        {}
      )
    },
    stats: STATS
  };
};

/**
 * Parses a URN with the form:
 *
 *  urn:reso:metadata:<version>:resourceName
 *
 * @param {String} urn
 * @returns resource and version parsed from a valid URN. Returns empty strings in case of invalid URN.
 */
const parseResoUrn = (urn = '') => {
  const parts = urn?.split?.(':') || '';

  if (parts.length < 6 || parts[0] !== 'urn' || parts[1] !== 'reso' || parts[2] !== 'metadata') {
    return {
      version: '',
      resource: ''
    };
  }

  return {
    version: parts[3],
    resource: parts.slice(5)[0]
  };
};

/**
 * Creates loggers
 * @param {Boolean} fromCli true if using the console, false otherwise (default)
 * @returns a pair of loggers, one for normal messages and another for errors
 */
const getLoggers = (fromCli = false) => {
  const noop = () => {};
  if (fromCli) {
    return {
      LOG: message => console.log(message),
      LOG_ERROR: message => console.error(message)
    };
  } else {
    return {
      LOG: noop,
      LOG_ERROR: noop
    };
  }
};

/**
 * Tries to parse the given item as a boolean value
 * @param {*} item truthy or falsy value to be converted
 * @returns true or false, accordingly
 */
const parseBooleanValue = item => {
  if (!item) return false;

  if (typeof item === 'string') {
    if (item.toLowerCase() === 'true') {
      return true;
    } else if (item.toLowerCase() === 'false') {
      return false;
    }
  } else if (typeof item === 'boolean') {
    return item;
  }

  return false;
};

const createReplicationStateServiceInstance = () => {
  const replicationStateService = require('./lib/replication/services/state');
  replicationStateService.init();
  return replicationStateService;
};

/**
 * Creates context-sensitive error handler function that logs to
 * the console or throws errors depending on whether the caller is using the CLI
 *
 * @param {Boolean} fromCli true if coming from the CLI, false otherwise (default)
 * @returns Error handler function
 */
const getErrorHandler = (fromCli = false) => {
  return (message, { terminate = true } = {}) => {
    if (fromCli) {
      console.error(`${message}`);
      if (terminate) {
        process.exit(NOT_OK);
      } else {
        process.exitCode = NOT_OK;
      }
    } else {
      throw new Error(message);
    }
  };
};

/**
 * Reads the contents of a zip file and return an object with key being the filename and value being the contents
 * @param {string} path zip file path
 * @returns {Promise<Record<string, string>>}
 */
const readZipFileContents = path => {
  return new Promise((res, rej) => {
    const result = {};
    yauzl.open(path, { lazyEntries: true }, function (err, zipfile) {
      if (err) throw err;

      zipfile.readEntry(); // Start reading.

      zipfile.on('entry', function (entry) {
        if (entry.fileName.includes('__MACOSX')) {
          // These are temp files injected by macos. So we skip them.
          zipfile.readEntry();
        } else if (/\/$/.test(entry.fileName)) {
          // It's a directory, we move to the next entry.
          zipfile.readEntry();
        } else {
          // It's a file, we process it.
          zipfile.openReadStream(entry, function (err, readStream) {
            if (err) throw err;
            const chunks = [];

            readStream.on('data', function (chunk) {
              chunks.push(chunk);
            });

            readStream.on('end', function () {
              const contents = Buffer.concat(chunks).toString('utf8');
              result[entry.fileName] = contents;
              // Move to the next entry.
              zipfile.readEntry();
            });
          });
        }
      });

      zipfile.on('end', () => {
        res(result);
      });

      zipfile.on('error', rej);
    });
  });
};

/**
 * Normalizes and resolves a filename
 *
 * @param {Object} options a filename and optional outputPath for the file
 * @returns a normalized file name with . or .. expansion
 */
const resolveFilePathSync = ({ outputPath, filename }) => {
  if (!(filename && filename?.length)) {
    throw new Error('\'filename\' must contain the name of a file to resolve');
  }
  return resolve(normalize(join(outputPath && outputPath?.length ? outputPath : '', filename)));
};

module.exports = {
  NOT_OK,
  DEFAULT_DD_VERSION,
  DEFAULT_UPI_VERSION,
  DEFAULT_WEB_API_CORE_VERSION,
  DATA_DICTIONARY_VERSIONS,
  WEB_API_CORE_VERSIONS,
  CURRENT_DATA_DICTIONARY_VERSION,
  CURRENT_WEB_API_CORE_VERSION,
  ENDORSEMENTS,
  AVAILABLE_VERSIONS,
  CERTIFICATION_FILES,
  isValidEndorsement,
  isValidVersion,
  getEndorsementMetadata,
  createReplicationStateServiceInstance,
  createResoScriptBearerTokenConfig,
  createResoScriptClientCredentialsConfig,
  getFileSafeIso8601Timestamp,
  buildRecipientEndorsementPath,
  archiveEndorsement,
  getCurrentVersion,
  getPreviousVersion,
  sleep,
  buildMetadataMap,
  getLoggers,
  parseResoUrn,
  parseBooleanValue,
  getErrorHandler,
  readZipFileContents,
  resolveFilePathSync
};
