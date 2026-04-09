# OData Expression Parser – User Guide

A task-oriented walkthrough of the RESO OData Expression Parser. This is the library that turns OData `$filter` and `$expand` strings into structured trees you can read, walk, transform, and write back out as canonical OData.

If you have ever found yourself reaching for a regex to pull a field name out of a `$filter`, this is the library that ends that pattern.

> **New here?** OData uses a small but expressive query language inside two URL parameters: `$filter` for "which records do I want" and `$expand` for "which related records should come along." Both are strings on the wire, but both have a real grammar underneath. This parser exposes that grammar as a typed AST so you can work with it as data instead of as text.

## Audience

Developers building anything that needs to *understand* an OData query rather than just pass it through. Real examples:

* **Query UI builders** that need to render a filter as form fields and write it back out as a string
* **Server implementations** that translate `$filter` into SQL, MongoDB, or another query language
* **Validators** that need to walk an expression and check that every property reference exists in the schema
* **Linters and formatters** that normalize OData queries before logging or comparing them
* **Migration tools** that translate between dialects of OData

If you are just *calling* a RESO server, you probably want **[`@reso-standards/reso-client`](../reso-client/)** instead, which uses this parser internally and gives you a higher-level API.

## Install

```bash
npm install @reso-standards/odata-expression-parser
```

Zero runtime dependencies. Works in any ESM environment, Node.js 22 or later. The whole library is small enough to ship in a browser bundle without thinking about it.

---

## Parsing a Filter

The main entry point is `parseFilter`. It takes an OData `$filter` string and returns a typed AST.

```typescript
import { parseFilter } from '@reso-standards/odata-expression-parser';

const ast = parseFilter("ListPrice gt 200000 and contains(City, 'Austin')");
```

The result is a discriminated union of expression nodes. The top-level node here is a `LogicalExpr` with `operator: 'and'`, and the two children are a `ComparisonExpr` and a `FunctionCallExpr`. Every node carries a `type` discriminator, so TypeScript narrowing works the way you expect.

```typescript
if (ast.type === 'logical' && ast.operator === 'and') {
  // TypeScript knows ast.left and ast.right exist here
  console.log('Left side type:', ast.left.type);
  console.log('Right side type:', ast.right.type);
}
```

### What the Grammar Covers

The parser implements OData 4.01's full filter grammar. The README has the complete list, but the headline categories are:

* **Comparison operators** – `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `has`, `in`
* **Logical operators** – `and`, `or`, `not`
* **Arithmetic operators** – `add`, `sub`, `mul`, `div`, `mod`, `divby`
* **String functions** – `contains`, `startswith`, `endswith`, `length`, `tolower`, `toupper`, `trim`, `concat`, `substring`, `indexof`, `matchesPattern`
* **Date and time functions** – `year`, `month`, `day`, `hour`, `minute`, `second`, `now`, `date`, `time`
* **Math functions** – `round`, `floor`, `ceiling`
* **Lambda operators** – `any` and `all` for collection-valued properties
* **Literal types** – strings, numbers, booleans, null, dates, datetime offsets, time of day, durations, GUIDs, and namespaced enum values

If a real-world `$filter` runs through it cleanly, the AST will have a node for every piece of it.

### Walking an AST

Most things you do with the parser involve walking the AST. The shape is recursive: each node either is a leaf (`LiteralExpr`, `PropertyExpr`) or carries children (`ComparisonExpr.left` and `right`, `LogicalExpr.left` and `right`, `FunctionCallExpr.args`, `LambdaExpr.body`, and so on).

A simple visitor that collects every property reference looks like this:

```typescript
import { parseFilter, type FilterExpression } from '@reso-standards/odata-expression-parser';

const collectProperties = (expr: FilterExpression): ReadonlyArray<string> => {
  switch (expr.type) {
    case 'property':
      return [expr.name];
    case 'literal':
      return [];
    case 'comparison':
    case 'logical':
    case 'arithmetic':
      return [...collectProperties(expr.left), ...collectProperties(expr.right)];
    case 'not':
      return collectProperties(expr.operand);
    case 'function':
      return expr.args.flatMap(collectProperties);
    case 'lambda':
      return collectProperties(expr.body);
    case 'collection':
      return expr.values.flatMap(collectProperties);
    default:
      return [];
  }
};

const ast = parseFilter("ListPrice gt 200000 and City eq 'Austin'");
console.log(collectProperties(ast));
// → [ 'ListPrice', 'City' ]
```

The same shape – a single switch over `expr.type` – is the right pattern for almost any walk. Translate it to SQL, render it as a UI, validate it against a schema, count operators – the visitor structure stays the same.

### Lambda Expressions

Lambda expressions are the OData way of querying collection-valued properties. They look like this:

```
Rooms/any(r: r/Area gt 200)
```

Translated: "any room whose area is greater than 200." The `r:` is the variable binding, and `r/Area` is a property path that uses the bound variable.

The parser handles them as `LambdaExpr` nodes with a `variable`, an `operator` (`any` or `all`), and a `body` that is itself a filter expression. The body can use the bound variable as a property path prefix:

```typescript
const ast = parseFilter("Rooms/any(r: r/Area gt 200 and r/RoomType eq 'Bedroom')");
// LambdaExpr {
//   variable: 'r',
//   operator: 'any',
//   path: 'Rooms',
//   body: LogicalExpr { ... }
// }
```

If you are walking the AST to translate it to another query language, lambdas are usually the most interesting part – they map to `EXISTS` clauses in SQL, `$elemMatch` in MongoDB, and similar concepts elsewhere.

---

## Round-Tripping a Filter

Once you have an AST, you can convert it back to a canonical OData filter string with `astToFilterString`. The output is always normalized: consistent spacing, parentheses where they are needed for precedence, and nothing more.

```typescript
import { parseFilter, astToFilterString } from '@reso-standards/odata-expression-parser';

const original = "ListPrice gt 200000   AND  contains(City,'Austin')";
const ast = parseFilter(original);
const normalized = astToFilterString(ast);
// → "ListPrice gt 200000 and contains(City, 'Austin')"
```

This is useful for several common tasks:

### Normalize Filters Before Logging or Comparing

If you log every incoming `$filter` and want to dedupe them, normalizing through the parser turns "the same query written three different ways" into the same string.

```typescript
const a = parseFilter("ListPrice  GT  200000");
const b = parseFilter("ListPrice gt 200000");
astToFilterString(a) === astToFilterString(b); // true
```

### Build a Filter Programmatically and Render It

You can also construct an AST by hand (the node types are all exported) and serialize it. This is the cleanest way to build a filter from a query UI without string concatenation:

```typescript
import {
  astToFilterString,
  type ComparisonExpr,
  type LogicalExpr,
} from '@reso-standards/odata-expression-parser';

const cityFilter: ComparisonExpr = {
  type: 'comparison',
  operator: 'eq',
  left: { type: 'property', name: 'City' },
  right: { type: 'literal', value: 'Austin', dataType: 'string' },
};

const priceFilter: ComparisonExpr = {
  type: 'comparison',
  operator: 'gt',
  left: { type: 'property', name: 'ListPrice' },
  right: { type: 'literal', value: 200000, dataType: 'number' },
};

const combined: LogicalExpr = {
  type: 'logical',
  operator: 'and',
  left: cityFilter,
  right: priceFilter,
};

console.log(astToFilterString(combined));
// → "City eq 'Austin' and ListPrice gt 200000"
```

No string concatenation, no escaping concerns, no risk of producing an invalid query – the type system enforces that every node is well-formed.

### Transform a Filter

Because the AST is immutable, transformations are functional. Replace a property reference, swap an operator, push a constant through – whatever you need:

```typescript
import {
  parseFilter,
  astToFilterString,
  type FilterExpression,
} from '@reso-standards/odata-expression-parser';

// Rename ListPrice to Price everywhere in the expression
const renameProperty = (expr: FilterExpression, from: string, to: string): FilterExpression => {
  switch (expr.type) {
    case 'property':
      return expr.name === from ? { ...expr, name: to } : expr;
    case 'comparison':
    case 'logical':
    case 'arithmetic':
      return {
        ...expr,
        left: renameProperty(expr.left, from, to),
        right: renameProperty(expr.right, from, to),
      };
    case 'not':
      return { ...expr, operand: renameProperty(expr.operand, from, to) };
    case 'function':
      return { ...expr, args: expr.args.map((a) => renameProperty(a, from, to)) };
    case 'lambda':
      return { ...expr, body: renameProperty(expr.body, from, to) };
    default:
      return expr;
  }
};

const ast = parseFilter("ListPrice gt 200000 and BedroomsTotal ge 3");
const renamed = renameProperty(ast, 'ListPrice', 'Price');
console.log(astToFilterString(renamed));
// → "Price gt 200000 and BedroomsTotal ge 3"
```

The same pattern works for any rewrite: aliasing, namespace stripping, dialect translation.

---

## Parsing an Expand

The second main entry point is `parseExpand`. It turns an `$expand` string into a structured tree that supports nested expansions and inline query options.

```typescript
import { parseExpand } from '@reso-standards/odata-expression-parser';

parseExpand('Media');
// → [{ property: "Media", options: {} }]
```

Each element of the result is an `ExpandExpression` with a `property` (the name of the navigation property to expand) and an `options` object (any inline query parameters).

### Inline Query Options

OData lets you embed `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`, and `$levels` inside an `$expand` clause to scope the expansion. The parser pulls these out into a typed object:

```typescript
parseExpand('Media($select=MediaURL,MediaKey;$top=5;$orderby=Order asc)');
// → [{
//     property: "Media",
//     options: {
//       $select: "MediaURL,MediaKey",
//       $top: 5,
//       $orderby: "Order asc"
//     }
//   }]
```

The supported options:

| Option | Type | Example |
|---|---|---|
| `$select` | `string` | `Media($select=MediaURL,MediaKey)` |
| `$filter` | `string` | `Media($filter=MediaType eq 'Photo')` |
| `$orderby` | `string` | `Media($orderby=Order asc)` |
| `$top` | `number` | `Media($top=5)` |
| `$skip` | `number` | `Media($skip=10)` |
| `$count` | `boolean` | `Media($count=true)` |
| `$expand` | nested expand tree | `Rooms($expand=Media)` |
| `$levels` | `number` or `"max"` | `Children($levels=3)` |

### Nested Expansion

Multi-level `$expand` is the most useful and the most error-prone thing to write by hand. The parser handles it transparently:

```typescript
parseExpand('Rooms($expand=Media($select=MediaURL)),BuyerAgent');
// → [
//     { property: "Rooms", options: {
//         $expand: [{ property: "Media", options: { $select: "MediaURL" } }]
//     }},
//     { property: "BuyerAgent", options: {} }
//   ]
```

That tree is recursive in exactly the way the OData grammar is recursive. A walker that prints every property in an expand graph is the same shape as the property collector for filters:

```typescript
import { parseExpand, type ExpandExpression } from '@reso-standards/odata-expression-parser';

const collectExpandPaths = (
  exprs: ReadonlyArray<ExpandExpression>,
  prefix = ''
): ReadonlyArray<string> =>
  exprs.flatMap((e) => {
    const path = prefix ? `${prefix}/${e.property}` : e.property;
    const childPaths = e.options.$expand
      ? collectExpandPaths(e.options.$expand, path)
      : [];
    return [path, ...childPaths];
  });

const tree = parseExpand('Rooms($expand=Media,Showings),BuyerAgent($expand=Office)');
console.log(collectExpandPaths(tree));
// → [
//     'Rooms', 'Rooms/Media', 'Rooms/Showings',
//     'BuyerAgent', 'BuyerAgent/Office'
//   ]
```

### `$levels` for Recursive Expansion

For self-referential navigation properties (like a tree of categories or a hierarchy of folders), OData supports `$levels`:

```typescript
parseExpand('Children($levels=3)');
// → [{ property: "Children", options: { $levels: 3 } }]

parseExpand('Children($levels=max)');
// → [{ property: "Children", options: { $levels: "max" } }]
```

The parser preserves both the numeric and `"max"` forms. What you do with them downstream depends on your server.

---

## Putting It All Together

A small but realistic example: a function that takes an OData `$filter` string, validates that every property reference exists in a known schema, and returns either the cleaned-up canonical form or an error.

```typescript
import {
  parseFilter,
  astToFilterString,
  type FilterExpression,
} from '@reso-standards/odata-expression-parser';

interface ValidationResult {
  readonly ok: boolean;
  readonly normalized?: string;
  readonly errors?: ReadonlyArray<string>;
}

const collectProperties = (expr: FilterExpression): ReadonlyArray<string> => {
  switch (expr.type) {
    case 'property':
      return [expr.name];
    case 'literal':
      return [];
    case 'comparison':
    case 'logical':
    case 'arithmetic':
      return [...collectProperties(expr.left), ...collectProperties(expr.right)];
    case 'not':
      return collectProperties(expr.operand);
    case 'function':
      return expr.args.flatMap(collectProperties);
    case 'lambda':
      return collectProperties(expr.body);
    case 'collection':
      return expr.values.flatMap(collectProperties);
    default:
      return [];
  }
};

const validateFilter = (
  filterString: string,
  knownProperties: ReadonlySet<string>
): ValidationResult => {
  let ast: FilterExpression;
  try {
    ast = parseFilter(filterString);
  } catch (err) {
    return {
      ok: false,
      errors: [`Parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const referenced = collectProperties(ast);
  const unknown = referenced.filter((name) => !knownProperties.has(name));

  if (unknown.length > 0) {
    return {
      ok: false,
      errors: unknown.map((name) => `Unknown property: ${name}`),
    };
  }

  return { ok: true, normalized: astToFilterString(ast) };
};

const schema = new Set(['ListPrice', 'City', 'BedroomsTotal']);

console.log(validateFilter("ListPrice gt 200000 and City eq 'Austin'", schema));
// → { ok: true, normalized: "ListPrice gt 200000 and City eq 'Austin'" }

console.log(validateFilter("Bedroms gt 3", schema));
// → { ok: false, errors: ['Unknown property: Bedroms'] }
```

That is the same idea behind `validateQueryOptions` in **[`@reso-standards/reso-client`](../reso-client/)** – the client calls this parser, walks the AST against entity-type metadata, and surfaces field-level errors before any HTTP traffic.

---

## Where to Next

* **Calling a server** – the **[RESO Client SDK](../reso-client/)** uses this parser internally and gives you a higher-level API for fetching, validating, and round-tripping queries against any RESO-compliant server. If you want to *send* a query, start there.
* **Building a server** – the **[RESO Reference Server](../reso-reference-server/)** uses this parser to translate `$filter` into SQL `WHERE` clauses. If you want to see what a full server-side translation looks like, the source is a good reference.
* **Validating records** – the **[reso-validation](../reso-validation/)** library handles field-level validation against the Data Dictionary. Pair it with this parser when you need both query validation and record validation in the same tool.

## Reference

* **[Package README](../)** – full API surface, supported features, and AST node type table
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/odata-expression-parser)**
* **[npm Package](https://www.npmjs.com/package/@reso-standards/odata-expression-parser)**
* **[OData 4.01 Part 2: URL Conventions](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part2-url-conventions.html)** – the spec that defines the grammar this parser implements
