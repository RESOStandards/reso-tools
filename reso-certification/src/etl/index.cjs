const { processLookupResourceMetadata, processLookupResourceMetadataFiles } = require('./process-lookup-resource-metadata.cjs');

const getReferenceMetadata = (version = '2.1') => {
  try {
    return require(`./reference-metadata/dd-${version}.json`);
  } catch (err) {
    console.error(`Cannot load reference metadata for version '${version}'!. ${err ? `Error: ${err}` : ''}`);
    return null;
  }
};

module.exports = {
  processLookupResourceMetadata,
  processLookupResourceMetadataFiles,
  processDataAvailability: require('./process-data-availability.cjs'),
  processMetadata: require('./process-metadata.cjs'),
  common: require('./common.cjs'),
  getReferenceMetadata
};
