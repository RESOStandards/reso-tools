# Web API Core BDD Parity Gap Analysis

Maps the Web API Commander's Web API **Core** BDD surface to the Node port's `web-api-core`, parallel
to the DD BDD analysis. Unlike the DD checks (which had real gaps), Core is already covered.

Source: `web-api-commander/src/main/java/org/reso/certification/features/web-api/{v2.0.0,v2.1.0}/web-api-server.core.feature`
(handcrafted, not generated) + `stepdefs/WebAPIServerCore.java`. Ours: `reso-certification/src/web-api-core/`.

## Surface

- Commander Core: **44** scenarios across v2.0.0 + v2.1.0 – metadata-validation, service-document,
  fetch-by-key, `$select/$top/$skip/$count`, `$filter` (int/decimal/date/datetime comparisons),
  `$orderby` (+ filtered), enum filters (single/multi/collection any/all), 400/404 responses.
- Ours: **53** scenario keys (`scenarios.ts`), `assertions.ts`, `test-runner.ts`; 85 tests green.

## Coverage – Zero Functional Gaps

The set diff shows 3 Commander scenarios "missing" by name, all naming variants we DO cover:

| Commander key | Covered by (ours) |
|---|---|
| `filter-datetime-lt` | the Commander scenario reuses the `filter-datetime-gt` URL (misnamed duplicate); we have `filter-datetime-gt` + `filter-datetime-lt-now` |
| `filter-datetime-ne` | `filter-datetime-ne-now` (identical: `ne now()`) |
| `filter-enum-single-ne` | `filter-enum-ne` (single enum, `ne`) |

### Our Extras (12, Not in Commander Core)
- String filters: `filter-string-contains`, `-startswith`, `-endswith`.
- String-enum filters (the 4.01 string representation): `filter-string-enum-single-{eq,ne,in}`,
  `filter-string-enum-multi-{any,all}`.
- Extra datetime/enum variants: `filter-date-lt`, `filter-datetime-ge`, `filter-datetime-ne-now`,
  `filter-enum-ne`.

## Assertion Depth – Exceeds the Commander

The Commander's Core scenarios assert: status 200, an `OData-Version` header of 4.0/4.01, valid JSON,
and "has results". Ours (`assertions.ts`) asserts all of those PLUS **deep filter correctness** –
every returned record's field value actually satisfies the comparison (int/decimal/date/datetime),
single/multi/collection enum membership, and OData null-exclusion semantics. So a server that returns
results that DO NOT satisfy the filter passes the Commander but fails ours.

## Conclusion

`web-api-core` meets and exceeds the Commander's Web API Core surface – full scenario parity (the 3
nominal diffs are naming), 12 additional scenarios, and stricter assertions. **No port work is
needed here**, in contrast to the DD checks. Version gating is handled (`minVersion`, 4.01-only
string `in`, cascade-skip for dependent string-enum tests).
