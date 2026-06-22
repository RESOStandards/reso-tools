const { processLookupResourceMetadata, processLookupResourceMetadataFiles } = require('./process-lookup-resource-metadata.cjs');

const getReferenceMetadata = (version = '2.1') => {
  try {
    // DD reference metadata is owned by reso-common (single source; refreshed via
    // `npm run update:dd-reference`). Consumed here via its subpath export.
    return require(`@reso-standards/reso-common/reference-metadata/dd-${version}.json`);
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
