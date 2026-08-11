# RESO Validation – User Guide

A task-oriented walkthrough of the RESO validation library. This is the package that checks whether a real estate record is well-formed against the RESO Data Dictionary before it ever leaves your application or your server.

> **Heads up:** the canonical RESO validation language is **RCP-19 Web API Validation Expressions**, ratified by RESO in December 2023. A full isomorphic interpreter for RCP-19 is in flight and tracked at **[reso-tools#107](https://github.com/RESOStandards/reso-tools/issues/107)**. Until that lands, this library covers the field-level and resource-level checks the RESO ecosystem actually needs today, and the Add/Edit certification path runs against it. Both layers will coexist when RCP-19 lands; nothing in this guide goes away.

## Audience

Developers building anything that has to validate a RESO record before sending or accepting it. Real examples:

* **Servers** that accept Add/Edit writes and need to reject malformed records before they reach the database
* **Clients** that build records in a UI and want immediate feedback before submitting
* **Test runners** that check whether a vendor's payloads conform to the spec
* **Data pipelines** that ingest listings from multiple sources and need to normalize and validate before downstream processing
* **AI agents** that compose records on a user's behalf and need to catch errors before the user sees them

If you are *just* querying a server, the **[RESO Client SDK](../reso-client/)** has its own query-side validation and is the right entry point. This library is for the *write* side and the *record* side.

## Install

This package is not on npm yet. Install from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-validation
npm install
```

This package has no sibling dependencies – `npm install` just runs. To bootstrap every package at once, run `npm run bootstrap` from the repo root instead. To consume the SDK from another project, link it locally with `npm link` or use a `file:` dependency.

Zero runtime dependencies. Isomorphic – runs identically in Node.js 22 or later, in any modern browser bundle and in any edge runtime that supports ESM.

---

## What This Library Does Today

The current library has two layers, both shipped, both running in production against the **[RESO Reference Server](../reso-reference-server/)** and the **[RESO Certification](../reso-certification/)** Add/Edit test suite.

### Layer 1: Field-Level Validation Against Metadata

`validateRecord(body, fields)` takes a record payload and a set of `ResoField` definitions and returns a list of failures. It catches:

* **Unknown fields** – fields in the payload that are not declared in the metadata
* **Type mismatches** – `Edm.String`, `Edm.Boolean`, `Edm.Int32`, `Edm.Decimal`, `Edm.Date`, `Edm.DateTimeOffset` and the rest of the OData primitive set
* **Negative numerics** – numeric fields that should not be negative
* **Length overflow** – string fields that exceed `field.maxLength`
* **Integer enforcement** – integer types receiving non-whole numbers
* **Collection shape** – collection fields receiving non-array values
* **Enum shape** – enum fields receiving values that are not strings or numbers
* **Required fields** – fields that the metadata declares as not nullable but are missing or empty

It silently skips `null`, `undefined` and empty string values unless the field is required. It silently skips `@`-prefixed OData annotations.

```typescript
import { validateRecord } from '@reso-standards/reso-validation';

const failures = validateRecord(
  {
    ListPrice: 250000,
    City: 'Austin',
    BedroomsTotal: 3,
    UnknownField: 'oops'
  },
  fields // ReadonlyArray<ResoField> from your metadata loader
);

// failures → [{ field: 'UnknownField', reason: "'UnknownField' is not a recognized field..." }]
```

### Layer 2: Resource-Specific Business Rules

`validateBusinessRules(resourceName, body)` checks resource-specific constraints that go beyond what field metadata alone can express. The library ships rules for `Property`, `Member` and `Office` today.

Two kinds of rules live here:

* **Per-field rules** – range checks (`min` / `max`), required-field checks and pattern-matched constraints (e.g. "every field whose name ends in `Fee` must be between 0 and 10,000")
* **Cross-field rules** – constraints that span multiple fields, like "BathroomsTotalInteger must equal the sum of the individual bathroom-part fields"

```typescript
import { validateBusinessRules } from '@reso-standards/reso-validation';

const failures = validateBusinessRules('Property', {
  ListPrice: -100,
  BathroomsTotalInteger: 3,
  BathroomsFull: 2,
  BathroomsHalf: 0
});

// failures → [
//   { field: 'ListPrice', reason: 'ListPrice must be at least 0.01' },
//   { field: 'BathroomsTotalInteger', reason: 'BathroomsTotalInteger (3) must equal the sum of bathroom parts (2).' }
// ]
```

The two layers compose naturally. Most consumers call both – `validateRecord` for the structural checks the metadata describes, then `validateBusinessRules` for the resource-specific constraints the metadata cannot express.

---

## How to Add a New Rule Today

If you have a constraint that the current library does not cover and you want to add it before the RCP-19 work ships, the path is straightforward. The rule definitions live under `reso-validation/src/business-rules/` and each resource has its own file.

### Adding a Per-Field Rule

Per-field rules are expressed as `FieldRule` objects in the appropriate per-resource file. The rule shape is:

```typescript
interface FieldRule {
  readonly fieldName: string;
  readonly fieldPattern?: RegExp;  // when set, matches multiple field names
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly message?: string;       // custom error message
}
```

To add a rule that says "the `LotSizeAcres` field on `Property` cannot exceed 10,000," you append a new entry to `PROPERTY_RULES` in `reso-validation/src/business-rules/property-rules.ts`:

```typescript
{
  fieldName: 'LotSizeAcres',
  min: 0,
  max: 10_000
},
```

That is the entire change. The validator picks it up the next time `validateBusinessRules('Property', body)` is called.

### Adding a Cross-Field Rule

Cross-field rules are functions that take a record and return a `ValidationFailure` or `null`. They express constraints that no per-field rule can:

```typescript
interface CrossFieldRule {
  readonly name: string;
  readonly validate: (body: Readonly<Record<string, unknown>>) => ValidationFailure | null;
}
```

To add a rule that says "if `PropertyType` is `Residential`, `BedroomsTotal` must be at least 1," you append to `PROPERTY_CROSS_RULES`:

```typescript
{
  name: 'Residential properties must have at least one bedroom',
  validate: body => {
    if (body.PropertyType !== 'Residential') return null;
    const bedrooms = body.BedroomsTotal;
    if (typeof bedrooms !== 'number' || bedrooms < 1) {
      return {
        field: 'BedroomsTotal',
        reason: 'Residential properties must have at least one bedroom.'
      };
    }
    return null;
  }
}
```

The validator runs every cross-field rule against the record and collects every non-null result.

### Where Rules Live

| File | Contents |
|---|---|
| **[`property-rules.ts`](https://github.com/RESOStandards/reso-tools/blob/main/reso-validation/src/business-rules/property-rules.ts)** | Per-field and cross-field rules for the Property resource |
| **[`member-rules.ts`](https://github.com/RESOStandards/reso-tools/blob/main/reso-validation/src/business-rules/member-rules.ts)** | Member resource rules |
| **[`office-rules.ts`](https://github.com/RESOStandards/reso-tools/blob/main/reso-validation/src/business-rules/office-rules.ts)** | Office resource rules |
| **[`types.ts`](https://github.com/RESOStandards/reso-tools/blob/main/reso-validation/src/business-rules/types.ts)** | The `FieldRule` and `CrossFieldRule` interfaces |
| **[`index.ts`](https://github.com/RESOStandards/reso-tools/blob/main/reso-validation/src/business-rules/index.ts)** | The registry that maps resource names to their rule sets |

To add rules for a resource the library does not currently cover, create a new file alongside the existing ones, export your rule arrays and register them in `index.ts`.

---

## What Is Coming – RCP-19

The current rules-as-TypeScript-functions model works, and it powers the Add/Edit certification path today. But it is not the canonical way to express RESO validation rules. The canonical way is **RCP-19 Web API Validation Expressions**, ratified by RESO in December 2023.

RCP-19 defines a small machine-executable language for validation rules. Instead of writing a TypeScript function, an author writes an expression like:

```
ListPrice .GT. 0 .AND. ListPrice .LT. 1000000000
```

…and the engine parses it, type-checks it against the server's metadata, and evaluates it against records. The same language covers per-field checks, cross-field checks, lookup-membership checks, and the warning/reject decisions an Add/Edit server needs to make on the write path.

### Why It Matters

* **Rules are portable.** A rule written in RCP-19 syntax runs identically against any compliant implementation. Today, every implementation has its own rule format.
* **Rules can travel with the data.** RCP-19 defines a `Rules` resource shape so rules ship over the same OData mechanics as records. A server can advertise its rules to clients; a client can fetch them and apply them locally before submitting.
* **Rules are inspectable.** A static expression can be analyzed, displayed in a UI, translated between dialects and reasoned about by tooling. A TypeScript function cannot.
* **Rules are spec-grounded.** RCP-19 is part of the RESO transport specification. Validators that implement it can make compliance claims that custom rule engines cannot.

### What the RCP-19 Implementation Will Look Like

The full v1 implementation is tracked at **[reso-tools#107](https://github.com/RESOStandards/reso-tools/issues/107)** and is targeted for the month after the Spring RESO 2026 conference. Highlights:

* **Pure TypeScript, isomorphic** – no native modules, no WASM. Runs identically in Node, in browsers and in every surface RESO touches.
* **Built from the canonical ANTLR4 grammar** at **[`RESOStandards/transport`](https://github.com/RESOStandards/transport/tree/main/artifacts/grammars/rcp-19)** – the parser is generated mechanically, so the implementation cannot drift from the spec.
* **Metadata-aware from v1** – takes a `MetadataReport` and uses it for type-aware semantic checks (not just field-existence checks). Rules that compare a `Decimal` to a `String` are caught at parse time, not at evaluation time.
* **A basic rule generator** – point the engine at your metadata report and it produces a starter set of rules covering the schema's basic constraints. Add your custom rules on top.
* **Sequential pipeline executor** – the v1 strategy is "evaluate rules in declaration order, applying SET actions between rules so the next rule sees the updated state." Future versions add dependency-aware scheduling and (eventually) RETE-style incremental evaluation for streaming workloads.
* **Coexistence with the current library** – the RCP-19 module lands as a sibling under `@reso-standards/reso-validation`. The existing `validateRecord` and `validateBusinessRules` APIs do not change. Consumers opt in to RCP-19 when they have rules to evaluate.

### What Will *Not* Change

The current `validateRecord` and `validateBusinessRules` functions are stable, in production use, and will keep working when RCP-19 lands. If you write a `FieldRule` or a `CrossFieldRule` today, that rule keeps running. The two layers complement each other – field-shape validation (the current library) plus expression-based business rules (RCP-19) – and most production users will use both.

For more on the design, the v1/v2/v3 progression and the dependencies on grammar work in `transport`, see **[reso-tools#107](https://github.com/RESOStandards/reso-tools/issues/107)**.

---

## Where to Next

* **Calling a server** – the **[RESO Client SDK](../reso-client/)** uses this library for query-side validation and gives you a higher-level API for fetching, validating and round-tripping queries.
* **Standing up a test server** – the **[RESO Reference Server](../reso-reference-server/)** runs `validateRecord` on every Add/Edit write. Every example in this guide can be exercised against it locally.
* **Running compliance tests** – the **[RESO Certification](../reso-certification/)** Add/Edit test suite drives this library through every supported endorsement scenario. If you are preparing for cert, that is the place to look.
* **Working with OData filters** – the **[OData Expression Parser](../odata-expression-parser/)** is the sister library that handles the *query* side of validation. RCP-19 will share AST-walking patterns with it when v1 ships.

## Reference

* **[Package README](../)** – full API surface and type reference
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-validation)**
* **[GitHub source](https://github.com/RESOStandards/reso-tools/tree/main/reso-validation)**
* **[RCP-19 spec](https://github.com/RESOStandards/transport/blob/main/proposals/validation-expressions.md)** – the canonical RESO Web API Validation Expressions specification, ratified December 2023
* **[RCP-19 grammar](https://github.com/RESOStandards/transport/tree/main/artifacts/grammars/rcp-19)** – the canonical ANTLR4 grammar that the v1 implementation is built from
* **[reso-tools#107](https://github.com/RESOStandards/reso-tools/issues/107)** – the v1 RCP-19 interpreter ticket, with the full v1/v2/v3 progression
