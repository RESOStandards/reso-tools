# RESO Replication Client
The RESO Replication Client can be used to fetch data from a given URL using a number of different replication strategies and supports OAuth 2 bearer tokens and client credentials.

## View Help
Use the following command to view help info:

```
$ reso-certification-utils replicate --help
Usage: RESO Certification Utils replicate [options]

Replicates data from a given resource with expansions

Options:
  -s, --strategy <string>                  One of TopAndSkip, TimestampAsc, TimestampDesc, or NextLink
  -u, --serviceRootUri <string>            OData service root URI (no resource name or query)
  -b, --bearerToken <string>               Bearer token to use for authorization
  -i, --clientId <string>                  OAuth2 client_id parameter, use this OR bearerToken
  -c, --clientSecret <string>              OAuth2 client_secret parameter, use this OR bearerToken
  -k, --tokenUri <string>                  OAuth2 token_uri parameter, use this OR bearerToken
  -e, --scope <string>                     Optional OAuth2 scopes for client credentials
  -p, --pathToMetadataReportJson <string>  Path to metadata report JSON
  -r, --resourceName <string>              Resource name to replicate data from
  -x, --expansions <items>                 Comma-separated list of items to expand during the query process, e.g. Media,OpenHouse
  -f, --filter <string>                    OData $filter expression
  -t, --top <number>                       Optional parameter to use for OData $top
  -m, --maxPageSize <number>               Optional parameter for the odata.maxpagesize header (default: 100)
  -o, --outputPath <string>                Name of directory for results
  -l, --limit <number>                     Limit total number of records at client level
  -v, --version <string>                   Data Dictionary version to use (default: "2.0")
  -j, --jsonSchemaValidation               Use JSON schema validation
  -N, --originatingSystemName <string>     Used when additional filters are needed for OriginatingSystemName
  -I, --originatingSystemId <string>       Used when additional filters are needed for OriginatingSystemID
  -S, --strictMode <boolean>               Fail immediately on schema validation errors if strict mode is true (default: true)
  -h, --help                               display help for command
```

## Example: Replicate Data from a URL Using `TopAndSkip`
Replicating from `https://some.api.com/Property` can be done as follows:
```
$ reso-certification-utils replicate -s TopAndSkip -u https://some.api.com/Property -b <your test token>
```

## Example: Replicate Data from the Property Resource Using `NextLink` with a Media and OpenHouse Expansion
Replicating from `https://some.api.com/Property` can be done as follows:
```
$ reso-certification-utils replicate -s NextLink -u https://some.api.com/Property -b <your test token> -x Media,OpenHouse
```

You can also use the expand query directly, without the `-x` option. In that case, the dollar sign in `$expand` needs to be escaped.
```
$ reso-certification-utils replicate -s NextLink -u https://some.api.com/Property?\$expand=Media,OpenHouse -b <your test token>
```
Note the `\` before the `$expand`. Shells sometimes require escape sequences for special characters like `$`.


# RESO Certification

RESO uses the `replicate` option for Data Dictionary testing, which consists of four parts:

* **Metadata Validation** - Validates XML and OData metadata and produces a `metadata-report.json` file. See [RESO Commander](https://commander.reso.org)
* **Variations Check** - Finds suggested mappings for resource, fields, and lookups using automated matching techniques and human suggestions
* **Data Sampling** - Ensures that RESO Web API providers are following the specification and that data can be sampled using the standard
* **Data Validation** - All sampled data are validated against JSON Schema generated from their metadata


For more information about RESO Certification, see the [README](../certification/README.md).

The `replicate` utility performs the latter two of the above steps. 

## Replicate Data from a RESO Server

To test replication using DD 2.0 and `NextLink` behavior, use the following command:

```
$ reso-certification-utils replicate -s NextLink -u https://yourapi.com/serviceRoot -i <clientId> -c <clientSecret> -k <tokenUri> -e api -l 100000 -p <your-metadata-report.json> -t 100 -f "OriginatingSystemName eq '<your originating system name>'" -v 2.0
```

In DD 1.7, ModificationTimestamp queries were used for testing instead. For example:

```
$ reso-certification-utils replicate -s TimestampDesc -u https://yourapi.com/serviceRoot -i <clientId> -c <clientSecret> -k <tokenUri> -e api -l 100000 -p <your-metadata-report.json> -t 100 -f "OriginatingSystemName eq '<your originating system name>'" -v 1.7
```

The examples above show the use of the OriginatingSystemName filter. 

The also assume that the user will have access to the `metadata-report.json` or `metadata-report.processed.json` files in order to inform the replication client of the resources and expansions to query.

## Replicate Data from a RESO Server with JSON Schema Validation
Once replication is working correctly using the commands above, the next step is to add schema validation. 

```
$ reso-certification-utils replicate -s TimestampDesc -u https://yourapi.com/serviceRoot -i <clientId> -c <clientSecret> -k <tokenUri> -e api -l 100000 -p <your-metadata-report.json> -t 100 -f "OriginatingSystemName eq '<your originating system name>'" -v 1.7 -j true
```

In this case, `-j` tells the program to use JSON Schema Validation an `-S` sets strict mode, which will exit on first error. Since the number of JSON Schema validation errors can be potentially large, strict mode is enabled by default.

# Reports and Errors
If there are errors during sampling they will be displayed on the screen if running as a command-line utility. 

If reports are being saved, they will be saved to the root of the directory. For example, JSON Schema Validation errors will be saved to `data-availability-schema-validation.errors` and data availability reports will be saved to `data-availability-report.json`.

<br />

---
<br />

Questions? Contact [**dev@reso.org**](mailto:dev@reso.org)
