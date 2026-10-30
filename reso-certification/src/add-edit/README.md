# Add/Edit Compliance Testing (RCP-010)

Validates OData create, update and delete against the RESO Add/Edit specification. A provider tests the actions it supports, with the responses it supports for each, and passing those is a pass. RCP-010 lets providers "implement as many or as few actions as makes sense for their business case."

## Usage

```bash
# Test every action, with your own payloads
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./my-payloads

# Test only creates and updates, and updates only with headers-only responses
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./my-payloads \
  --actions create,update --update-formats minimal

# Use a config file with inline payloads
reso-cert add-edit --config sample-configs/add-edit-config.json

# The reference server, where the tool writes the payloads
reso-cert add-edit --url http://localhost:8080 --auth-token admin-token --auto-payloads

# The mock server, for offline testing. It writes its own payloads unless --payloads gives them
reso-cert add-edit --mock
```

## What a run tests

Each action is a pair of tests, one that should succeed and one that should fail. Create and update each have two response formats as well: `return=representation`, where the record comes back, and `return=minimal`, headers only. Choose any of them:

| Option | In a config file | Default |
|---|---|---|
| `--actions create,update,delete` | `addEditOptions.actions` | all three |
| `--create-formats representation,minimal` | `addEditOptions.formats.create` | both |
| `--update-formats representation,minimal` | `addEditOptions.formats.update` | both |

A delete has no format. The run passes when every test it ran passes, and at least one action must be chosen. The report says what was tested, for example `Tested create (minimal), update (representation, minimal)`.

| Scenario | Action | Format | Expected |
|---|---|---|---|
| create-succeeds-representation | create | representation | 201 with the record |
| create-succeeds-minimal | create | minimal | 204 with `Location` and `EntityId` |
| create-fails | create | – | 400 with an OData error |
| update-succeeds-representation | update | representation | 200 with the updated record |
| update-succeeds-minimal | update | minimal | 204 with headers |
| update-fails | update | – | 400 with an OData error |
| delete-succeeds | delete | – | 204, then a GET returns 404 |
| delete-fails | delete | – | 4xx for a record that does not exist |

Each test checks the status code, the `OData-Version` header and the response's structure (the record, its annotations, the error format), and the tests that write follow up with a GET.

## Payloads

Each action tested needs its two payloads. RCP-010: "Those being certified will provide known good and bad payloads that can trigger each of these responses." Give them as a folder (`--payloads <dir>`) or inline in a config file (`payloads`), one way or the other:

| File | Inline name | What it holds |
|---|---|---|
| `create-succeeds.json` | `createSucceeds` | A valid record to create |
| `create-fails.json` | `createFails` | An invalid one, such as a negative `ListPrice` |
| `update-succeeds.json` | `updateSucceeds` | A valid change, with the record's key or without (below) |
| `update-fails.json` | `updateFails` | An invalid change |
| `delete-succeeds.json` | `deleteSucceeds` | `{ "id": "<a record it may delete>" }`, or `{}` (below) |
| `delete-fails.json` | `deleteFails` | `{ "id": "<a record that does not exist>" }` |

A folder needs only the files of the actions tested. A run given no payloads is refused before it writes anything.

**An update or a delete that names no record uses one the run created.** When create is tested too, an update payload without the resource's key changes the record the first create made, and a delete payload without an `id` or a `url` deletes the record the last create made. A run that tests every action this way leaves the server's own records alone. With no create to use, every update and delete has to name its record, and the run is refused before it writes anything when one does not. A write is never sent without a key, because it would go to the whole collection.

**Auto payloads**, `--auto-payloads` (`addEditOptions.autoPayloads` in a config file), are written by the tool, for the reference server and the mock. They are written for Property only. Update and delete use the record the run creates, or, when create is not tested, two records sampled by the resource's key. A run on auto payloads certifies what it passed, like any other, and its report says the tool wrote the payloads.

## Pipeline

1. **Resolve authentication** – a token or OAuth2 client credentials
2. **Service check** – waits for the server to respond (skipped for the mock)
3. **Fetch metadata** – downloads and validates `$metadata`
4. **Sample records** – auto payloads only, when an update or a delete is tested without a create
5. **Generate payloads** – checks the provider's payloads, or writes auto ones, for the actions tested
6. **Run Add/Edit scenarios** – the tests chosen, in order: create, update, delete
7. **Write reports** – the summary report and the detailed report

## Report

`report.json` is the summary:

```json
{
  "description": "Web API Add/Edit",
  "version": "2.0.0",
  "generatedOn": "2026-10-30T15:08:09.214Z",
  "remarks": "7 of 7 scenarios passed. Tested create (minimal), update (representation, minimal), delete. 722 fields validated against Property metadata.",
  "outcome": "passed"
}
```

`report-detailed.json` adds every step, with the actions and formats tested, and every scenario with its assertions.

## Files

```
src/add-edit/
├── plan.ts               # The tests a run's actions and formats select
├── test-runner.ts        # Runs them, using the records its creates make
├── compliance-report.ts  # Generates the Cert API compatible report
├── mock/
│   └── server.ts         # Express-based mock OData server for offline testing
└── index.ts              # Exports
```
