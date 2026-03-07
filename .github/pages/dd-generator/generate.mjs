#!/usr/bin/env node

/**
 * RESO Data Dictionary Documentation Generator
 *
 * Reads DD CSV files (fields + lookups) for each version,
 * optionally fetches usage stats from the RESO aggs API,
 * and generates complete standalone HTML pages.
 *
 * Output directory: dd-output/ (copied into _site/dd/ by the workflow)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(__dirname, '..');
const DD_DATA_DIR = join(PAGES_DIR, 'dd-data');
const OUTPUT_DIR = join(PAGES_DIR, 'dd-output');

const VERSIONS = [
  { version: '1.7', label: 'DD 1.7', draft: false },
  { version: '2.0', label: 'DD 2.0', draft: false },
  { version: '2.1', label: 'DD 2.1', draft: true },
];

const DEFINITION_TRUNCATE_LENGTH = 150;

// ---------------------------------------------------------------------------
// CSV Parser — handles quoted fields with commas, newlines, escaped quotes
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      let value = '';
      if (text[i] === '"') {
        i++;
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            value += text[i];
            i++;
          }
        }
      } else {
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          value += text[i];
          i++;
        }
      }
      row.push(value);
      if (i < len && text[i] === ',') {
        i++;
      } else {
        break;
      }
    }
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = (row[idx] || '').trim();
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

function loadVersion(version) {
  const fieldsPath = join(DD_DATA_DIR, version, 'fields.csv');
  const lookupsPath = join(DD_DATA_DIR, version, 'lookups.csv');

  const fields = parseCSV(readFileSync(fieldsPath, 'utf8'));
  const lookups = parseCSV(readFileSync(lookupsPath, 'utf8'));

  const resourceMap = {};
  for (const field of fields) {
    const rn = field.ResourceName;
    if (!rn) continue;
    if (!resourceMap[rn]) resourceMap[rn] = [];
    resourceMap[rn].push(field);
  }

  const lookupMap = {};
  for (const lk of lookups) {
    const name = lk.LookupName;
    if (!name) continue;
    if (!lookupMap[name]) lookupMap[name] = [];
    lookupMap[name].push(lk);
  }

  return { resourceMap, lookupMap, fields, lookups };
}

// ---------------------------------------------------------------------------
// Navigation Tree Builder
// ---------------------------------------------------------------------------

function buildGroupTree(fields) {
  const tree = {};
  for (const field of fields) {
    const groups = (field.Groups || '').split(',').map(g => g.trim()).filter(Boolean);
    if (groups.length === 0) {
      if (!tree._ungrouped) tree._ungrouped = [];
      tree._ungrouped.push(field.StandardName);
      continue;
    }

    let node = tree;
    for (const group of groups) {
      if (!node[group]) node[group] = {};
      node = node[group];
    }
    if (!node._fields) node._fields = [];
    node._fields.push(field.StandardName);
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Aggs API Client
// ---------------------------------------------------------------------------

async function fetchUsageStats(versionData) {
  const { TOKEN_URI, CLIENT_ID, CLIENT_SECRET, RESO_AGGS_URL } = process.env;
  if (!TOKEN_URI || !CLIENT_ID || !CLIENT_SECRET || !RESO_AGGS_URL) {
    console.log('  Aggs API credentials not found, skipping usage stats');
    return null;
  }

  console.log('  Fetching OAuth2 token...');
  const tokenRes = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!tokenRes.ok) {
    console.warn('  Failed to get OAuth2 token:', tokenRes.status);
    return null;
  }
  const { access_token } = await tokenRes.json();

  const payload = [];
  const { resourceMap, lookupMap } = versionData;

  for (const [resourceName, fields] of Object.entries(resourceMap)) {
    const fieldNames = fields.map(f => f.StandardName).filter(Boolean);
    if (fieldNames.length > 0) {
      payload.push({ resourceName, fieldNames });
    }

    for (const field of fields) {
      if (field.LookupStatus === 'Open with Enumerations' && field.LookupName) {
        const lookupValues = (lookupMap[field.LookupName] || [])
          .map(lk => lk.StandardLookupValue)
          .filter(Boolean);
        if (lookupValues.length > 0) {
          payload.push({ resourceName, fieldName: field.StandardName, lookupValues });
        }
      }
    }
  }

  console.log(`  Fetching usage stats (${payload.length} queries)...`);
  const aggsRes = await fetch(RESO_AGGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!aggsRes.ok) {
    console.warn('  Failed to fetch aggs:', aggsRes.status);
    return null;
  }

  return aggsRes.json();
}

// ---------------------------------------------------------------------------
// HTML Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str || str.length <= len) return str || '';
  return str.slice(0, len).replace(/\s+\S*$/, '') + '...';
}

function formatPercent(mean) {
  if (mean === null || mean === undefined) return null;
  return (mean * 100).toFixed(1) + '%';
}

function usageHtml(stats) {
  if (!stats) {
    return `<div class="dd-usage dd-usage-na">
      <span class="dd-usage-label">Adoption</span><span class="dd-usage-value">&mdash;</span>
      <span class="dd-usage-label">Providers</span><span class="dd-usage-value">&mdash;</span>
      <p class="dd-usage-note">Usage data not yet available</p>
    </div>`;
  }
  return `<div class="dd-usage">
    <span class="dd-usage-label">Adoption</span><span class="dd-usage-value">${formatPercent(stats.mean)}</span>
    <span class="dd-usage-label">Providers</span><span class="dd-usage-value">${stats.recipients}</span>
  </div>`;
}

function usageBadge(stats) {
  if (!stats) return '<span class="dd-usage-badge dd-usage-badge-na">&mdash;</span>';
  return `<span class="dd-usage-badge">${formatPercent(stats.mean)}</span>`;
}

function ddUrl(version, ...parts) {
  return '/dd/DD' + version + '/' + parts.map(p => encodeURIComponent(p)).join('/') + '/';
}

function breadcrumbHtml(version, versionLabel, items) {
  let html = `<nav class="dd-breadcrumb"><a href="/dd/DD${version}/">${escapeHtml(versionLabel)}</a>`;
  for (const item of items) {
    html += ` <span class="dd-breadcrumb-sep">/</span> `;
    if (item.url) {
      html += `<a href="${item.url}">${escapeHtml(item.label)}</a>`;
    } else {
      html += `<span>${escapeHtml(item.label)}</span>`;
    }
  }
  html += '</nav>';
  return html;
}

// ---------------------------------------------------------------------------
// Full HTML Page Template
// ---------------------------------------------------------------------------

function wrapPage(title, version, sidebarHtml, contentHtml, allVersions) {
  const versionOptions = allVersions.map(v =>
    `<option value="${v.version}"${v.version === version ? ' selected' : ''}>${escapeHtml(v.label)}${v.draft ? ' (DRAFT)' : ''}</option>`
  ).join('\n          ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - RESO Data Dictionary</title>
  <meta name="description" content="${escapeHtml(title)} - RESO Data Dictionary documentation">
  <style>
    :root {
      --reso-navy: #1a2f58;
      --reso-navy-dark: #0f1d38;
      --reso-navy-light: #2a4a7f;
      --reso-orange: #ff9900;
      --reso-orange-light: #fff3e0;
      --reso-green: #38a169;
      --reso-green-light: #e6f7ed;
      --reso-blue: #007e9e;
      --reso-blue-light: #e0f4f8;
      --reso-gray-50: #f7fafc;
      --reso-gray-100: #edf2f7;
      --reso-gray-200: #e2e8f0;
      --reso-gray-300: #cbd5e0;
      --reso-gray-500: #718096;
      --reso-gray-600: #4a5568;
      --reso-gray-700: #2d3748;
      --reso-gray-800: #1a202c;
      --reso-gray-900: #171923;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: var(--reso-gray-50);
      color: var(--reso-gray-700);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .site-header {
      background: var(--reso-navy);
      padding: 0 1.5rem;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .site-header a { color: white; text-decoration: none; }
    .header-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    .header-logo img { height: 36px; width: auto; }
    .header-nav { display: flex; gap: 1.5rem; align-items: center; }
    .header-nav a {
      font-size: 0.875rem;
      font-weight: 500;
      opacity: 0.85;
      transition: opacity 0.15s;
    }
    .header-nav a:hover { opacity: 1; color: var(--reso-orange); }

    .menu-toggle {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.5rem;
      color: white;
    }
    .menu-toggle svg { width: 24px; height: 24px; fill: currentColor; }

    @media (max-width: 768px) {
      .site-header { flex-wrap: wrap; height: auto; min-height: 64px; }
      .menu-toggle { display: block; }
      .header-nav {
        display: none;
        flex-direction: column;
        width: 100%;
        gap: 0;
        padding: 0.5rem 0 1rem;
        border-top: 1px solid rgba(255,255,255,0.15);
      }
      .header-nav.open { display: flex; }
      .header-nav a {
        padding: 0.625rem 0;
        opacity: 1;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .header-nav a:last-of-type { border-bottom: none; }
      .search-trigger { margin-top: 0.5rem; justify-content: center; }
      .search-trigger kbd { display: none; }
    }

    /* Search trigger */
    .search-trigger {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 0.375rem;
      color: rgba(255,255,255,0.7);
      font-size: 0.8125rem;
      padding: 0.375rem 0.75rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.15s;
    }
    .search-trigger:hover {
      background: rgba(255,255,255,0.25);
      color: white;
    }
    .search-trigger svg { width: 14px; height: 14px; fill: currentColor; }
    .search-trigger kbd {
      font-family: inherit;
      font-size: 0.6875rem;
      background: rgba(255,255,255,0.15);
      border-radius: 0.25rem;
      padding: 0.125rem 0.375rem;
    }

    /* Search modal */
    .search-modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      align-items: flex-start;
      justify-content: center;
      padding-top: 10vh;
    }
    .search-modal-overlay.active { display: flex; }
    .search-modal {
      background: white;
      border-radius: 0.75rem;
      width: 90%;
      max-width: 640px;
      max-height: 70vh;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      display: flex;
      flex-direction: column;
    }
    .search-modal-body {
      padding: 1rem;
      overflow-y: auto;
      flex: 1;
    }
    .pagefind-ui .pagefind-ui__search-input {
      border-radius: 0.375rem !important;
      border-color: var(--reso-gray-200) !important;
      font-size: 1rem !important;
    }
    .pagefind-ui .pagefind-ui__search-input:focus {
      border-color: var(--reso-blue) !important;
      box-shadow: 0 0 0 3px rgba(0,126,158,0.15) !important;
    }
    .pagefind-ui .pagefind-ui__result-link {
      color: var(--reso-navy) !important;
    }

    /* Footer */
    .site-footer {
      background: var(--reso-navy);
      color: rgba(255,255,255,0.6);
      text-align: center;
      padding: 1.5rem;
      font-size: 0.8125rem;
    }
    .site-footer a { color: rgba(255,255,255,0.8); text-decoration: none; }
    .site-footer a:hover { color: var(--reso-orange); }

    /* DD Layout */
    .dd-layout {
      display: flex;
      flex: 1;
    }

    /* Sidebar */
    .dd-sidebar {
      width: 280px;
      min-width: 280px;
      background: white;
      border-right: 1px solid var(--reso-gray-200);
      overflow-y: auto;
      position: sticky;
      top: 64px;
      height: calc(100vh - 64px);
      padding: 1rem 0;
      font-size: 0.8125rem;
    }
    .dd-sidebar-header {
      padding: 0 1rem 0.75rem;
      border-bottom: 1px solid var(--reso-gray-200);
      margin-bottom: 0.75rem;
    }
    .dd-sidebar-title {
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--reso-navy);
      margin-bottom: 0.5rem;
    }
    .dd-version-select {
      width: 100%;
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      color: var(--reso-gray-700);
      background: white;
      cursor: pointer;
    }
    .dd-version-select:focus {
      outline: none;
      border-color: var(--reso-blue);
      box-shadow: 0 0 0 2px rgba(0,126,158,0.15);
    }

    .dd-nav-resources { list-style: none; padding: 0; margin: 0; }
    .dd-nav-resource { margin-bottom: 0.125rem; }
    .dd-nav-resource-link {
      display: block;
      padding: 0.375rem 1rem;
      color: var(--reso-gray-700);
      text-decoration: none;
      font-weight: 600;
      transition: background 0.1s;
    }
    .dd-nav-resource-link:hover,
    .dd-nav-resource-link.active {
      background: var(--reso-blue-light);
      color: var(--reso-blue);
    }

    .dd-nav-groups, .dd-nav-subgroups {
      list-style: none;
      padding: 0;
      margin: 0;
      display: none;
    }
    .dd-nav-resource.expanded > .dd-nav-groups { display: block; }
    .dd-nav-group.expanded > .dd-nav-subgroups { display: block; }

    .dd-nav-group-link {
      display: block;
      padding: 0.25rem 1rem 0.25rem 1.75rem;
      color: var(--reso-gray-600);
      text-decoration: none;
      font-size: 0.75rem;
      transition: background 0.1s;
    }
    .dd-nav-group-link:hover { background: var(--reso-gray-100); color: var(--reso-blue); }
    .dd-nav-subgroups .dd-nav-group-link { padding-left: 2.5rem; }
    .dd-nav-subgroups .dd-nav-subgroups .dd-nav-group-link { padding-left: 3.25rem; }

    /* Mobile sidebar */
    .dd-sidebar-toggle {
      display: none;
      position: fixed;
      bottom: 1rem;
      left: 1rem;
      z-index: 60;
      background: var(--reso-navy);
      color: white;
      border: none;
      border-radius: 50%;
      width: 48px;
      height: 48px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      align-items: center;
      justify-content: center;
    }
    .dd-sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.3);
      z-index: 54;
    }

    @media (max-width: 768px) {
      .dd-sidebar {
        position: fixed;
        left: -280px;
        top: 64px;
        z-index: 55;
        transition: left 0.2s ease;
        box-shadow: 4px 0 12px rgba(0,0,0,0.1);
      }
      .dd-sidebar.open { left: 0; }
      .dd-sidebar-toggle { display: flex; }
      .dd-sidebar-overlay.active { display: block; }
    }

    /* Content */
    .dd-content {
      flex: 1;
      min-width: 0;
      padding: 1.5rem 2rem;
      max-width: 1100px;
    }
    @media (max-width: 768px) {
      .dd-content { padding: 1rem; }
    }

    /* Breadcrumb */
    .dd-breadcrumb { font-size: 0.8125rem; color: var(--reso-gray-500); margin-bottom: 1rem; }
    .dd-breadcrumb a { color: var(--reso-blue); text-decoration: none; }
    .dd-breadcrumb a:hover { text-decoration: underline; }
    .dd-breadcrumb-sep { margin: 0 0.375rem; color: var(--reso-gray-300); }

    /* Page header */
    .dd-page-header { margin-bottom: 1.5rem; }
    .dd-page-header h1 { font-size: 1.5rem; font-weight: 700; color: var(--reso-gray-800); }
    .dd-page-subtitle { font-size: 0.875rem; color: var(--reso-gray-500); margin-top: 0.25rem; }

    /* Resource grid */
    .dd-resource-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
    }
    .dd-resource-card {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
      text-decoration: none;
      color: inherit;
      transition: box-shadow 0.15s, border-color 0.15s;
    }
    .dd-resource-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-color: var(--reso-blue); }
    .dd-resource-card h3 { font-size: 0.9375rem; font-weight: 600; color: var(--reso-navy); }
    .dd-resource-count { font-size: 0.75rem; color: var(--reso-gray-500); }

    /* Fields table */
    .dd-fields-table-wrapper { margin-top: 1rem; }
    .dd-group-heading {
      font-size: 1rem;
      font-weight: 600;
      color: var(--reso-navy);
      margin: 1.5rem 0 0.5rem;
      padding-bottom: 0.375rem;
      border-bottom: 2px solid var(--reso-gray-200);
    }
    .dd-group-heading:first-child { margin-top: 0; }

    .dd-fields-table, .dd-lookups-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.375rem;
      overflow: hidden;
      margin-bottom: 1rem;
    }
    .dd-fields-table th, .dd-fields-table td,
    .dd-lookups-table th, .dd-lookups-table td {
      padding: 0.5rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--reso-gray-100);
    }
    .dd-fields-table th, .dd-lookups-table th {
      background: var(--reso-gray-50);
      font-weight: 600;
      color: var(--reso-gray-600);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-fields-table tbody tr:hover, .dd-lookups-table tbody tr:hover {
      background: var(--reso-blue-light);
    }

    .dd-field-link { color: var(--reso-blue); text-decoration: none; font-weight: 600; }
    .dd-field-link:hover { text-decoration: underline; }
    .dd-field-standard-name {
      font-size: 0.6875rem;
      color: var(--reso-gray-500);
      font-family: 'SFMono-Regular', Consolas, monospace;
    }
    .dd-field-def { color: var(--reso-gray-600); max-width: 400px; }
    .dd-more-link { color: var(--reso-blue); text-decoration: none; font-size: 0.75rem; }
    .dd-more-link:hover { text-decoration: underline; }

    .dd-type-badge {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      background: var(--reso-gray-100);
      color: var(--reso-gray-600);
      white-space: nowrap;
    }

    /* Usage */
    .dd-usage {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.25rem 0.75rem;
      align-items: center;
    }
    .dd-usage-label { font-size: 0.75rem; font-weight: 600; color: var(--reso-gray-500); text-transform: uppercase; }
    .dd-usage-value { font-size: 1rem; font-weight: 700; color: var(--reso-gray-800); }
    .dd-usage-na .dd-usage-value { color: var(--reso-gray-400); }
    .dd-usage-note { grid-column: 1 / -1; font-size: 0.75rem; color: var(--reso-gray-400); font-style: italic; margin-top: 0.25rem; }
    .dd-usage-badge { font-size: 0.75rem; font-weight: 600; color: var(--reso-green); }
    .dd-usage-badge-na { color: var(--reso-gray-400); }

    /* Metadata card */
    .dd-metadata-card {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.5rem;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .dd-metadata-card h2 {
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--reso-navy);
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-metadata-card h3 { font-size: 0.8125rem; font-weight: 600; color: var(--reso-gray-600); margin-bottom: 0.5rem; }

    .dd-metadata-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    .dd-metadata-table th {
      text-align: left;
      padding: 0.375rem 0.75rem 0.375rem 0;
      color: var(--reso-gray-500);
      font-weight: 600;
      white-space: nowrap;
      vertical-align: top;
      width: 160px;
    }
    .dd-metadata-table td { padding: 0.375rem 0; color: var(--reso-gray-700); }
    .dd-metadata-table tr { border-bottom: 1px solid var(--reso-gray-100); }

    .dd-no-enums p { font-size: 0.8125rem; color: var(--reso-gray-500); font-style: italic; }

    /* Collapsible panels */
    .dd-collapsible {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      overflow: hidden;
    }
    .dd-collapsible-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0.75rem 1.25rem;
      background: var(--reso-gray-50);
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--reso-navy);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-collapsible-toggle:hover { background: var(--reso-gray-100); }
    .dd-toggle-icon { font-size: 1.25rem; font-weight: 400; color: var(--reso-gray-400); transition: transform 0.15s; }
    .dd-collapsible.open .dd-toggle-icon { transform: rotate(45deg); }
    .dd-collapsible-content { display: none; padding: 1rem 1.25rem; }
    .dd-collapsible.open .dd-collapsible-content { display: block; }

    /* Badge */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-orange { background: var(--reso-orange); color: white; }
  </style>
  <link href="/pagefind/pagefind-ui.css" rel="stylesheet">
</head>
<body>
  <header class="site-header">
    <a href="/" class="header-logo">
      <img src="/assets/reso-logo-white.png" alt="RESO" />
    </a>
    <button class="menu-toggle" id="menuToggle" type="button" aria-label="Toggle menu">
      <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
    </button>
    <nav class="header-nav" id="headerNav">
      <a href="/">Home</a>
      <a href="/dd/DD2.0/">Data Dictionary</a>
      <a href="https://github.com/RESOStandards/reso-tools">GitHub</a>
      <a href="https://reso.org">RESO.org</a>
      <button class="search-trigger" id="searchTrigger" type="button">
        <svg viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        Search<kbd>/</kbd>
      </button>
    </nav>
  </header>

  <div class="dd-layout">
    <aside class="dd-sidebar" id="ddSidebar">
      <div class="dd-sidebar-header">
        <div class="dd-sidebar-title">Data Dictionary</div>
        <select class="dd-version-select" id="ddVersionSelect" onchange="window.location.href='/dd/DD' + this.value + '/'">
          ${versionOptions}
        </select>
      </div>
      ${sidebarHtml}
    </aside>

    <div class="dd-sidebar-overlay" id="ddSidebarOverlay"></div>
    <button class="dd-sidebar-toggle" id="ddSidebarToggle" type="button" aria-label="Toggle sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>

    <div class="dd-content" data-pagefind-body>
      ${contentHtml}
    </div>
  </div>

  <!-- Search modal -->
  <div class="search-modal-overlay" id="searchOverlay">
    <div class="search-modal">
      <div class="search-modal-body">
        <div id="search"></div>
      </div>
    </div>
  </div>

  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} <a href="https://reso.org">Real Estate Standards Organization (RESO)</a>. All rights reserved.</p>
    <p style="margin-top: 0.5rem;">
      <a href="https://github.com/RESOStandards/reso-tools">Source</a> &middot;
      <a href="https://certification.reso.org">Certification Analytics</a> &middot;
      <a href="https://www.reso.org/eula/">Terms of Use</a>
    </p>
  </footer>

  <script src="/pagefind/pagefind-ui.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      new PagefindUI({ element: '#search', showSubResults: true, showImages: false, resetStyles: false });

      // Header hamburger
      document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('headerNav').classList.toggle('open');
      });

      // Search modal
      var overlay = document.getElementById('searchOverlay');
      document.getElementById('searchTrigger').addEventListener('click', function() {
        overlay.classList.add('active');
        setTimeout(function() { var i = overlay.querySelector('.pagefind-ui__search-input'); if (i) i.focus(); }, 100);
      });
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.classList.remove('active'); });
      document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          overlay.classList.add('active');
          setTimeout(function() { var i = overlay.querySelector('.pagefind-ui__search-input'); if (i) i.focus(); }, 100);
        }
        if (e.key === 'Escape') overlay.classList.remove('active');
      });

      // Sidebar toggle (mobile)
      var sidebar = document.getElementById('ddSidebar');
      var sidebarOverlay = document.getElementById('ddSidebarOverlay');
      function toggleSidebar() { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); }
      document.getElementById('ddSidebarToggle').addEventListener('click', toggleSidebar);
      sidebarOverlay.addEventListener('click', toggleSidebar);

      // Expand active resource in sidebar
      document.querySelectorAll('.dd-nav-resource-link.active').forEach(function(link) {
        link.closest('.dd-nav-resource').classList.add('expanded');
      });

      // Toggle resource groups
      document.querySelectorAll('.dd-nav-resource-link').forEach(function(link) {
        link.addEventListener('click', function(e) {
          var li = link.closest('.dd-nav-resource');
          if (li.querySelector('.dd-nav-groups')) {
            li.classList.toggle('expanded');
          }
        });
      });

      // Collapsible panels
      document.querySelectorAll('.dd-collapsible-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
          btn.parentElement.classList.toggle('open');
        });
      });
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sidebar HTML Generator
// ---------------------------------------------------------------------------

function generateSidebarHtml(vCfg, data, activeResource) {
  const { version } = vCfg;
  const resources = Object.keys(data.resourceMap).sort();

  let html = '<ul class="dd-nav-resources">\n';
  for (const rn of resources) {
    const fields = data.resourceMap[rn];
    const tree = buildGroupTree(fields);
    const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();
    const isActive = rn === activeResource;

    html += `<li class="dd-nav-resource${isActive ? ' expanded' : ''}">\n`;
    html += `  <a href="${ddUrl(version, rn)}" class="dd-nav-resource-link${isActive ? ' active' : ''}">${escapeHtml(rn)}</a>\n`;

    if (childGroups.length > 0) {
      html += `  <ul class="dd-nav-groups">\n`;
      html += renderSidebarGroups(version, rn, tree, []);
      html += `  </ul>\n`;
    }
    html += `</li>\n`;
  }
  html += '</ul>\n';
  return html;
}

function renderSidebarGroups(version, resourceName, tree, path) {
  const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();
  let html = '';

  for (const group of childGroups) {
    const groupPath = [...path, group];
    const groupId = 'group-' + groupPath.join('-');
    const subGroups = Object.keys(tree[group]).filter(k => !k.startsWith('_'));

    html += `    <li class="dd-nav-group">\n`;
    html += `      <a href="${ddUrl(version, resourceName)}#${groupId}" class="dd-nav-group-link">${escapeHtml(group)}</a>\n`;
    if (subGroups.length > 0) {
      html += `      <ul class="dd-nav-subgroups">\n`;
      html += renderSidebarGroups(version, resourceName, tree[group], groupPath);
      html += `      </ul>\n`;
    }
    html += `    </li>\n`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Page Content Generators
// ---------------------------------------------------------------------------

function generateVersionLanding(vCfg, data, allVersions) {
  const { version, label, draft } = vCfg;
  const { resourceMap } = data;
  const resources = Object.keys(resourceMap).sort();

  let html = `<div class="dd-page-header"><h1>${escapeHtml(label)}`;
  if (draft) html += ' <span class="badge badge-orange">DRAFT</span>';
  html += `</h1><p class="dd-page-subtitle">RESO Data Dictionary ${escapeHtml(version)} &mdash; ${resources.length} resources, ${data.fields.length} fields</p></div>`;

  html += `<div class="dd-resource-grid">`;
  for (const rn of resources) {
    const fieldCount = resourceMap[rn].length;
    html += `<a href="${ddUrl(version, rn)}" class="dd-resource-card">`;
    html += `<h3>${escapeHtml(rn)}</h3>`;
    html += `<span class="dd-resource-count">${fieldCount} field${fieldCount !== 1 ? 's' : ''}</span>`;
    html += `</a>`;
  }
  html += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, null);
  const dir = join(OUTPUT_DIR, `DD${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(label, version, sidebarHtml, html, allVersions));
}

function generateResourcePage(vCfg, data, resourceName, usageStats, allVersions) {
  const { version, label } = vCfg;
  const fields = data.resourceMap[resourceName];
  const groupTree = buildGroupTree(fields);
  const resourceStats = usageStats?.[resourceName];

  let html = breadcrumbHtml(version, label, [{ label: resourceName }]);
  html += `<div class="dd-page-header"><h1>${escapeHtml(resourceName)}</h1>`;
  html += `<p class="dd-page-subtitle">${fields.length} fields</p></div>`;
  html += renderGroupedFields(version, resourceName, fields, groupTree, resourceStats);

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${resourceName} - ${label}`, version, sidebarHtml, html, allVersions
  ));
}

function renderGroupedFields(version, resourceName, fields, tree, resourceStats) {
  const sections = [];
  collectSections(tree, [], sections);

  let html = '<div class="dd-fields-table-wrapper">';
  for (const section of sections) {
    const groupPath = section.path.join(' > ');
    const groupId = 'group-' + section.path.join('-');

    if (section.path.length > 0) {
      html += `<h2 class="dd-group-heading" id="${escapeHtml(groupId)}">${escapeHtml(groupPath)}</h2>`;
    } else {
      html += `<h2 class="dd-group-heading" id="group-ungrouped">Other Fields</h2>`;
    }

    html += `<table class="dd-fields-table"><thead><tr>`;
    html += `<th>Field</th><th>Definition</th><th>Type</th><th>Usage</th>`;
    html += `</tr></thead><tbody>`;

    for (const fieldName of section.fields) {
      const field = fields.find(f => f.StandardName === fieldName);
      if (!field) continue;
      const fieldUrl = ddUrl(version, resourceName, field.StandardName);
      const stats = resourceStats?.[field.StandardName];

      html += `<tr>`;
      html += `<td><a href="${fieldUrl}" class="dd-field-link">${escapeHtml(field.DisplayName || field.StandardName)}</a>`;
      html += `<div class="dd-field-standard-name">${escapeHtml(field.StandardName)}</div></td>`;
      html += `<td class="dd-field-def">${escapeHtml(truncate(field.Definition, DEFINITION_TRUNCATE_LENGTH))}`;
      if (field.Definition && field.Definition.length > DEFINITION_TRUNCATE_LENGTH) {
        html += ` <a href="${fieldUrl}" class="dd-more-link">more</a>`;
      }
      html += `</td>`;
      html += `<td><span class="dd-type-badge">${escapeHtml(field.SimpleDataType)}</span></td>`;
      html += `<td>${usageBadge(stats)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  html += '</div>';
  return html;
}

function collectSections(tree, path, sections) {
  const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();

  for (const group of childGroups) {
    collectSections(tree[group], [...path, group], sections);
  }

  const fieldNames = tree._fields || [];
  const ungrouped = tree._ungrouped || [];

  if (fieldNames.length > 0) {
    sections.push({ path, fields: fieldNames.sort() });
  }
  if (ungrouped.length > 0 && path.length === 0) {
    sections.push({ path: [], fields: ungrouped.sort() });
  }
}

function generateFieldPage(vCfg, data, resourceName, field, usageStats, allVersions) {
  const { version, label } = vCfg;
  const resourceStats = usageStats?.[resourceName];
  const fieldStats = resourceStats?.[field.StandardName];

  let html = breadcrumbHtml(version, label, [
    { label: resourceName, url: ddUrl(version, resourceName) },
    { label: field.DisplayName || field.StandardName },
  ]);

  html += `<div class="dd-page-header"><h1>${escapeHtml(field.DisplayName || field.StandardName)}</h1></div>`;

  // Metadata
  html += `<div class="dd-metadata-card"><h2>Details</h2><table class="dd-metadata-table">`;
  const metaRows = [
    ['Standard Name', field.StandardName],
    ['Display Name', field.DisplayName],
    ['Definition', field.Definition],
    ['Data Type', field.SimpleDataType],
    ['Max Length', field.SugMaxLength],
    ['Max Precision', field.SugMaxPrecision],
    ['Property Types', field.PropertyTypes],
    ['Payloads', field.Payloads],
    ['Status', field.ElementStatus],
    ['Added in Version', field.AddedInVersion],
    ['Revised Date', field.RevisedDate],
    ['Repeating Element', field.RepeatingElement],
    ['Source Resource', field.SourceResource],
    ['BEDES', field.BEDES],
  ];
  for (const [lbl, value] of metaRows) {
    if (!value) continue;
    html += `<tr><th>${escapeHtml(lbl)}</th><td>${escapeHtml(value)}</td></tr>`;
  }
  html += `</table></div>`;

  // Usage
  html += `<div class="dd-metadata-card"><h2>Usage</h2>${usageHtml(fieldStats)}</div>`;

  // Lookups panel
  if (field.LookupStatus === 'Open with Enumerations' && field.LookupName) {
    const lookupValues = data.lookupMap[field.LookupName] || [];
    const lookupStats = fieldStats?.lookups;

    html += `<div class="dd-collapsible">`;
    html += `<button class="dd-collapsible-toggle">Lookups (${lookupValues.length}) <span class="dd-toggle-icon">+</span></button>`;
    html += `<div class="dd-collapsible-content">`;
    html += `<table class="dd-lookups-table"><thead><tr>`;
    html += `<th>Standard Value</th><th>Legacy OData Value</th><th>Definition</th><th>Usage</th>`;
    html += `</tr></thead><tbody>`;

    for (const lk of lookupValues) {
      const lkUrl = ddUrl(version, resourceName, field.StandardName, lk.StandardLookupValue);
      const lkStats = lookupStats?.[lk.StandardLookupValue];
      html += `<tr>`;
      html += `<td><a href="${lkUrl}">${escapeHtml(lk.StandardLookupValue)}</a></td>`;
      html += `<td>${escapeHtml(lk.LegacyODataValue)}</td>`;
      html += `<td class="dd-field-def">${escapeHtml(truncate(lk.Definition, DEFINITION_TRUNCATE_LENGTH))}</td>`;
      html += `<td>${usageBadge(lkStats)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
  } else if (field.SimpleDataType?.startsWith('String List')) {
    html += `<div class="dd-metadata-card dd-no-enums"><h2>Lookups</h2>`;
    html += `<p>This is an open enumeration field. No standard lookup values are defined.</p></div>`;
  }

  // Expansion panel
  if ((field.SimpleDataType === 'Resource' || field.SimpleDataType === 'Collection') && field.SourceResource) {
    const expandedFields = data.resourceMap[field.SourceResource] || [];
    html += `<div class="dd-collapsible">`;
    html += `<button class="dd-collapsible-toggle">${escapeHtml(field.SourceResource)} Fields (${expandedFields.length}) <span class="dd-toggle-icon">+</span></button>`;
    html += `<div class="dd-collapsible-content">`;
    html += `<table class="dd-fields-table"><thead><tr><th>Field</th><th>Definition</th><th>Type</th></tr></thead><tbody>`;

    for (const ef of expandedFields) {
      const efUrl = ddUrl(version, field.SourceResource, ef.StandardName);
      html += `<tr>`;
      html += `<td><a href="${efUrl}">${escapeHtml(ef.DisplayName || ef.StandardName)}</a></td>`;
      html += `<td class="dd-field-def">${escapeHtml(truncate(ef.Definition, DEFINITION_TRUNCATE_LENGTH))}</td>`;
      html += `<td><span class="dd-type-badge">${escapeHtml(ef.SimpleDataType)}</span></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
  }

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName, field.StandardName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${field.DisplayName || field.StandardName} - ${resourceName}`, version, sidebarHtml, html, allVersions
  ));
}

function generateLookupPage(vCfg, data, resourceName, field, lookup, usageStats, allVersions) {
  const { version, label } = vCfg;
  const resourceStats = usageStats?.[resourceName];
  const fieldStats = resourceStats?.[field.StandardName];
  const lookupStats = fieldStats?.lookups?.[lookup.StandardLookupValue];

  let html = breadcrumbHtml(version, label, [
    { label: resourceName, url: ddUrl(version, resourceName) },
    { label: field.DisplayName || field.StandardName, url: ddUrl(version, resourceName, field.StandardName) },
    { label: lookup.StandardLookupValue },
  ]);

  html += `<div class="dd-page-header"><h1>${escapeHtml(lookup.StandardLookupValue)}</h1></div>`;

  // Metadata
  html += `<div class="dd-metadata-card"><h2>Details</h2><table class="dd-metadata-table">`;
  const metaRows = [
    ['Lookup Name', lookup.LookupName],
    ['Standard Value', lookup.StandardLookupValue],
    ['Legacy OData Value', lookup.LegacyODataValue],
    ['Definition', lookup.Definition],
    ['References', lookup.References],
    ['Status', lookup.ElementStatus],
    ['Added in Version', lookup.AddedInVersion],
    ['Revised Date', lookup.RevisedDate],
    ['BEDES', lookup.BEDES],
  ];
  for (const [lbl, value] of metaRows) {
    if (!value) continue;
    html += `<tr><th>${escapeHtml(lbl)}</th><td>${escapeHtml(value)}</td></tr>`;
  }
  html += `</table></div>`;

  // Usage
  html += `<div class="dd-metadata-card"><h2>Usage</h2>`;
  html += `<h3>Standard Value</h3>${usageHtml(lookupStats)}`;
  html += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName, field.StandardName, lookup.StandardLookupValue);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${lookup.StandardLookupValue} - ${field.StandardName} - ${resourceName}`, version, sidebarHtml, html, allVersions
  ));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('RESO Data Dictionary Documentation Generator');
  console.log('============================================\n');

  if (existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true });
  }

  // Load all versions first (for version selector)
  const allData = [];
  for (const vCfg of VERSIONS) {
    console.log(`Loading ${vCfg.label}...`);
    const data = loadVersion(vCfg.version);
    console.log(`  ${Object.keys(data.resourceMap).length} resources, ${data.fields.length} fields, ${data.lookups.length} lookups`);
    allData.push({ vCfg, data });
  }

  for (const { vCfg, data } of allData) {
    console.log(`\nGenerating ${vCfg.label}...`);

    let usageStats = null;
    try {
      usageStats = await fetchUsageStats(data);
    } catch (err) {
      console.warn('  Error fetching usage stats:', err.message);
    }

    generateVersionLanding(vCfg, data, VERSIONS);

    let pageCount = 1;
    for (const [resourceName, fields] of Object.entries(data.resourceMap)) {
      generateResourcePage(vCfg, data, resourceName, usageStats, VERSIONS);
      pageCount++;

      for (const field of fields) {
        generateFieldPage(vCfg, data, resourceName, field, usageStats, VERSIONS);
        pageCount++;

        if (field.LookupStatus === 'Open with Enumerations' && field.LookupName) {
          const lookupValues = data.lookupMap[field.LookupName] || [];
          for (const lk of lookupValues) {
            generateLookupPage(vCfg, data, resourceName, field, lk, usageStats, VERSIONS);
            pageCount++;
          }
        }
      }
    }

    console.log(`  Generated ${pageCount} pages`);
  }

  // Generate DD root redirect
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const latestVersion = VERSIONS.filter(v => !v.draft).pop() || VERSIONS[0];
  writeFileSync(join(OUTPUT_DIR, 'index.html'),
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/dd/DD${latestVersion.version}/"></head>` +
    `<body><p>Redirecting to <a href="/dd/DD${latestVersion.version}/">${escapeHtml(latestVersion.label)}</a>...</p></body></html>`
  );

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Generator failed:', err);
  process.exit(1);
});
