import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// RESO style forbids the em dash. These strings are user-visible: an assertion message reaches the
// desktop Failure Report modal, the CLI output and the downloaded results JSON, so a vendor reads
// them verbatim. The earlier writing-conventions sweep covered prose files and never reached the
// engine's own strings, which is why 2026-10-15's Failure Report still showed "schema-invalid
// against Property - item 0" to a certifying provider.
//
// Scoped to STRING LITERALS on purpose. Comments carry the same dash and are not user-visible;
// sweeping them produces a diff that touches nearly every file and conflicts with every open
// branch, which is why the earlier blanket sweep was abandoned rather than merged.
//
// Parsed with the TypeScript compiler rather than a hand-rolled scanner. Two hand-rolled versions
// were wrong in opposite directions before this one: the first skipped each `${...}` wholesale and
// passed six strings whose em dash sat in a nested template inside the interpolation, and the
// second, fixed to recurse, read the regex literal in `replace(/'/g, "''")` as an opening quote and
// reported whole comment blocks as string text. The compiler already knows the grammar.

const SRC = join(fileURLToPath(new URL('../', import.meta.url)), 'src');
const EM_DASH = '—';

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs)$/.test(entry.name) ? [full] : [];
  });

/** Every literal kind whose `.text` is characters a user can read. */
const TEXT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail
]);

const offenders = (file: string): ReadonlyArray<string> => {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(EM_DASH)) return [];
  const parsed = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines = src.split('\n');
  const relative = file.slice(file.indexOf('/src/') + 1);

  const collect = (node: ts.Node): ReadonlyArray<string> => {
    const here =
      TEXT_KINDS.has(node.kind) && (node as ts.LiteralLikeNode).text.includes(EM_DASH)
        ? [
            ((): string => {
              const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
              return `${relative}:${line + 1}: ${lines[line].trim().slice(0, 120)}`;
            })()
          ]
        : [];
    return [...here, ...node.getChildren(parsed).flatMap(collect)];
  };

  return collect(parsed);
};

describe('user-visible strings carry no em dash', () => {
  it('has none anywhere in the certification source', () => {
    const found = sourceFiles(SRC).flatMap(offenders);
    expect(found).toEqual([]);
  });

  it('reads text inside a nested template, where two earlier scanners did not', () => {
    // The exact shape that shipped six em dashes past the first version of this gate.
    const sample = "const m = `HTTP ${s}${b ? ` — ${b}` : ''}`;";
    const parsed = ts.createSourceFile('sample.ts', sample, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): boolean =>
      (TEXT_KINDS.has(node.kind) && (node as ts.LiteralLikeNode).text.includes(EM_DASH)) || node.getChildren(parsed).some(walk);
    expect(walk(parsed)).toBe(true);
  });

  it('does not read a regex literal as an opening quote', () => {
    // `replace(/'/g, "''")` in queries.ts derailed the second scanner, which then reported the
    // comments after it as string text.
    const sample = "const q = (v: string) => `'${v.replace(/'/g, \"''\")}'`;\n// a comment — with a dash\n";
    const parsed = ts.createSourceFile('sample.ts', sample, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): boolean =>
      (TEXT_KINDS.has(node.kind) && (node as ts.LiteralLikeNode).text.includes(EM_DASH)) || node.getChildren(parsed).some(walk);
    expect(walk(parsed)).toBe(false);
  });
});
