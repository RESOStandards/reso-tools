# EntityEvent Compliance Testing (RCP-027)

Validates EntityEvent change tracking against the RESO EntityEvent specification. Tests that the server correctly records create, update, and delete events with monotonically increasing sequence numbers.

## Usage

```bash
# Observe mode – read-only, validates existing EntityEvent records
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Full mode – creates, updates, and deletes a canary record, then verifies events
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode full

# Use a config file
reso-cert entity-event --config sample-configs/entity-event-config.json
```

## Modes

| Mode | What It Does | Scenarios |
|------|-------------|-----------|
| **observe** (default) | Read-only – queries existing EntityEvent records and validates structure | 9 |
| **full** | Writes a canary record (create, update, delete) and verifies EntityEvent entries are generated | 12 |

## Scenarios

### Both Modes (9 scenarios)

| Scenario | What is Tested |
|----------|---------------|
| metadata-valid | EntityEvent entity type exists in `/$metadata` |
| read-only-enforced | POST, PATCH, DELETE to EntityEvent return 4xx (read-only) |
| event-structure | GET EntityEvent returns records with required fields |
| sequence-monotonic | `EntityEventSequence` values are strictly ascending |
| query-filter | `$filter=ResourceName eq 'Property'` works |
| query-orderby-top-skip | `$orderby`, `$top`, `$skip` work on EntityEvent |
| query-count | `$count=true` returns `@odata.count` |
| incremental-sync | Poll for new events (observe) or query after writes (full) |
| data-validation | Batch fetch and validate EntityEvent record structure |

### Full Mode Only (3 additional scenarios)

| Scenario | What is Tested |
|----------|---------------|
| create-triggers-event | POST to writable resource creates an EntityEvent entry |
| update-triggers-event | PATCH to writable resource creates an EntityEvent with higher sequence |
| delete-triggers-event | DELETE creates an EntityEvent with higher sequence |

## Pipeline

1. **Health check** – wait for server
2. **Resolve auth** – token or OAuth2
3. **Fetch metadata** – verify EntityEvent entity type exists
4. **Generate payloads** – canary write payload (full mode only)
5. **Run scenarios** – all applicable scenarios
6. **Write reports** – generic + detailed JSON reports

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--mode` | observe | Testing mode: `observe` or `full` |
| `--writable-resource` | Property | Resource for canary writes in full mode |
| `--max-events` | 1000 | Max EntityEvent records to validate |
| `--batch-size` | 100 | Keys per batch fetch request |
| `--poll-interval` | 5000 | Milliseconds between incremental sync checks |
| `--poll-timeout` | 30000 | Max milliseconds to wait for new events |

## Files

```
src/entity-event/
├── test-runner.ts           # Runs all scenarios
├── compliance-report.ts     # Generates Cert API compatible report
├── types.ts                 # EntityEvent-specific types
├── mock/
│   └── server.ts            # Mock EntityEvent server for testing
└── index.ts                 # Exports
```
