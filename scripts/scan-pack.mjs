#!/usr/bin/env node
/**
 * Scan the packed artifact for organization identifiers before it is published.
 *
 * Why it scans the TARBALL rather than a diff: a review of each change is structurally blind to
 * anything committed before the review began. A README example that carried a real identifier
 * from the start never appears in a later diff, so release after release can pass review while
 * still shipping it — and npm renders that README as the package page.
 *
 * Scanning what `npm pack` produces closes it, because the tarball is the thing that actually
 * leaves. A file is either in it or it is not, independent of what any diff contained.
 *
 * SCOPE: identifiers only, deliberately. A vendor-name denylist committed to a public repository
 * would be a file listing vendor names, which defeats its own purpose. The identifier pattern is the
 * mechanical half, and it is the half a human reviewer skims past.
 *
 *   node scripts/scan-pack.mjs <workspace-name>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sanctioned identifiers, as literal values and never as patterns.
 *
 * Publishing the list is safe, and is the reverse of publishing a denylist: every entry is either
 * public already (RESO's own identifier) or invented. New examples take a canonical synthetic
 * value. The two legacy entries are kept rather than renamed, because renaming an identifier that
 * is already synthetic buys no safety and churns a legacy file.
 */
const SENTINELS = [
  ['T00000012', "RESO's own identifier - correct to use in an example"],
  ['T00000000', 'canonical synthetic provider UOI - use this in new examples'],
  ['M00000000', 'canonical synthetic recipient UOI - use this in new examples'],
  ['M00000123', 'synthetic recipient UOI in the legacy job-state shapes'],
  ['99999', 'canonical synthetic USI - use this in new examples'],
  ['50000', 'synthetic USI in the legacy job-state shapes'],
];

/**
 * A sentinel is bounded so it cannot act as a PREFIX that hides a real value behind it: `99999`
 * must not exempt `999991`. A word boundary alone is not enough, because `-` is a non-word
 * character and `\b` matches right before it, so `M00000000` would exempt `M00000000-12345`.
 */
const bound = (value) =>
  new RegExp(`(?<![A-Za-z0-9_-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);

const ALLOW = SENTINELS.map(([value]) => bound(value));

/**
 * `usi` as a key name rather than as three letters, so prose does not fire the rule: the substring
 * appears in `using`, which would otherwise put a context hit on most English paragraphs.
 */
const USI_KEY = /Usi(?![A-Za-z])|USI(?![A-Za-z])|(?<![A-Za-z])usi(?![A-Za-z])/;

/**
 * Two rules. A UOI is self-identifying, so it fires on its own. A USI is a bare number that would
 * match thousands of innocent integers, so it fires only near a key that names it — which is also
 * why a bare USI in an example is so easy for a human reader to miss.
 *
 * The letter class is deliberately generous, and is not a claim about which prefixes exist:
 * over-firing costs a reviewer a glance, under-firing publishes an identifier.
 */
const RULES = [
  { id: 'uoi', pattern: /\b[TMA]\d{8}\b/g, message: 'organization UOI' },
  {
    id: 'usi',
    pattern: /\b\d{4,6}\b/g,
    context: USI_KEY,
    window: 40,
    message: 'bare number beside a USI key',
  },
];

/** Text we can meaningfully read. Anything else is skipped rather than guessed at. */
const TEXT = /\.(md|json|map|js|cjs|mjs|ts|txt|yml|yaml|xml|xsd|html)$/i;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });

/** The characters either side of a match, for a contextual rule to read. */
const around = (line, match, window) =>
  line.slice(Math.max(0, match.index - window), match.index + match[0].length + window);

const findingsIn = (file, root) => {
  const rel = file.slice(root.length + 1);
  if (!TEXT.test(file) || statSync(file).size > 8_000_000) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  return lines.flatMap((line, i) =>
    RULES.flatMap((rule) =>
      [...line.matchAll(rule.pattern)]
        // A sentinel exempts only when it covers what the rule flagged. A rule that matches a
        // fragment of its own target cannot be whitelisted, and that is a rule defect rather than
        // something to paper over with a wider window here.
        .filter((m) => !ALLOW.some((a) => a.test(m[0])))
        .filter((m) => !rule.context || rule.context.test(around(line, m, rule.window)))
        .map((m) => ({
          rel,
          line: i + 1,
          rule: rule.id,
          id: m[0],
          message: rule.message,
          text: line.trim().slice(0, 120),
        }))
    )
  );
};

const workspace = process.argv[2];
if (!workspace) {
  console.error('usage: node scripts/scan-pack.mjs <workspace-name>');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'scan-pack-'));
try {
  // Pack exactly what publish would send, then read it back.
  const packed = execFileSync('npm', ['pack', '-w', workspace, '--pack-destination', work], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['-xzf', join(work, packed), '-C', work]);

  const root = join(work, 'package');
  const findings = walk(root).flatMap((f) => findingsIn(f, root));

  if (findings.length === 0) {
    console.log(
      `scan-pack: clean — ${workspace} (${packed}) — ${RULES.length} rules, ${SENTINELS.length} sanctioned identifiers`
    );
    process.exit(0);
  }

  console.error(`scan-pack: ${findings.length} organization identifier(s) in ${packed}\n`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.rel}:${f.line}  ${f.id}  -> ${f.message}`);
    console.error(`    ${f.text}`);
  }
  console.error(
    '\nUse a synthetic identifier, or add a sanctioned one to SENTINELS in this file.' +
      "\nRESO's own identifier is allowed; see the Style Guide, \"Naming Organizations in" +
      '\nDocumentation and Marketing".'
  );
  process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
