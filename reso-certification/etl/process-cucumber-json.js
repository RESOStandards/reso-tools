const processCucumberJson = async reportJson => {
  const { cucumberReport = [], errorLog } = reportJson;
  if (!Array.isArray(cucumberReport)) {
    return { errors: [], parsedErrorLogs: { testStep: '', message: '' } };
  }
  const errorLogs = parseErrorLog(errorLog);
  const failedSteps = cucumberReport
    ?.flatMap(({ elements }) =>
      elements.flatMap(element =>
        element.steps.map(step => (step.result.status === 'failed' ? step : null))
      )
    )
    .filter(step => step);

  /**
   * sample error_message from errors[0].result.error_message
   *
   * "java.lang.AssertionError: The following fields are missing the required 'RESO.OData.Metadata.LookupName' annotation: \nCountyOrParish, StreetDirSuffix, City, StateOrProvince, StreetDirPrefix, StreetSuffix\n\n\tat org.junit.Assert.fail(Assert.java:89)\n\tat org.reso.certification.stepdefs.LookupResource.resoLookupsUsingStringOrStringCollectionDataTypesMUSTHaveTheAnnotation(LookupResource.java:173)\n\tat ✽.RESO Lookups using String or String Collection data types MUST have the annotation \"RESO.OData.Metadata.LookupName\"(file:///home/jdarnell/work/reso/github/web-api-commander/src/main/java/org/reso/certification/features/data-dictionary/v1-7-0/additional-tests/lookup-resource-tests.feature:42)\n"
   */

  /**
   * we need to parse it into the following
   *
   * "The following fields are missing the required 'RESO.OData.Metadata.LookupName' annotation: \nCountyOrParish, StreetDirSuffix, City, StateOrProvince, StreetDirPrefix, StreetSuffix"
   */

  const errors = failedSteps.map(({ result: { error_message } = {}, name = '' }) => {
    const assertionMessageTrimmed = error_message?.substr(
      error_message?.indexOf(':') + 1,
      error_message?.length
    );
    const message = assertionMessageTrimmed
      ?.substr(0, assertionMessageTrimmed.indexOf('\n\n'))
      ?.trim();

    return {
      stepName: name,
      message
    };
  });
  return {
    cucumberReport: errors,
    errorLog: errorLogs
  };
};

const parseErrorLogSingleLine = (log = '') => {
  const trimmedTimestampAndError = log?.substring(log.lastIndexOf('['), log?.length);
  const testStep = trimmedTimestampAndError.substring?.(1, trimmedTimestampAndError.indexOf(']'));
  const errorString = trimmedTimestampAndError?.replace(`[${testStep}]`, '').trim();

  /**
   matches string starting with "-" or "- ERROR:" 
   */
  const errorPrefixRegex = /^- (ERROR:)?/;
  const message = errorString?.replace(errorPrefixRegex, '')?.trim();

  return {
    testStep,
    message
  };
};

// some logs can have new line in the middle of the message. this causes an issue when parsing multi-line logs. we fix this issue here.
const sanitizeLogs = (logs = []) => {
  const timestampRegex = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/;
  return logs.reduce((acc, curr) => {
    // we make an assumption that all error logs start with a timestamp
    if (timestampRegex.test(curr)) {
      acc.push(curr);
    } else {
      // if control reaches here that means this newline was part of the previous log statement.
      acc[acc.length - 1] += `\n${curr}`;
    }
    return acc;
  }, []);
};

/**
 * sample error log
 * 
 * [2022-10-06 21:13:40.566] [ERROR] [LookupResource] - ERROR: The following fields are missing the required 'RESO.OData.Metadata.LookupName' annotation: 
 CountyOrParish, StreetDirSuffix, City, StateOrProvince, StreetDirPrefix, StreetSuffix

 should be trnasformed into 

"errorLog": [
  {
    "testStep": "LookupResource",
    "message": "The following fields are missing the required 'RESO.OData.Metadata.LookupName' annotation: 
    CountyOrParish, StreetDirSuffix, City, StateOrProvince, StreetDirPrefix, StreetSuffix" 
  }
]
 */
const parseErrorLog = (log = '') => {
  const logs = log.split('\n').filter(l => l);
  const sanitizedLogs = sanitizeLogs(logs);
  return sanitizedLogs.map(log => parseErrorLogSingleLine(log));
};

module.exports = {
  processCucumberJson,
  parseErrorLog
};
