# Add/Edit Compliance Testing (RCP-010)

Validates OData CRUD operations against the RESO Add/Edit specification. Tests create, update, and delete with both `return=representation` and `return=minimal` preferences, plus error handling for invalid payloads.

## Usage

```bash
# Auto-generate payloads from sampled server data
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# Provide your own payload files
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./my-payloads

# Use a config file with inline payloads
reso-cert add-edit --config sample-configs/add-edit-config.json

# Mock server for offline testing
reso-cert add-edit --mock --payloads sample-payloads
```

## Scenarios

8 certification scenarios covering the full CRUD lifecycle:

| # | Scenario | Operation | Preference | Expected |
|---|----------|-----------|------------|----------|
| 1 | create-succeeds-representation | POST | return=representation | 201 with entity body |
| 2 | create-succeeds-minimal | POST | return=minimal | 204 with Location header |
| 3 | create-fails | POST | – | 400 with OData error |
| 4 | update-succeeds-representation | PATCH | return=representation | 200 with updated entity |
| 5 | update-succeeds-minimal | PATCH | return=minimal | 204 with headers |
| 6 | update-fails | PATCH | – | 400 with OData error |
| 7 | delete-succeeds | DELETE | – | 204, follow-up GET returns 404 |
| 8 | delete-fails | DELETE | – | 4xx for non-existent key |

Each scenario validates:
- HTTP status code
- OData-Version header (4.0 or 4.01)
- Response body structure (JSON entity, OData annotations, error format)
- Follow-up GET for create/delete verification

## Pipeline

When you run `reso-cert add-edit`, the SDK pipeline executes these steps:

1. **Health check** – wait for the server to respond
2. **Resolve auth** – token or OAuth2 Client Credentials
3. **Fetch metadata** – download and parse `/$metadata`
4. **Sample records** – fetch 2 existing records for update/delete keys
5. **Generate payloads** – create 6 JSON payload files (or use provided ones)
6. **Run scenarios** – execute all 8 scenarios sequentially
7. **Write reports** – generic + detailed JSON reports

## Payloads

The tool needs 6 payload files. You can provide them via `--payloads <dir>`, inline them in a config file, or let the pipeline auto-generate them from sampled server data.

| File | Purpose |
|------|---------|
| `create-succeeds.json` | Valid payload for POST (required fields) |
| `create-fails.json` | Invalid payload for POST (e.g., negative ListPrice) |
| `update-succeeds.json` | Valid PATCH payload (key + fields to update) |
| `update-fails.json` | Invalid PATCH payload |
| `delete-succeeds.json` | `{ "id": "<existing-key>" }` |
| `delete-fails.json` | `{ "id": "<non-existent-key>" }` |

**Key chaining**: If update/delete payloads omit the key field and a create payload exists, the pipeline automatically injects the created record's key into subsequent payloads.

## Report Format

```json
{
  "description": "Web API Add/Edit",
  "version": "2.0.0",
  "generatedOn": "2026-04-06T00:00:00.000Z",
  "outcome": "passed",
  "remarks": "8 passed, 0 failed",
  "scenarios": [
    {
      "name": "create-succeeds-representation",
      "operation": "Create",
      "preference": "return=representation",
      "resource": "Property",
      "status": "passed",
      "durationMs": 42
    }
  ]
}
```

## Files

```
src/add-edit/
├── test-runner.ts        # Runs all 8 scenarios
├── compliance-report.ts  # Generates Cert API compatible report
├── mock/
│   └── server.ts         # Express-based mock OData server for offline testing
└── index.ts              # Exports
```
