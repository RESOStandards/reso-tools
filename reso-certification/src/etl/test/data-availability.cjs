const { daReport, daReport2_0 } = require('./sample-data-availability-reports/availability-report.cjs');
const expectedReport = require('./sample-data-availability-reports/expected-availability-report.json');
const expectedReport2_0 = require('./sample-data-availability-reports/expected-availability-report-2_0.json');
const {
  processDataAvailability: { processDataAvailability }
} = require('../index.cjs');
const assert = require('assert');

describe('processDataAvailability', function () {
  it('should match the expected data', async () => {
    const processedReport = await processDataAvailability(daReport);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(processedReport)), expectedReport);
  });

  it('should match the expected data with new resources in DD 2.0', async () => {
    const processedReport = await processDataAvailability(daReport2_0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(processedReport)), expectedReport2_0);
  });
});
