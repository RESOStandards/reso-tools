# Sample Configurations

Configuration files for each endorsement, ready to copy and fill in.

> **A filled-in config holds a live bearer token.** Copy a sample to a `*.local.json` name before
> editing it – for example `cp dd-config.json dd-config.local.json` – and edit the copy. That name is
> gitignored, so a credential cannot be committed by accident. The samples themselves are tracked
> files in this repository, so editing one in place puts your token one `git add` away from being
> published.
>
> The `token` value shipped in each sample is `admin-token`, which is the reference server's own
> documented token and is public. It works against a local reference server as-is. Replace it, along
> with the identifiers and the service root, for a run against any real system.

| Sample | Endorsement | Download |
|---|---|---|
| `dd-config.json` | Data Dictionary | [download](https://github.com/RESOStandards/reso-tools/raw/HEAD/reso-certification/sample-configs/dd-config.json) |
| `core-config.json` | Web API Core | [download](https://github.com/RESOStandards/reso-tools/raw/HEAD/reso-certification/sample-configs/core-config.json) |
| `entity-event-config.json` | EntityEvent | [download](https://github.com/RESOStandards/reso-tools/raw/HEAD/reso-certification/sample-configs/entity-event-config.json) |
| `add-edit-config.json` | Add/Edit | [download](https://github.com/RESOStandards/reso-tools/raw/HEAD/reso-certification/sample-configs/add-edit-config.json) |

## One File Serves Three Endorsements

**Data Dictionary, Web API Core and EntityEvent all run from the same entry.** Nothing in those three endorsements is required beyond the common fields: every endorsement-specific option has a default. So a single config file can run all three, and the three samples above differ only in their `description` and `version`.

**Add/Edit is the exception.** It writes to the server, so it needs to know what to write. See [Add/Edit Needs Payloads](#addedit-needs-payloads) below.

## The Common Fields

```json
{
  "providerUoi": "T00000012",
  "configs": [
    {
      "description": "Production feed",
      "serviceRootUri": "https://api.example.com/odata",
      "recipientUoi": "M00000554",
      "providerUsi": "50039",
      "token": "your-bearer-token"
    }
  ]
}
```

| Field | Where | Notes |
|---|---|---|
| `providerUoi` | Top level | The organization being certified. Applies to every entry in the file. |
| `serviceRootUri` | Per entry | The OData service root. |
| `recipientUoi` | Per entry | The organization receiving the data. |
| `providerUsi` | Per entry | The Unique System Identifier of the system being tested. |
| `description` | Per entry | Optional. Used as the run label in output; when omitted, the three identifiers are shown instead. |

The `configs` array may hold as many entries as needed and each is tested in sequence, so one file can cover several recipients or several systems. `recipients` is accepted as a synonym for `configs`, and a single entry may also be supplied on its own at the top level without the wrapping array.

**All three identifiers appear in the output path**, as `{providerUoi}-{providerUsi}/{recipientUoi}`. An identifier left out of the config shows up there as its own name, so a path segment reading `providerUsi` means that field was not supplied.

## Authentication

Either a bearer token or OAuth2 client credentials, per entry:

```json
"token": "your-bearer-token"
```

```json
"clientCredentials": {
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "tokenUri": "https://auth.example.com/oauth2/token",
  "scope": "optional-scope"
}
```

Credentials may also come from flags, environment variables or a `.env` file, which is usually preferable in continuous integration. See the [user guide](https://tools.reso.org/guides/reso-certification/#authentication).

## OriginatingSystemName and OriginatingSystemID

These scope a feed that carries records from more than one originating system, so the run tests only the records that belong to the system being certified.

| Rule | Detail |
|---|---|
| Who reads them | **Data Dictionary and Web API Core only.** Add/Edit and EntityEvent ignore them. |
| Where to put them | At entry level, or inside that endorsement's own options block. The options block wins if both are set. |
| Which applies | **OriginatingSystemName takes precedence over OriginatingSystemID** when both are present. Supply one. |

```json
{
  "serviceRootUri": "https://api.example.com/odata",
  "recipientUoi": "M00000554",
  "providerUsi": "50039",
  "token": "your-bearer-token",
  "originatingSystemName": "MYSYSTEM"
}
```

Use `originatingSystemId` instead when the feed identifies systems by identifier rather than by name.

## Per-Endorsement Options

Each endorsement reads an optional block. Everything in these blocks has a default, so the block may be omitted entirely.

### Data Dictionary

```json
"ddOptions": {
  "version": "2.1",
  "strictMode": true,
  "limit": 100
}
```

`version` selects the Data Dictionary version, `strictMode` rejects unrecognized fields and data variations rather than reporting them, and `limit` caps the records sampled per resource.

### Web API Core

```json
"coreOptions": {
  "version": "2.1.0",
  "resources": "Property,Member,Office",
  "fullCoverage": true
}
```

`resources` narrows the run and accepts either a comma-separated string or a list. `fullCoverage` tests every eligible field rather than a representative sample.

### EntityEvent

```json
"entityEventOptions": {
  "mode": "observe",
  "writableResource": "Property"
}
```

`observe` is read-only and validates the existing feed. `full` writes records to exercise the create, update and delete event paths, so use it only against a test system.

### Add/Edit Needs Payloads

Add/Edit is the one endorsement that cannot run from the common fields alone, because it creates, updates and deletes records and has to know what a valid and an invalid record look like for the server under test.

Supply them inline as `payloads`, or point at a directory with `payloadsDir`:

```json
"resource": "Property",
"payloads": {
  "createSucceeds": { "ListPrice": 350000.00, "City": "Test City" },
  "createFails": { "ListPrice": -99999.00 },
  "updateSucceeds": { "ListPrice": 375000.00 },
  "updateFails": { "ListPrice": -1.00 },
  "deleteSucceeds": {},
  "deleteFails": { "id": "00000000-0000-0000-0000-000000000000" }
}
```

With no payloads supplied the runner samples the server to build them, which works for many feeds but cannot always succeed: an update or delete payload with no key field and no create payload to chain from leaves it nothing to act on. Supplying payloads explicitly is the reliable path.

See [`add-edit-config.json`](add-edit-config.json) for a complete example.

## Running With a Config

```bash
reso-cert dd --config path/to/config.json
reso-cert core --config path/to/config.json
reso-cert entity-event --config path/to/config.json
reso-cert add-edit --config path/to/config.json
```

Add `--output-dir` to choose where reports are written. Each run writes to `{output-dir}/{endorsement}-{version}/{providerUoi}-{providerUsi}/{recipientUoi}/current`, and the previous run moves to `archived/{timestamp}` beside it.
