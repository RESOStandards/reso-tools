#!/usr/bin/env node
/**
 * Lint and normalize a DD XLSX reference sheet.
 *
 * Rewrites the dd.reso.org URLs deterministically (script-side formula, no Excel
 * formulas — those bloat the file). Applied each lint run on any DD version.
 *
 * Six targets per row:
 *
 *   Fields tab
 *     - ResourceName cell:   hyperlink   → /DD{ver}/{ResourceName}/
 *     - StandardName cell:   hyperlink   → /DD{ver}/{ResourceName}/{StandardName}/
 *     - WikiPageUrl cell:    value+link  → /DD{ver}/{ResourceName}/{StandardName}/
 *
 *   Lookups tab
 *     - LookupName cell:           hyperlink   → /DD{ver}/lookups/{LookupName}/
 *     - StandardLookupValue cell:  hyperlink   → /DD{ver}/lookups/{LookupName}/{enc(StandardLookupValue)}/
 *     - WikiPageUrl cell:          value+link  → /DD{ver}/lookups/{LookupName}/{enc(StandardLookupValue)}/
 *
 * Cell *values* on the name/value columns are not changed — only the attached
 * hyperlink target. Only WikiPageUrl gets its value rewritten.
 *
 * Usage: node lint-dd-sheet.js <input.xlsx> <version> [output.xlsx]
 */

import { resolve } from 'node:path';
const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));

const [,, inputPath, version, outputPath] = process.argv;
if (!inputPath || !version) {
  console.log('Usage: lint-dd-sheet.js <input.xlsx> <version> [output.xlsx]');
  process.exit(0);
}

const out = outputPath ?? inputPath;
const BASE = `https://dd.reso.org/DD${version}`;

const wb = XLSX.readFile(resolve(inputPath));

const headerIndexes = (sheet) => {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (cell?.v != null) headers[String(cell.v)] = c;
  }
  return { headers, range };
};

const cellAt = (sheet, r, c) => sheet[XLSX.utils.encode_cell({ r, c })];

const ensureCell = (sheet, r, c) => {
  const addr = XLSX.utils.encode_cell({ r, c });
  if (!sheet[addr]) sheet[addr] = { t: 's', v: '' };
  return sheet[addr];
};

const setLink = (cell, target) => {
  // Replace any existing hyperlink with a clean target. SheetJS rebuilds rels on write.
  cell.l = { Target: target };
};

const setValueAndLink = (cell, value, target) => {
  cell.t = 's';
  cell.v = value;
  cell.w = value;
  cell.l = { Target: target };
};

const stats = {
  fields: { rows: 0, resourceLink: 0, fieldLink: 0, wikiUrlValue: 0, wikiUrlLink: 0, skipped: 0 },
  lookups: { rows: 0, lookupNameLink: 0, standardValueLink: 0, wikiUrlValue: 0, wikiUrlLink: 0, skipped: 0 },
};

const lintFields = () => {
  const sheet = wb.Sheets['Fields'];
  if (!sheet) return;
  const { headers, range } = headerIndexes(sheet);
  const cResource = headers['ResourceName'];
  const cField = headers['StandardName'];
  const cUrl = headers['WikiPageUrl'];
  if (cResource == null || cField == null || cUrl == null) {
    console.error('Fields tab missing ResourceName/StandardName/WikiPageUrl columns');
    process.exit(1);
  }
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    stats.fields.rows++;
    const resourceCell = cellAt(sheet, r, cResource);
    const fieldCell = cellAt(sheet, r, cField);
    const resourceName = resourceCell?.v;
    const fieldName = fieldCell?.v;
    if (!resourceName || !fieldName) { stats.fields.skipped++; continue; }

    const resourceUrl = `${BASE}/${encodeURIComponent(String(resourceName))}/`;
    const fieldUrl = `${BASE}/${encodeURIComponent(String(resourceName))}/${encodeURIComponent(String(fieldName))}/`;

    // Resource name hyperlink
    if (resourceCell.l?.Target !== resourceUrl) stats.fields.resourceLink++;
    setLink(resourceCell, resourceUrl);

    // Field name hyperlink
    if (fieldCell.l?.Target !== fieldUrl) stats.fields.fieldLink++;
    setLink(fieldCell, fieldUrl);

    // WikiPageUrl value + hyperlink
    const urlCell = ensureCell(sheet, r, cUrl);
    if (urlCell.v !== fieldUrl) stats.fields.wikiUrlValue++;
    if (urlCell.l?.Target !== fieldUrl) stats.fields.wikiUrlLink++;
    setValueAndLink(urlCell, fieldUrl, fieldUrl);
  }
};

const lintLookups = () => {
  const sheet = wb.Sheets['Lookups'];
  if (!sheet) return;
  const { headers, range } = headerIndexes(sheet);
  const cLookupName = headers['LookupName'];
  const cStandardValue = headers['StandardLookupValue'] ?? headers['LookupDisplayName'];
  const cUrl = headers['WikiPageUrl'];
  if (cLookupName == null || cStandardValue == null || cUrl == null) {
    console.error('Lookups tab missing LookupName/StandardLookupValue/WikiPageUrl columns');
    process.exit(1);
  }
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    stats.lookups.rows++;
    const nameCell = cellAt(sheet, r, cLookupName);
    const valueCell = cellAt(sheet, r, cStandardValue);
    const lookupName = nameCell?.v;
    const standardLookupValue = valueCell?.v;
    if (!lookupName || !standardLookupValue) { stats.lookups.skipped++; continue; }

    const enumUrl = `${BASE}/lookups/${encodeURIComponent(String(lookupName))}/`;
    const valueUrl = `${BASE}/lookups/${encodeURIComponent(String(lookupName))}/${encodeURIComponent(String(standardLookupValue))}/`;

    // LookupName hyperlink → enum page
    if (nameCell.l?.Target !== enumUrl) stats.lookups.lookupNameLink++;
    setLink(nameCell, enumUrl);

    // StandardLookupValue hyperlink → lookup value page
    if (valueCell.l?.Target !== valueUrl) stats.lookups.standardValueLink++;
    setLink(valueCell, valueUrl);

    // WikiPageUrl value + hyperlink
    const urlCell = ensureCell(sheet, r, cUrl);
    if (urlCell.v !== valueUrl) stats.lookups.wikiUrlValue++;
    if (urlCell.l?.Target !== valueUrl) stats.lookups.wikiUrlLink++;
    setValueAndLink(urlCell, valueUrl, valueUrl);
  }
};

lintFields();
lintLookups();

// Drop per-cell formatted-text / rich-text / HTML-rep metadata that SheetJS
// keeps from the read pass — not needed and keeps the output smaller.
for (const sn of wb.SheetNames) {
  const sheet = wb.Sheets[sn];
  for (const ref in sheet) {
    if (ref.startsWith('!')) continue;
    const c = sheet[ref];
    delete c.w;
    delete c.h;
    delete c.r;
  }
}

XLSX.writeFile(wb, resolve(out), { compression: true });

console.log(`Linted: ${out}`);
console.log(`  Fields:  rows=${stats.fields.rows} resource-link=${stats.fields.resourceLink} field-link=${stats.fields.fieldLink} wiki-value=${stats.fields.wikiUrlValue} wiki-link=${stats.fields.wikiUrlLink} skipped=${stats.fields.skipped}`);
console.log(`  Lookups: rows=${stats.lookups.rows} name-link=${stats.lookups.lookupNameLink} value-link=${stats.lookups.standardValueLink} wiki-value=${stats.lookups.wikiUrlValue} wiki-link=${stats.lookups.wikiUrlLink} skipped=${stats.lookups.skipped}`);
