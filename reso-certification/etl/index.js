const { processLookupResourceMetadata, processLookupResourceMetadataFiles } = require('./process-lookup-resource-metadata');

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
  processDataAvailability: require('./process-data-availability'),
  processMetadata: require('./process-metadata'),
  common: require('./common'),
  processCucumberJson: require('./process-cucumber-json'),
  getReferenceMetadata
};
