# RESO Universal Parcel Identifier (UPI) Validation
The RESO Universal Parcel Identifier is a URN-based formula that allows the parcel number and source unambiguously. See: [upi.reso.org](https://upi.reso.org).

To validate RESO UPIs, use this utility from either the command line or call `runUpiTests` as a library method.

# Command Line Usage
To run from the command line, make sure that RESO Certification Utils is installed. See [README](/README.md).

```
$ reso-certification-utils runUpiTests --help

Usage: RESO Certification Utils runUpiTests [options]

Runs UPI Tests

Options:
  -p, --pathToResoCommonFormatJson <string>  Path to JSON samples in RESO Common Format
  -v, --version <string>                     Data Dictionary version to use (default: "2.0")
  -h, --help                                 display help for command

```

# Library Usage
For examples on how to run as a library, [see tests](/test/upi.js). 

# Input
Input is expected to use RESO Common Format. This could be just the `UniversalParcelId` field itself, a payload including the UPI components, or an entire Property payload with the UPI and its corresponding fields present or not.

## Example: Validate the Format of One or More UPIs
If the data contains only `UniversalParcelId`, then validation will only be done on the UPI itself and not on the individual parts. 

```json
{
  "@reso.context": "urn:reso:metadata:2.0:resource:property",
  "value": [
    {
      "UniversalParcelId": "urn:reso:upi:2.0:US:48201:R000022230"
    }
  ]
}
```

## Example: Validate One or More UPIs with Data
If the data contains other UPI fields, in addition to `UniversalParcelId`, then the parsed UPI will be validated against those components. 

```json
{
  "@reso.context": "urn:reso:metadata:2.0:resource:property",
  "value": [
    {
      "UniversalParcelId": "urn:reso:upi:2.0:US:48201:R000022230",
      "Country": "US",
      "CountrySubdivision": "48201",
      "ParcelNumber": "R000022230"
    }
  ]
}
```

# Output
If running from the CLI, the output will be written to a file in the root of the program directory called `upi-validation-report.json`. If running as a library, this file will be returned from the call to `runUpiTests`.

This file will either contain the number of validated records, if validation passed, or an error array with a list of UPIs with error messages indicating what the error was. 