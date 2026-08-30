/**
 * Generates the **Scenario Catalog** – a canonical, machine-generated index of every Web API
 * Core test scenario, one stable anchor (`scenario-<tag>`) per scenario, for the published
 * spec's appendix. Section 3.5's per-test `[Source]` links deep-link into it (replacing the
 * retired web-api-commander `.feature` links). Generated from `scenarios.ts` so the spec and the
 * runner cannot drift: regenerate on any scenario change (see the CLI at the bottom of this file
 * and `tests/web-api-core/scenario-catalog.test.ts`), then paste the output into the spec.
 */

import { type CoreScenario, allScenarios } from './scenarios.js';

/** The stable in-document anchor for a scenario – the target of §3.5 `[Source]` links. */
export const scenarioAnchor = (tag: string): string => `scenario-${tag}`;

const versionTag = (s: CoreScenario): string => `${s.minVersion} · ${s.optional ? 'Optional' : 'Required'}`;

const dataTypeLabel = (dt: 'integer' | 'decimal' | 'date' | 'datetime'): string =>
  dt === 'datetime' ? 'a timestamp field' : dt === 'integer' ? 'an integer field' : `a ${dt} field`;

/** A one-line description of what a scenario checks, derived from its typed definition. */
export const describeScenario = (s: CoreScenario): string => {
  switch (s.category) {
    case 'structural':
      switch (s.assertion) {
        case 'metadata':
          return 'Request and validate server `$metadata` (EDMX; XSD + semantic validation).';
        case 'service-document':
          return 'Request and validate the OData service document.';
        case 'fetch-by-key':
          return 'Retrieve a single record by its key field.';
        case 'select':
          return '`$select` returns only the requested fields.';
        case 'top':
          return '`$top` limits the number of records returned.';
        case 'skip':
          return '`$skip` offsets the result set.';
        case 'count':
          return '`$count` returns the total record count.';
      }
      return '';
    case 'filter': {
      const parts = [`\`$filter\` on ${dataTypeLabel(s.dataType)}: \`${s.op}\``];
      if (s.compound) parts.push(`compound \`${s.compound.logical}\` with \`${s.compound.op2}\``);
      if (s.negated) parts.push('wrapped in `not()`');
      return `${parts.join(', ')}.`;
    }
    case 'orderby':
      return `\`$orderby\` ${s.direction}${s.filter ? ' with an integer filter' : ''}.`;
    case 'enum':
      return `\`$filter\` on a ${s.enumType}-valued enumeration: \`${s.op}\`.`;
    case 'collection':
      return `\`$filter\` with the \`${s.lambda}()\` lambda over a multi-valued collection.`;
    case 'error':
      return `A malformed query MUST return HTTP ${s.expectedStatus}.`;
    case 'string-enum':
      return `\`$filter\` on a string-backed ${s.enumType}-valued enumeration: \`${s.op}\`.`;
    case 'string-function':
      return `\`$filter\` string function \`${s.func}()\` – Optional Test, not required for Core certification.`;
    case 'paging':
      return 'Server-driven paging via `@odata.nextLink`; `$top=1` MUST NOT return a nextLink.';
    case 'expand':
      return '`$expand` a navigation property and validate the expanded data set.';
    case 'in-operator':
      return "`$filter … in ('a','b','c')` on a single-valued enumeration – OData 4.01, gated on the server advertising `OData-Version: 4.01`.";
    case 'lookup-resource':
      return 'Fetch the Lookup Resource by `LookupName` and validate the declared name and sample values are present.';
  }
};

/** Category grouping + display order for the catalog. An optional `note` prints under the heading. */
const CATEGORY_ORDER: ReadonlyArray<{ readonly key: CoreScenario['category']; readonly label: string; readonly note?: string }> = [
  { key: 'structural', label: 'Structural' },
  { key: 'filter', label: 'Filter (scalar comparisons)' },
  { key: 'orderby', label: 'Order By' },
  { key: 'enum', label: 'Enumerations' },
  { key: 'collection', label: 'Collections (lambda operators)' },
  { key: 'error', label: 'Error Responses' },
  { key: 'lookup-resource', label: 'Lookup Resource (2.1.0)' },
  { key: 'string-enum', label: 'String Enumerations (2.1.0)' },
  { key: 'in-operator', label: '`in` Operator (2.1.0)' },
  { key: 'paging', label: 'Server-Driven Paging (2.1.0)' },
  { key: 'expand', label: 'Expand (2.1.0)' },
  {
    key: 'string-function',
    label: 'String Functions (Optional)',
    note: 'These string comparison operators are **not required** for Web API Core certification. They are exercised as OData functions because some providers support them, and we want to recognize that support – a failure here is only ever reported as "Not Supported" and never affects the Core verdict.'
  },
];

/**
 * The full Scenario Catalog as markdown. One table per category; each row carries an inline
 * `<a id="scenario-<tag>">` anchor so `[Source](#scenario-<tag>)` from §3.5 lands on it.
 */
export const generateScenarioCatalog = (): string => {
  const lines: string[] = [
    '## Web API Core Scenario Catalog',
    '',
    "This catalog is generated from the RESO certification tool's scenario definitions and is the canonical list of Web API Core test scenarios. Each Testing Query in Section 3.5 links to its entry here by a stable `scenario-<id>` anchor. It is generated – do not edit by hand; regenerate when the scenario set changes.",
    ''
  ];
  for (const { key, label, note } of CATEGORY_ORDER) {
    const rows = allScenarios.filter(s => s.category === key);
    if (rows.length === 0) continue;
    lines.push(`### ${label}`, '');
    if (note) lines.push(note, '');
    lines.push('| Scenario | Version | What it checks |', '| --- | --- | --- |');
    for (const s of rows) {
      lines.push(
        `| <a id="${scenarioAnchor(s.tag)}"></a>**\`${s.tag}\`** – ${s.name} | ${versionTag(s)} | ${describeScenario(s)} |`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
};

// Print the catalog to stdout when run directly: `npx tsx src/web-api-core/scenario-catalog.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(generateScenarioCatalog());
}
