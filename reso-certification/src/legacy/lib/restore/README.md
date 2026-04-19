# RESO Restore Utils

## Publish Results to a RESO Certification Server
Publishes certification results to a RESO Certification Server via its API using a local or S3 path.

Once the `reso-certification-utils` package is installed, usage will be shown by calling it with no arguments on the command line:

```
$ reso-certification-utils restore --help
Usage: RESO Certification Utils restore [options]

Restores local or S3 results to a RESO Certification API instance

Options:
  -p, --pathToResults <string>  Path to test results
  -u, --url <string>            URL of Certification API
  -h, --help                    display help for command
```
---
<br />

### Restore Data Dictionary and Data Availability Results from a Local Path
This option is used when there are Data Dictionary and Data Availability results to restore. 

The following directory structure is assumed:
```
- data_dictionary-1.7
  - providerUoi1-providerUsi1
    -recipientUoi1
      - current
        * <metadata report JSON>
        * <data availability report JSON>
      + archived
        + timestamp0001
        ...
  + providerUoiN-providerUsiN
``` 

If the required files don't exist for a given Organization, it will be skipped. 

Example:
    
```
reso-certification-utils restore -p <path/to/data-dictionary-results/parent-path> -u <server url> 
```

Where: 
* `-p` must point to the parent folder where the results directories reside
* `-u` may be any server URL, but there must be an API key for it in the .env file (see sample.env)

**Note**: If the given Data Dictionary results include data from the Lookup Resource, the lookup metadata will be merged with the Data Dictionary metadata when processed.


### Sync Web API Core Results
TODO: Given a local path to Web API Core results, this option will ensure that any Data Dictionary Endorsements present on the server 
with the same providerUoi and providerUsi combination also have their accompanying Web API Core results for a given provider. 

The following directory structure is assumed:
```
- web_api_core-2.0.0
  - providerUoi1-providerUsi1
    * <web api core report JSON>
    ...
  + providerUoiN-providerUsiN
``` 

