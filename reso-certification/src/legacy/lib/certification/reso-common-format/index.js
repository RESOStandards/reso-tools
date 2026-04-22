'use strict';

const { getReferenceMetadata } = require('@reso/reso-certification-etl');
const { generateJsonSchema, validate, combineErrors } = require('../../schema');
const fs = require('fs/promises');
const { exit } = require('process');
const { DEFAULT_DD_VERSION } = require('../../../common');

const runRcfTests = async ({
  pathToRcfResults = null,
  additionalProperties = false,
  version = DEFAULT_DD_VERSION,
  metadataReportJson = null
} = {}) => {
  const isS3Path = path => (path && path?.startsWith('s3://')) ?? false;

  // 1. If pathToResults is S3, load from there. Otherwise load from local path
  if (!!pathToRcfResults && isS3Path(pathToRcfResults)) {
    // TODO S3
    throw new Error('S3 not supported yet! Local files only.');
  }

  try {
    // generate
    const schema = await generateJsonSchema({
      additionalProperties,
      metadataReportJson: metadataReportJson ?? getReferenceMetadata(version)
    });

    // validate
    const payload = JSON.parse(await fs.readFile(pathToRcfResults));
    
    let errorMap = {};

    errorMap = validate({
      version: '2.0',
      jsonPayload: payload,
      errorMap,
      jsonSchema: schema,
      resourceName: 'Property',
      disableKeys: true
    });

    const errorReport = combineErrors(errorMap);
    console.log(JSON.stringify(errorReport, null, 2));

    // const errorJson = {
    //   description: 'RESO Common Format Error Report'
    // };

  } catch (err) {
    console.error(err);
    exit(true);
  }

  // 2. Process RCF files with schema validation

  // 3. Generate data availability report

  // 4. Generate metadata report

  // 5. Run variations check - if it fails, post to Cert API with failed status and variations report

  // 6. If variations check passes, save metadata and availability reports to S3, then push to Cert API

  // 7. For any path that is from S3, delete the raw data from S3 after the request is finished,
  // whether it completed successfully or not
};

module.exports = {
  runRcfTests
};
