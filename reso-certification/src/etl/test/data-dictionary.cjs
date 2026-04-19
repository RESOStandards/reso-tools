const { metadataReport } = require('./sample-data-dictionary-reports/metadata-report.cjs');
const expectedReport = require('./sample-data-dictionary-reports/expected-metadata-report.json');
const {
  processMetadata: { processMetadataReport }
} = require('../index.cjs');
const assert = require('assert');

describe('processMetadata', function () {
  it('should match the expected data', () => {
    const processedReport = processMetadataReport(metadataReport);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(processedReport)), expectedReport);
  });
});
