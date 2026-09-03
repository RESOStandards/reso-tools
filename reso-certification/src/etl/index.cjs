const { processLookupResourceMetadata, processLookupResourceMetadataFiles } = require('./process-lookup-resource-metadata.cjs');

const getReferenceMetadata = (version = '2.1') => {
  try {
    // DD reference metadata is owned by reso-common (single source; refreshed via
    // `npm run update:dd-reference`). Consumed via its subpath export with STATIC specifiers
    // (one literal require per supported version) so the esbuild cert-worker bundle inlines each
    // JSON — a template-literal require escapes static analysis and fails in the packaged app
    // (reso-tools-private #102). Add a case when a new DD version lands.
    switch (version) {
      case '1.7': return require('@reso-standards/reso-common/reference-metadata/dd-1.7.json');
      case '2.0': return require('@reso-standards/reso-common/reference-metadata/dd-2.0.json');
      case '2.1': return require('@reso-standards/reso-common/reference-metadata/dd-2.1.json');
      default:
        console.error(`Cannot load reference metadata for version '${version}'! Unsupported version.`);
        return null;
    }
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
