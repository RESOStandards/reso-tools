# Schema Utilities

### Schema Generation and Validation

```
$ reso-certification-utils schema --help

Usage: RESO Certification Utils schema [options]

Generate a schema or validate a payload against a schema

Options:
  -G, --generate               Generate a schema for payload validation
  -V, --validate               Validate one or multiple payloads with a schema
  -m, --metadataPath <string>  Path to the metadata report JSON file
  -o, --outputPath <string>    Path tho the directory to store the generated schema. Defaults to "./"
  -a, --additionalProperties   Pass this flag to allow additional properties in the schema. False by default
  -v, --version <string>       The DD version of the metadata report
  -p, --payloadPath <string>   Path to the payload file OR directory/zip containing files that need to be validated
  -r, --resourceName <string>  Resource name to validate against. Required if --version is passed when validating.
  -h, --help                   display help for command
  -k, --disableKeys             Pass this flag to remove record keys from the error report
```

### Generate

```
$ reso-certification-utils schema -G -a
```

### Validate

```
$ reso-certification-utils schema -V -p <path to payloads file, zip, or directory> -a -v 2.0 -r Property
```

# Usage in a library

```js
const { getReferenceMetadata } = require('reso-certification-etl');
const { generateJsonSchema, validate, combineErrors } = require('./lib/schema');
const fs = require('fs/promises');

// generate
const schema = await generateJsonSchema({
  additionalProperties: true,
  metadataReportJson: getReferenceMetadata('2.0')
});
let errorMap = {};

// validate
const payload = JSON.parse(await fs.readFile('<path to payloads file>'));
errorMap = validate({
  version: '2.0',
  jsonPayload: payload,
  errorMap, // pass the error map back into the validate input in case of usage inside a loop
  jsonSchema: schema,
  resourceName: 'Property',
  disableKeys: true
});

// The error map will hold the results of multiple validation so to transform it into a single error report we can use `combineErrors`
const errorReport = combineErrors(errorMap);
console.log(JSON.stringify(errorReport, null, 2));

```
