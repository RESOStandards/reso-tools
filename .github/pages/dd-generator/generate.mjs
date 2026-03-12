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
  { version: '1.7', label: 'DD 1.7', draft: false, legacy: true, approved: 'December 18, 2018' },
  { version: '2.0', label: 'DD 2.0', draft: false, legacy: false, approved: 'October 23, 2023' },
  { version: '2.1', label: 'DD 2.1', draft: true, legacy: false },
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

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
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
    <span class="dd-usage-label">Providers</span><span class="dd-usage-value">${formatNumber(stats.recipients)}</span>
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
  let html = `<nav class="dd-breadcrumb" data-pagefind-ignore><a href="/dd/">Data Dictionary</a> <span class="dd-breadcrumb-sep">/</span> <a href="/dd/DD${version}/">${escapeHtml(versionLabel)}</a>`;
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

function wrapPage(title, version, sidebarHtml, contentHtml, allVersions, { pagefindWeight } = {}) {
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

    html.dark {
      --reso-gray-50: #1a202c;
      --reso-gray-100: #2d3748;
      --reso-gray-200: #4a5568;
      --reso-gray-300: #718096;
      --reso-gray-500: #a0aec0;
      --reso-gray-600: #cbd5e0;
      --reso-gray-700: #e2e8f0;
      --reso-gray-800: #edf2f7;
      --reso-gray-900: #f7fafc;
      --reso-green-light: rgba(56,161,105,0.15);
      --reso-orange-light: rgba(255,153,0,0.15);
      --reso-blue-light: rgba(0,126,158,0.15);
    }
    html.dark .dd-metadata-card,
    html.dark .search-modal { background: var(--reso-gray-100); }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { overflow-x: hidden; }

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
      .site-header { flex-wrap: wrap; height: auto; min-height: 64px; max-width: 100vw; overflow: hidden; }
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

    /* Theme toggle */
    .theme-toggle {
      background: none;
      border: none;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      padding: 0.375rem;
      border-radius: 0.375rem;
      transition: all 0.15s;
      display: flex;
      align-items: center;
    }
    .theme-toggle:hover { background: rgba(255,255,255,0.25); color: white; }
    .theme-toggle svg { width: 16px; height: 16px; fill: currentColor; }
    .theme-toggle .icon-moon { display: block; }
    .theme-toggle .icon-sun { display: none; }
    html.dark .theme-toggle .icon-moon { display: none; }
    html.dark .theme-toggle .icon-sun { display: block; }

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
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    @media (max-width: 768px) {
      .search-modal-overlay { padding-top: 1rem; }
      .search-modal { width: calc(100% - 1.5rem); max-height: 85vh; border-radius: 0.5rem; }
    }

    /* Pagefind layout — input+pills fixed at top, drawer scrolls */
    .pagefind-ui .pagefind-ui__form {
      padding: 1rem 1rem 0 !important;
      position: relative !important;
    }
    /* Search icon — vertically center in input */
    .pagefind-ui .pagefind-ui__form::before {
      position: absolute !important;
      top: 1.875rem !important;
      left: 1.625rem !important;
      width: 18px !important;
      height: 18px !important;
    }
    .pagefind-ui .pagefind-ui__search-input {
      border: 1.5px solid var(--reso-gray-300) !important;
      border-radius: 0.5rem !important;
      padding: 0.625rem 3.5rem 0.625rem 2.5rem !important;
      font-size: 1rem !important;
      color: var(--reso-gray-800) !important;
      background: var(--reso-gray-50) !important;
      font-family: inherit !important;
      height: auto !important;
    }
    .pagefind-ui .pagefind-ui__search-input::placeholder { color: var(--reso-gray-500) !important; }
    .pagefind-ui .pagefind-ui__search-input:focus {
      border-color: var(--reso-blue) !important;
      box-shadow: 0 0 0 3px rgba(0,126,158,0.15) !important;
      outline: none !important;
    }
    /* Clear button — vertically center in input */
    .pagefind-ui .pagefind-ui__search-clear {
      position: absolute !important;
      top: 1rem !important;
      right: 1.5rem !important;
      color: var(--reso-gray-500) !important;
      font-size: 0.8125rem !important;
      font-weight: 500 !important;
      background: none !important;
      border: none !important;
      padding: 0.125rem 0.375rem !important;
      cursor: pointer !important;
    }
    .pagefind-ui .pagefind-ui__search-clear:hover { color: var(--reso-gray-800) !important; }

    /* Filter pills — injected before the drawer */
    .dd-search-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0 0.75rem;
      border-bottom: 1px solid var(--reso-gray-200);
    }
    .dd-search-filters {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
    }
    .dd-search-filter-pill {
      padding: 0.1875rem 0.625rem;
      border-radius: 0.25rem;
      border: 1px solid var(--reso-gray-200);
      background: transparent;
      color: var(--reso-gray-600);
      font-size: 0.6875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.1s;
    }
    .dd-search-filter-pill:hover { border-color: var(--reso-blue); color: var(--reso-blue); }
    .dd-search-filter-pill.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }
    .dd-search-count {
      font-size: 0.6875rem;
      color: var(--reso-gray-500);
      white-space: nowrap;
    }

    /* Hide Pagefind's Load more button (infinite scroll), message (we show our own count), filter panel */
    .pagefind-ui .pagefind-ui__button { height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; padding: 0 !important; margin: 0 !important; border: none !important; }
    .pagefind-ui .pagefind-ui__message { display: none !important; }
    .pagefind-ui .pagefind-ui__filter-panel { display: none !important; }

    /* Drawer scrolls — explicit max-height since flex chain can break */
    .pagefind-ui .pagefind-ui__drawer {
      padding: 0 1rem 1rem !important;
      overflow-y: auto !important;
      max-height: calc(70vh - 7.5rem) !important;
    }
    .pagefind-ui .pagefind-ui__result-link { color: var(--reso-blue) !important; font-weight: 600 !important; }
    .pagefind-ui .pagefind-ui__result-excerpt { font-size: 0.8125rem !important; color: var(--reso-gray-600) !important; line-height: 1.5 !important; }
    .pagefind-ui .pagefind-ui__result-tags { display: none !important; }
    .pagefind-ui .pagefind-ui__result { border-color: var(--reso-gray-200) !important; padding: 0.75rem 0 !important; }

    /* Version badge in results */
    .dd-result-version {
      display: inline-block;
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.125rem 0.4375rem;
      border-radius: 0.1875rem;
      background: var(--reso-gray-100);
      color: var(--reso-gray-500);
      margin-left: 0.5rem;
      vertical-align: middle;
    }

    /* Dark mode search */
    html.dark .search-modal { background: #1e293b !important; }
    html.dark .pagefind-ui .pagefind-ui__form { background: #1e293b; }
    html.dark .pagefind-ui .pagefind-ui__search-input { background: #2d3748 !important; border-color: #4a5568 !important; color: #e2e8f0 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-input::placeholder { color: #718096 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-clear { color: #a0aec0 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-clear:hover { color: #e2e8f0 !important; }
    html.dark .dd-search-meta { border-color: #4a5568; }
    html.dark .pagefind-ui .pagefind-ui__result-link { color: #63b3ed !important; }
    html.dark .pagefind-ui .pagefind-ui__result-excerpt { color: #a0aec0 !important; }
    html.dark .pagefind-ui .pagefind-ui__result { border-color: #4a5568 !important; }
    html.dark .dd-search-filter-pill { background: transparent; border-color: #4a5568; color: #a0aec0; }
    html.dark .dd-search-filter-pill:hover { border-color: #63b3ed; color: #63b3ed; }
    html.dark .dd-search-filter-pill.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }
    html.dark .dd-result-version { background: #2d3748; color: #a0aec0; }

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

    .dd-sidebar-search {
      position: relative;
      padding: 0 1rem;
      margin-bottom: 0.75rem;
      cursor: pointer;
    }
    .dd-sidebar-search input {
      width: 100%;
      padding: 0.375rem 0.5rem 0.375rem 2rem;
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      color: var(--reso-gray-600);
      background: white;
      cursor: pointer;
    }
    .dd-sidebar-search input:hover { border-color: var(--reso-blue); }
    .dd-sidebar-search-icon {
      position: absolute;
      left: 1.5rem;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      fill: none;
      stroke: var(--reso-gray-500);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .dd-sidebar-search kbd {
      position: absolute;
      right: 1.5rem;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.625rem;
      font-family: inherit;
      color: var(--reso-gray-500);
      background: var(--reso-gray-100);
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.1875rem;
      padding: 0.0625rem 0.375rem;
      pointer-events: none;
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
      .dd-content { padding: 1rem; max-width: 100vw; overflow-x: hidden; }
      .dd-metadata-card { overflow-x: auto; }
      .dd-resource-grid { grid-template-columns: 1fr; }
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
    .dd-fields-table-wrapper { margin-top: 1rem; overflow-x: auto; }
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

    /* Sort controls */
    .dd-sort-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .dd-sort-controls label {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--reso-gray-500);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-sort-select {
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      color: var(--reso-gray-700);
      background: white;
      cursor: pointer;
    }
    .dd-sort-select:focus {
      outline: none;
      border-color: var(--reso-blue);
      box-shadow: 0 0 0 2px rgba(0,126,158,0.15);
    }
    .dd-sort-dir {
      background: none;
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem;
      padding: 0.375rem 0.5rem;
      cursor: pointer;
      font-size: 0.8125rem;
      color: var(--reso-gray-600);
    }
    .dd-sort-dir:hover { border-color: var(--reso-blue); color: var(--reso-blue); }

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
  <script>(function(){var t=localStorage.getItem('dd-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');})()</script>
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
      <a href="/dd/">Data Dictionary</a>
      <a href="https://github.com/RESOStandards/reso-tools">GitHub</a>
      <a href="https://reso.org">RESO.org</a>
      <button class="search-trigger" id="searchTrigger" type="button">
        <svg viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        Search<kbd>/</kbd>
      </button>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark mode">
        <svg class="icon-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24"><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41M12 6a6 6 0 100 12 6 6 0 000-12z"/></svg>
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
      <div class="dd-sidebar-search" id="sidebarSearch">
        <svg class="dd-sidebar-search-icon" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        <input type="text" placeholder="Search..." readonly />
        <kbd>/</kbd>
      </div>
      ${sidebarHtml}
    </aside>

    <div class="dd-sidebar-overlay" id="ddSidebarOverlay"></div>
    <button class="dd-sidebar-toggle" id="ddSidebarToggle" type="button" aria-label="Toggle sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>

    <div class="dd-content" data-pagefind-body data-pagefind-filter="dd-version:${version}" data-pagefind-meta="dd-version:DD ${version}"${pagefindWeight != null ? ` data-pagefind-weight="${pagefindWeight}"` : ''}>
      ${contentHtml}
    </div>
  </div>

  <!-- Search modal -->
  <div class="search-modal-overlay" id="searchOverlay">
    <div class="search-modal" id="searchModal">
      <div id="search"></div>
    </div>
  </div>
  <template id="searchFiltersTemplate">
    <div class="dd-search-meta">
      <div class="dd-search-filters" id="ddSearchFilters">
        <button class="dd-search-filter-pill" data-version="">All</button>
        ${allVersions.map(v => `<button class="dd-search-filter-pill${v.version === version ? ' active' : ''}" data-version="${v.version}">DD ${v.version}</button>`).join('\n        ')}
      </div>
      <div class="dd-search-count" id="ddSearchCount"></div>
    </div>
  </template>

  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} <a href="https://reso.org">Real Estate Standards Organization (RESO)</a>. All rights reserved.</p>
    <p style="margin-top: 0.5rem;">
      <a href="https://github.com/RESOStandards/reso-tools">Source</a> &middot;
      <a href="https://certification.reso.org">Certification Analytics</a> &middot;
      <a href="https://www.reso.org/eula/">Terms of Use</a>
    </p>
  </footer>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      var currentVersion = '${version}';
      var activeFilter = currentVersion;
      var pfUI = null;
      var searchEl = document.getElementById('search');
      var modalEl = document.getElementById('searchModal');
      var countEl = null;
      var filtersEl = null;

      var observer = null;

      function initPagefind(filterVersion) {
        var prevTerm = '';
        var prevInput = searchEl.querySelector('.pagefind-ui__search-input');
        if (prevInput) prevTerm = prevInput.value || '';
        if (observer) { observer.disconnect(); observer = null; }
        searchEl.innerHTML = '';
        var opts = { element: '#search', showSubResults: true, showImages: false, resetStyles: false };
        if (filterVersion) opts.filters = { 'dd-version': filterVersion };
        pfUI = new PagefindUI(opts);

        // Inject filter pills before the drawer, attach scroll loader
        injectFilters();
        attachScrollLoader();

        // Observe for version badges and result count — pause during DOM writes
        var processing = false;
        observer = new MutationObserver(function() {
          if (processing) return;
          processing = true;
          requestAnimationFrame(function() {
            searchEl.querySelectorAll('.pagefind-ui__result-link:not([data-badge])').forEach(function(link) {
              link.setAttribute('data-badge', '1');
              var url = link.getAttribute('href') || '';
              var m = url.match(/\\/DD(\\d+\\.\\d+)\\//);
              if (m) {
                var badge = document.createElement('span');
                badge.className = 'dd-result-version';
                badge.textContent = 'DD ' + m[1];
                link.appendChild(badge);
              }
            });
            var msg = searchEl.querySelector('.pagefind-ui__message');
            if (msg && countEl) {
              var txt = msg.textContent || '';
              var cm = txt.match(/(\\d+)\\s+result/);
              var newCount = cm ? cm[1] + ' results' : '';
              if (countEl.textContent !== newCount) countEl.textContent = newCount;
            }
            processing = false;
          });
        });
        observer.observe(searchEl, { childList: true, subtree: true });

        // Re-trigger previous search term if switching filters
        if (prevTerm) {
          setTimeout(function() { pfUI.triggerSearch(prevTerm); }, 100);
        }
      }

      function injectFilters() {
        var form = searchEl.querySelector('.pagefind-ui__form');
        if (!form) return;
        var tpl = document.getElementById('searchFiltersTemplate');
        var clone = tpl.content.cloneNode(true);
        // Insert pills BEFORE the drawer so they stay above results
        var drawer = form.querySelector('.pagefind-ui__drawer');
        if (drawer) form.insertBefore(clone, drawer);
        else form.appendChild(clone);
        filtersEl = form.querySelector('.dd-search-filters');
        countEl = form.querySelector('.dd-search-count');

        // Set active pill from activeFilter (not from template defaults)
        if (filtersEl) {
          filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) {
            b.classList.toggle('active', b.dataset.version === activeFilter);
          });
        }

        filtersEl.addEventListener('click', function(e) {
          var btn = e.target.closest('.dd-search-filter-pill');
          if (!btn || typeof PagefindUI === 'undefined') return;
          filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          activeFilter = btn.dataset.version;
          initPagefind(activeFilter);
        });
      }

      // Infinite scroll on the drawer (the scrollable results area)
      function attachScrollLoader() {
        var drawer = searchEl.querySelector('.pagefind-ui__drawer');
        if (!drawer) return;
        drawer.addEventListener('scroll', function() {
          if (drawer.scrollTop + drawer.clientHeight >= drawer.scrollHeight - 300) {
            var btn = searchEl.querySelector('.pagefind-ui__button');
            if (btn) btn.click();
          }
        });
      }

      // Load Pagefind
      var s = document.createElement('script');
      s.src = '/pagefind/pagefind-ui.js';
      s.onload = function() { if (typeof PagefindUI !== 'undefined') initPagefind(currentVersion); };
      document.head.appendChild(s);

      // Header hamburger
      document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('headerNav').classList.toggle('open');
      });

      // Search modal
      var overlay = document.getElementById('searchOverlay');
      function openSearch() {
        overlay.classList.add('active');
        setTimeout(function() {
          var pfInput = searchEl.querySelector('.pagefind-ui__search-input');
          if (pfInput) pfInput.focus();
        }, 100);
      }
      document.getElementById('searchTrigger').addEventListener('click', openSearch);
      var sidebarSearchEl = document.getElementById('sidebarSearch');
      if (sidebarSearchEl) sidebarSearchEl.addEventListener('click', openSearch);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.classList.remove('active'); });
      document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          openSearch();
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

      // Theme toggle
      document.getElementById('themeToggle').addEventListener('click', function() {
        var isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('dd-theme', isDark ? 'dark' : 'light');
      });

      // Collapsible panels
      document.querySelectorAll('.dd-collapsible-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
          btn.parentElement.classList.toggle('open');
        });
      });

      // Sort controls for version landing (resource grid)
      var resSortField = document.getElementById('ddResourceSort');
      var resSortDirBtn = document.getElementById('ddResourceSortDir');
      var resGrid = document.getElementById('ddResourceGrid');
      if (resSortField && resSortDirBtn && resGrid) {
        var resAsc = true;
        resSortDirBtn.addEventListener('click', function() {
          resAsc = !resAsc;
          resSortDirBtn.innerHTML = resAsc ? '&#9650;' : '&#9660;';
          applyResSort();
        });
        resSortField.addEventListener('change', applyResSort);
        function applyResSort() {
          var cards = Array.from(resGrid.querySelectorAll('.dd-resource-card'));
          cards.sort(function(a, b) {
            var sf = resSortField.value;
            if (sf === 'name') {
              return resAsc ? a.dataset.name.localeCompare(b.dataset.name) : b.dataset.name.localeCompare(a.dataset.name);
            } else if (sf === 'fields') {
              var fa = parseInt(a.dataset.fields), fb = parseInt(b.dataset.fields);
              return resAsc ? fb - fa : fa - fb;
            }
            return 0;
          });
          cards.forEach(function(c) { resGrid.appendChild(c); });
        }
      }

      // Sort controls for resource pages
      var sortField = document.getElementById('ddSortField');
      var sortDirBtn = document.getElementById('ddSortDir');
      if (sortField && sortDirBtn) {
        var ascending = true;
        var wrapper = document.querySelector('.dd-fields-table-wrapper');
        if (wrapper) {
          sortDirBtn.addEventListener('click', function() {
            ascending = !ascending;
            sortDirBtn.innerHTML = ascending ? '&#9650;' : '&#9660;';
            applySort();
          });
          sortField.addEventListener('change', applySort);

          function applySort() {
            var field = sortField.value;
            var headings = wrapper.querySelectorAll('.dd-group-heading');
            var tables = wrapper.querySelectorAll('.dd-fields-table');

            if (field === 'group') {
              // Restore original group layout — reload page
              window.location.reload();
              return;
            }

            // Hide group headings when sorting by non-group
            headings.forEach(function(h) { h.style.display = 'none'; });

            // Collect all rows from all tables
            var allRows = [];
            tables.forEach(function(t) {
              var rows = Array.from(t.querySelectorAll('tbody tr'));
              rows.forEach(function(r) { allRows.push(r); });
            });

            // Sort
            allRows.sort(function(a, b) {
              var va, vb;
              if (field === 'name') {
                va = a.dataset.name || '';
                vb = b.dataset.name || '';
                return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
              } else if (field === 'usage') {
                va = parseFloat(a.dataset.usage) || -1;
                vb = parseFloat(b.dataset.usage) || -1;
                return ascending ? vb - va : va - vb; // Default: highest usage first
              } else if (field === 'added') {
                va = a.dataset.added || '';
                vb = b.dataset.added || '';
                return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
              } else if (field === 'revised') {
                va = a.dataset.revised || '';
                vb = b.dataset.revised || '';
                return ascending ? vb.localeCompare(va) : va.localeCompare(vb); // Default: newest first
              }
              return 0;
            });

            // Move all rows into the first table, hide others
            if (tables.length > 0) {
              var mainTbody = tables[0].querySelector('tbody');
              allRows.forEach(function(r) { mainTbody.appendChild(r); });
              for (var i = 1; i < tables.length; i++) {
                tables[i].style.display = 'none';
              }
            }
          }
        }
      }
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
  html += `</h1><p class="dd-page-subtitle">RESO Data Dictionary ${escapeHtml(version)} &mdash; ${formatNumber(resources.length)} resources, ${formatNumber(data.fields.length)} fields</p></div>`;

  html += `<div class="dd-sort-controls">
    <label>Sort by</label>
    <select class="dd-sort-select" id="ddResourceSort">
      <option value="name">Name</option>
      <option value="fields">Field Count</option>
    </select>
    <button class="dd-sort-dir" id="ddResourceSortDir" type="button" title="Toggle sort direction">&#9650;</button>
  </div>`;

  html += `<div class="dd-resource-grid" id="ddResourceGrid">`;
  for (const rn of resources) {
    const fieldCount = resourceMap[rn].length;
    html += `<a href="${ddUrl(version, rn)}" class="dd-resource-card" data-name="${escapeHtml(rn)}" data-fields="${fieldCount}">`;
    html += `<h3>${escapeHtml(rn)}</h3>`;
    html += `<span class="dd-resource-count">${formatNumber(fieldCount)} field${fieldCount !== 1 ? 's' : ''}</span>`;
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
  const latestRevised = fields.reduce((latest, f) => {
    if (f.RevisedDate && (!latest || f.RevisedDate > latest)) return f.RevisedDate;
    return latest;
  }, null);
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">${formatNumber(fields.length)} fields`;
  if (latestRevised) html += ` &middot; Last revised ${escapeHtml(latestRevised)}`;
  html += `</p></div>`;

  html += `<div class="dd-sort-controls">
    <label>Sort by</label>
    <select class="dd-sort-select" id="ddSortField">
      <option value="group">Group</option>
      <option value="name">Name</option>
      <option value="usage">Usage</option>
      <option value="added">Date Added</option>
      <option value="revised">Revised Date</option>
    </select>
    <button class="dd-sort-dir" id="ddSortDir" type="button" title="Toggle sort direction">&#9650;</button>
  </div>`;

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

  const hasGroupedSections = sections.some(s => s.path.length > 0);

  let html = '<div class="dd-fields-table-wrapper" data-pagefind-ignore>';
  for (const section of sections) {
    const groupPath = section.path.join(' > ');
    const groupId = 'group-' + section.path.join('-');

    if (section.path.length > 0) {
      html += `<h2 class="dd-group-heading" id="${escapeHtml(groupId)}">${escapeHtml(groupPath)}</h2>`;
    } else if (hasGroupedSections) {
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
      const usageVal = stats?.mean != null ? stats.mean : -1;

      html += `<tr data-name="${escapeHtml(field.StandardName)}" data-usage="${usageVal}" data-added="${escapeHtml(field.AddedInVersion || '')}" data-revised="${escapeHtml(field.RevisedDate || '')}" data-group="${escapeHtml(section.path.join(' > '))}">`;
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

  html += `<div class="dd-page-header"><h1>${escapeHtml(field.DisplayName || field.StandardName)}</h1>`;
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">${escapeHtml(resourceName)} field &mdash; ${escapeHtml(field.SimpleDataType || 'Unknown type')}</p></div>`;

  // Metadata
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Details</h2><table class="dd-metadata-table">`;
  const metaRows = [
    ['Standard Name', field.StandardName],
    ['Display Name', field.DisplayName],
    ['Definition', field.Definition],
    ['Data Type', field.SimpleDataType],
    ['Max Length', field.SugMaxLength],
    ['Max Precision', field.SugMaxPrecision],
    ['Property Types', field.PropertyTypes, 'PropertyTypes'],
    ['Payloads', field.Payloads, 'Payloads'],
    ['Status', field.ElementStatus, 'ElementStatus'],
    ['Added in Version', field.AddedInVersion, 'AddedInVersion'],
    ['Revised Date', field.RevisedDate],
    ['Repeating Element', field.RepeatingElement],
    ['Source Resource', field.SourceResource],
    ['BEDES', field.BEDES],
  ];
  for (const [lbl, value, xrefKey] of metaRows) {
    if (!value) continue;
    const rendered = xrefKey ? xrefLinksForField(version, xrefKey, value) : escapeHtml(value);
    html += `<tr><th>${escapeHtml(lbl)}</th><td>${rendered}</td></tr>`;
  }
  html += `</table></div>`;

  // Usage
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Usage</h2>${usageHtml(fieldStats)}</div>`;

  // Lookups panel
  if (field.LookupStatus === 'Open with Enumerations' && field.LookupName) {
    const lookupValues = data.lookupMap[field.LookupName] || [];
    const lookupStats = fieldStats?.lookups;

    html += `<div class="dd-collapsible">`;
    html += `<button class="dd-collapsible-toggle">Lookups (${formatNumber(lookupValues.length)}) <span class="dd-toggle-icon">+</span></button>`;
    html += `<div class="dd-collapsible-content" data-pagefind-ignore>`;
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
    html += `<button class="dd-collapsible-toggle">${escapeHtml(field.SourceResource)} Fields (${formatNumber(expandedFields.length)}) <span class="dd-toggle-icon">+</span></button>`;
    html += `<div class="dd-collapsible-content" data-pagefind-ignore>`;
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
  const weight = fieldStats?.mean != null ? fieldStats.mean : undefined;
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${field.DisplayName || field.StandardName} - ${resourceName}`, version, sidebarHtml, html, allVersions, { pagefindWeight: weight }
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

  html += `<div class="dd-page-header"><h1>${escapeHtml(lookup.StandardLookupValue)}</h1>`;
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">Lookup value for ${escapeHtml(field.DisplayName || field.StandardName)} (${escapeHtml(resourceName)})</p></div>`;

  // Metadata
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Details</h2><table class="dd-metadata-table">`;
  const metaRows = [
    ['Lookup Name', lookup.LookupName],
    ['Standard Value', lookup.StandardLookupValue],
    ['Legacy OData Value', lookup.LegacyODataValue],
    ['Definition', lookup.Definition],
    ['References', lookup.References],
    ['Status', lookup.ElementStatus, 'ElementStatus'],
    ['Added in Version', lookup.AddedInVersion, 'AddedInVersion'],
    ['Revised Date', lookup.RevisedDate],
    ['BEDES', lookup.BEDES],
  ];
  for (const [lbl, value, xrefKey] of metaRows) {
    if (!value) continue;
    const rendered = xrefKey ? xrefLinksForField(version, xrefKey, value) : escapeHtml(value);
    html += `<tr><th>${escapeHtml(lbl)}</th><td>${rendered}</td></tr>`;
  }
  html += `</table></div>`;

  // Usage
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Usage</h2>`;
  html += `<h3>Standard Value</h3>${usageHtml(lookupStats)}`;
  html += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName, field.StandardName, lookup.StandardLookupValue);
  mkdirSync(dir, { recursive: true });
  const weight = lookupStats?.mean != null ? lookupStats.mean : undefined;
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${lookup.StandardLookupValue} - ${field.StandardName} - ${resourceName}`, version, sidebarHtml, html, allVersions, { pagefindWeight: weight }
  ));
}

// ---------------------------------------------------------------------------
// Cross-Reference Page Generator
// ---------------------------------------------------------------------------

const XREF_DIMENSIONS = [
  { key: 'Payloads', label: 'Payload', slug: 'payload', split: true },
  { key: 'PropertyTypes', label: 'Property Type', slug: 'property-type', split: true },
  { key: 'ElementStatus', label: 'Element Status', slug: 'status', split: false },
  { key: 'AddedInVersion', label: 'Version Added', slug: 'version-added', split: false },
];

function buildXrefIndex(fields) {
  const index = {};
  for (const dim of XREF_DIMENSIONS) {
    index[dim.key] = {};
  }

  for (const field of fields) {
    for (const dim of XREF_DIMENSIONS) {
      const raw = field[dim.key];
      if (!raw) continue;
      const values = dim.split ? raw.split(',').map(v => v.trim()).filter(Boolean) : [raw.trim()];
      for (const val of values) {
        if (!index[dim.key][val]) index[dim.key][val] = [];
        index[dim.key][val].push(field);
      }
    }
  }
  return index;
}

function xrefUrl(version, slug, value) {
  return '/dd/DD' + version + '/xref/' + slug + '/' + encodeURIComponent(value) + '/';
}

function xrefLink(version, slug, value) {
  return `<a href="${xrefUrl(version, slug, value)}" class="dd-field-link">${escapeHtml(value)}</a>`;
}

function xrefLinksForField(version, dimKey, rawValue) {
  const dim = XREF_DIMENSIONS.find(d => d.key === dimKey);
  if (!dim || !rawValue) return escapeHtml(rawValue || '');
  const values = dim.split ? rawValue.split(',').map(v => v.trim()).filter(Boolean) : [rawValue.trim()];
  return values.map(v => xrefLink(version, dim.slug, v)).join(', ');
}

function generateXrefPages(vCfg, data, allVersions) {
  const { version, label } = vCfg;
  const xrefIndex = buildXrefIndex(data.fields);
  let pageCount = 0;

  // Generate index page listing all dimensions
  let indexHtml = breadcrumbHtml(version, label, [{ label: 'Cross Reference' }]);
  indexHtml += `<div class="dd-page-header"><h1>Cross Reference</h1>`;
  indexHtml += `<p class="dd-page-subtitle">Browse fields by attribute</p></div>`;
  indexHtml += `<div class="dd-resource-grid">`;
  for (const dim of XREF_DIMENSIONS) {
    const valueCount = Object.keys(xrefIndex[dim.key]).length;
    if (valueCount === 0) continue;
    indexHtml += `<a href="/dd/DD${version}/xref/${dim.slug}/" class="dd-resource-card">`;
    indexHtml += `<h3>${escapeHtml(dim.label)}</h3>`;
    indexHtml += `<span class="dd-resource-count">${formatNumber(valueCount)} value${valueCount !== 1 ? 's' : ''}</span>`;
    indexHtml += `</a>`;
  }
  indexHtml += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, null);
  const xrefDir = join(OUTPUT_DIR, `DD${version}`, 'xref');
  mkdirSync(xrefDir, { recursive: true });
  writeFileSync(join(xrefDir, 'index.html'), wrapPage('Cross Reference - ' + label, version, sidebarHtml, indexHtml, allVersions));
  pageCount++;

  // Generate per-dimension landing pages and per-value pages
  for (const dim of XREF_DIMENSIONS) {
    const values = Object.keys(xrefIndex[dim.key]).sort();
    if (values.length === 0) continue;

    // Dimension landing page
    let dimHtml = breadcrumbHtml(version, label, [
      { label: 'Cross Reference', url: `/dd/DD${version}/xref/` },
      { label: dim.label },
    ]);
    dimHtml += `<div class="dd-page-header"><h1>${escapeHtml(dim.label)}</h1>`;
    dimHtml += `<p class="dd-page-subtitle">${formatNumber(values.length)} values</p></div>`;
    dimHtml += `<div class="dd-resource-grid">`;
    for (const val of values) {
      const fCount = xrefIndex[dim.key][val].length;
      dimHtml += `<a href="${xrefUrl(version, dim.slug, val)}" class="dd-resource-card">`;
      dimHtml += `<h3>${escapeHtml(val)}</h3>`;
      dimHtml += `<span class="dd-resource-count">${formatNumber(fCount)} field${fCount !== 1 ? 's' : ''}</span>`;
      dimHtml += `</a>`;
    }
    dimHtml += `</div>`;

    const dimDir = join(xrefDir, dim.slug);
    mkdirSync(dimDir, { recursive: true });
    writeFileSync(join(dimDir, 'index.html'), wrapPage(`${dim.label} - ${label}`, version, sidebarHtml, dimHtml, allVersions));
    pageCount++;

    // Per-value pages
    for (const val of values) {
      const matchingFields = xrefIndex[dim.key][val];
      let valHtml = breadcrumbHtml(version, label, [
        { label: 'Cross Reference', url: `/dd/DD${version}/xref/` },
        { label: dim.label, url: `/dd/DD${version}/xref/${dim.slug}/` },
        { label: val },
      ]);
      valHtml += `<div class="dd-page-header"><h1>${escapeHtml(val)}</h1>`;
      valHtml += `<p class="dd-page-subtitle">${escapeHtml(dim.label)} &mdash; ${formatNumber(matchingFields.length)} fields</p></div>`;

      valHtml += `<table class="dd-fields-table"><thead><tr>`;
      valHtml += `<th>Resource</th><th>Field</th><th>Definition</th><th>Type</th>`;
      valHtml += `</tr></thead><tbody>`;
      for (const field of matchingFields) {
        const fieldUrl = ddUrl(version, field.ResourceName, field.StandardName);
        valHtml += `<tr>`;
        valHtml += `<td><a href="${ddUrl(version, field.ResourceName)}" class="dd-field-link">${escapeHtml(field.ResourceName)}</a></td>`;
        valHtml += `<td><a href="${fieldUrl}" class="dd-field-link">${escapeHtml(field.DisplayName || field.StandardName)}</a>`;
        valHtml += `<div class="dd-field-standard-name">${escapeHtml(field.StandardName)}</div></td>`;
        valHtml += `<td class="dd-field-def">${escapeHtml(truncate(field.Definition, DEFINITION_TRUNCATE_LENGTH))}</td>`;
        valHtml += `<td><span class="dd-type-badge">${escapeHtml(field.SimpleDataType)}</span></td>`;
        valHtml += `</tr>`;
      }
      valHtml += `</tbody></table>`;

      const valDir = join(dimDir, encodeURIComponent(val));
      mkdirSync(valDir, { recursive: true });
      writeFileSync(join(valDir, 'index.html'), wrapPage(`${val} - ${dim.label}`, version, sidebarHtml, valHtml, allVersions));
      pageCount++;
    }
  }

  return pageCount;
}

// ---------------------------------------------------------------------------
// DD Landing Page — shows all versions as tiles
// ---------------------------------------------------------------------------

function generateDDLandingPage(allData) {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Build version tiles
  let tilesHtml = '';
  for (const { vCfg, data } of allData) {
    const { version, label, draft, legacy, approved } = vCfg;
    const resourceCount = Object.keys(data.resourceMap).length;
    const fieldCount = data.fields.length;
    const lookupCount = data.lookups.length;

    let statusBadge;
    if (draft) {
      statusBadge = '<span class="dd-landing-badge dd-landing-badge-draft">Draft</span>';
    } else if (legacy) {
      statusBadge = '<span class="dd-landing-badge dd-landing-badge-legacy">Legacy</span>';
    } else {
      statusBadge = '<span class="dd-landing-badge dd-landing-badge-active">Active</span>';
    }

    tilesHtml += `
    <a href="/dd/DD${version}/" class="dd-landing-tile${draft ? ' dd-landing-tile-draft' : ''}${legacy ? ' dd-landing-tile-legacy' : ''}">
      <div class="dd-landing-tile-header">
        <h2>${escapeHtml(label)}</h2>
        ${statusBadge}
      </div>
      ${approved ? `<p class="dd-landing-tile-approved">Approved ${escapeHtml(approved)}</p>` : '<p class="dd-landing-tile-approved">In development</p>'}
      <div class="dd-landing-tile-stats">
        <div class="dd-landing-stat">
          <span class="dd-landing-stat-number">${formatNumber(resourceCount)}</span>
          <span class="dd-landing-stat-label">Resources</span>
        </div>
        <div class="dd-landing-stat">
          <span class="dd-landing-stat-number">${formatNumber(fieldCount)}</span>
          <span class="dd-landing-stat-label">Fields</span>
        </div>
        <div class="dd-landing-stat">
          <span class="dd-landing-stat-number">${formatNumber(lookupCount)}</span>
          <span class="dd-landing-stat-label">Lookups</span>
        </div>
      </div>
    </a>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Data Dictionary - RESO Tools</title>
  <meta name="description" content="RESO Data Dictionary documentation — browse resources, fields and lookups across all versions.">
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

    html.dark {
      --reso-gray-50: #1a202c;
      --reso-gray-100: #2d3748;
      --reso-gray-200: #4a5568;
      --reso-gray-300: #718096;
      --reso-gray-500: #a0aec0;
      --reso-gray-600: #cbd5e0;
      --reso-gray-700: #e2e8f0;
      --reso-gray-800: #edf2f7;
      --reso-gray-900: #f7fafc;
      --reso-green-light: rgba(56,161,105,0.15);
      --reso-orange-light: rgba(255,153,0,0.15);
      --reso-blue-light: rgba(0,126,158,0.15);
    }
    html.dark .dd-landing-tile,
    html.dark .dd-landing-related-grid,
    html.dark .dd-landing-note,
    html.dark .search-modal { background: var(--reso-gray-100); }

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

    /* Landing page */
    .dd-landing {
      flex: 1;
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 1.5rem;
    }

    .dd-landing-header {
      margin-bottom: 2rem;
    }
    .dd-landing-header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--reso-gray-800);
      letter-spacing: -0.025em;
    }
    .dd-landing-header p {
      font-size: 0.95rem;
      color: var(--reso-gray-500);
      margin-top: 0.375rem;
      max-width: 700px;
      line-height: 1.6;
    }

    .dd-hero-search {
      margin-top: 1.25rem;
      max-width: 520px;
      position: relative;
      cursor: pointer;
    }
    .dd-hero-search-input {
      width: 100%;
      padding: 0.75rem 1rem 0.75rem 2.75rem;
      font-size: 0.9375rem;
      border: 1.5px solid var(--reso-gray-300);
      border-radius: 0.5rem;
      background: white;
      color: var(--reso-gray-600);
      cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .dd-hero-search-input:hover {
      border-color: var(--reso-blue);
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    html.dark .dd-hero-search-input { background: var(--reso-gray-100); }
    .dd-hero-search-icon {
      position: absolute;
      left: 0.875rem;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      fill: none;
      stroke: var(--reso-gray-500);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .dd-hero-search-kbd {
      position: absolute;
      right: 0.75rem;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.6875rem;
      font-family: inherit;
      color: var(--reso-gray-500);
      background: var(--reso-gray-100);
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.25rem;
      padding: 0.125rem 0.5rem;
      pointer-events: none;
    }

    .dd-landing-note {
      margin-top: 2rem;
      padding: 0.75rem 1rem;
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-left: 3px solid var(--reso-blue);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      color: var(--reso-gray-600);
      line-height: 1.6;
      max-width: 600px;
    }
    .dd-landing-note a {
      color: var(--reso-blue);
      text-decoration: none;
      font-weight: 500;
    }
    .dd-landing-note a:hover { text-decoration: underline; }

    .dd-landing-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1rem;
    }
    @media (min-width: 640px) {
      .dd-landing-grid { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    }

    .dd-landing-tile {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.625rem;
      padding: 1.5rem;
      text-decoration: none;
      color: inherit;
      transition: box-shadow 0.15s, border-color 0.15s;
      display: block;
    }
    .dd-landing-tile:hover {
      box-shadow: 0 4px 16px rgba(0,0,0,0.08);
      border-color: var(--reso-blue);
    }
    .dd-landing-tile-legacy {
      opacity: 0.75;
    }
    .dd-landing-tile-legacy:hover {
      opacity: 1;
    }

    .dd-landing-tile-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.375rem;
    }
    .dd-landing-tile-header h2 {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--reso-gray-800);
    }

    .dd-landing-badge {
      display: inline-flex;
      align-items: center;
      padding: 0.1875rem 0.625rem;
      border-radius: 0.25rem;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .dd-landing-badge-active {
      background: var(--reso-green-light);
      color: var(--reso-green);
    }
    .dd-landing-badge-legacy {
      background: var(--reso-gray-100);
      color: var(--reso-gray-500);
    }
    .dd-landing-badge-draft {
      background: var(--reso-orange-light);
      color: var(--reso-orange);
    }

    .dd-landing-tile-approved {
      font-size: 0.8125rem;
      color: var(--reso-gray-500);
      margin-bottom: 1rem;
    }

    .dd-landing-tile-stats {
      display: flex;
      gap: 1.5rem;
    }
    .dd-landing-stat {
      display: flex;
      flex-direction: column;
    }
    .dd-landing-stat-number {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--reso-gray-800);
      line-height: 1.2;
    }
    .dd-landing-stat-label {
      font-size: 0.6875rem;
      color: var(--reso-gray-500);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Related Resources */
    .dd-landing-related {
      margin-top: 2.5rem;
    }
    .dd-landing-related h3 {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--reso-gray-500);
      margin-bottom: 0.75rem;
    }
    .dd-landing-related-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.625rem;
      overflow: hidden;
    }
    @media (min-width: 768px) {
      .dd-landing-related-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .dd-landing-related-item {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--reso-gray-100);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: inherit;
      transition: background 0.1s;
    }
    .dd-landing-related-item:hover { background: var(--reso-gray-50); }
    .dd-landing-related-item:last-child { border-bottom: none; }
    @media (min-width: 768px) {
      .dd-landing-related-item { border-right: 1px solid var(--reso-gray-100); }
      .dd-landing-related-item:nth-child(2n) { border-right: none; }
      .dd-landing-related-item:nth-last-child(-n+2) { border-bottom: none; }
    }
    .dd-landing-related-icon {
      width: 36px;
      height: 36px;
      border-radius: 0.375rem;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .dd-landing-related-icon svg { width: 18px; height: 18px; }
    .dd-landing-related-icon-navy { background: rgba(26,47,88,0.1); }
    .dd-landing-related-icon-navy svg { fill: var(--reso-navy); }
    .dd-landing-related-icon-blue { background: rgba(0,126,158,0.1); }
    .dd-landing-related-icon-blue svg { fill: var(--reso-blue); }
    .dd-landing-related-icon-orange { background: rgba(255,153,0,0.1); }
    .dd-landing-related-icon-orange svg { fill: var(--reso-orange); }
    .dd-landing-related-icon-green { background: rgba(56,161,105,0.1); }
    .dd-landing-related-icon-green svg { fill: var(--reso-green); }
    .dd-landing-related-text h4 {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--reso-gray-800);
    }
    .dd-landing-related-text p {
      font-size: 0.75rem;
      color: var(--reso-gray-500);
      margin-top: 0.125rem;
    }

    /* Acknowledgements */
    .dd-landing-acknowledgements {
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--reso-gray-200);
    }
    .dd-landing-acknowledgements p {
      font-size: 0.8125rem;
      color: var(--reso-gray-500);
      line-height: 1.6;
    }
    .dd-landing-acknowledgements a {
      color: var(--reso-blue);
      text-decoration: none;
      font-weight: 600;
    }
    .dd-landing-acknowledgements a:hover { text-decoration: underline; }

    /* Theme toggle */
    .theme-toggle {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 0.375rem;
      color: rgba(255,255,255,0.7);
      padding: 0.375rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .theme-toggle:hover { background: rgba(255,255,255,0.25); color: white; }
    .theme-toggle svg { width: 16px; height: 16px; fill: currentColor; }
    .theme-toggle .icon-moon { display: block; }
    .theme-toggle .icon-sun { display: none; }
    html.dark .theme-toggle .icon-moon { display: none; }
    html.dark .theme-toggle .icon-sun { display: block; }

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
    @media (max-width: 768px) {
      .search-trigger { margin-top: 0.5rem; justify-content: center; }
      .search-trigger kbd { display: none; }
    }

    /* Search modal — reuses same styles as version pages */
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
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    @media (max-width: 768px) {
      .search-modal-overlay { padding-top: 1rem; }
      .search-modal { width: calc(100% - 1.5rem); max-height: 85vh; border-radius: 0.5rem; }
    }
    /* Pagefind flexbox layout — input+pills stay fixed, drawer scrolls */
    #search, .pagefind-ui, .pagefind-ui .pagefind-ui__form {
      display: flex !important; flex-direction: column !important; flex: 1 !important; min-height: 0 !important;
    }
    .pagefind-ui .pagefind-ui__form { padding: 1rem 1rem 0 !important; position: relative !important; }
    .pagefind-ui .pagefind-ui__form::before { position: absolute !important; top: 1.875rem !important; left: 1.625rem !important; width: 18px !important; height: 18px !important; }
    html.dark .pagefind-ui .pagefind-ui__form { background: #1e293b; }
    .pagefind-ui .pagefind-ui__search-input {
      border: 1.5px solid var(--reso-gray-300) !important; border-radius: 0.5rem !important;
      padding: 0.625rem 3.5rem 0.625rem 2.5rem !important; font-size: 1rem !important;
      color: var(--reso-gray-800) !important; background: var(--reso-gray-50) !important;
      font-family: inherit !important; height: auto !important;
    }
    .pagefind-ui .pagefind-ui__search-input::placeholder { color: var(--reso-gray-500) !important; }
    .pagefind-ui .pagefind-ui__search-input:focus {
      border-color: var(--reso-blue) !important; box-shadow: 0 0 0 3px rgba(0,126,158,0.15) !important; outline: none !important;
    }
    .pagefind-ui .pagefind-ui__search-clear {
      position: absolute !important; top: 1rem !important; right: 1.5rem !important;
      color: var(--reso-gray-500) !important; font-size: 0.8125rem !important; font-weight: 500 !important;
      background: none !important; border: none !important; padding: 0.125rem 0.375rem !important; cursor: pointer !important;
    }
    .pagefind-ui .pagefind-ui__search-clear:hover { color: var(--reso-gray-800) !important; }
    .dd-search-meta { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0 0.75rem; border-bottom: 1px solid var(--reso-gray-200); }
    .dd-search-filters { display: flex; gap: 0.375rem; flex-wrap: wrap; }
    .dd-search-filter-pill { padding: 0.1875rem 0.625rem; border-radius: 0.25rem; border: 1px solid var(--reso-gray-200); background: transparent; color: var(--reso-gray-600); font-size: 0.6875rem; font-weight: 500; cursor: pointer; transition: all 0.1s; }
    .dd-search-filter-pill:hover { border-color: var(--reso-blue); color: var(--reso-blue); }
    .dd-search-filter-pill.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }
    .dd-search-count { font-size: 0.6875rem; color: var(--reso-gray-500); white-space: nowrap; }
    .pagefind-ui .pagefind-ui__button { height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; padding: 0 !important; margin: 0 !important; border: none !important; }
    .pagefind-ui .pagefind-ui__message { display: none !important; }
    .pagefind-ui .pagefind-ui__filter-panel { display: none !important; }
    .pagefind-ui .pagefind-ui__drawer { padding: 0 1rem 1rem !important; overflow-y: auto !important; max-height: calc(70vh - 7.5rem) !important; }
    .pagefind-ui .pagefind-ui__result-link { color: var(--reso-blue) !important; font-weight: 600 !important; }
    .pagefind-ui .pagefind-ui__result-excerpt { font-size: 0.8125rem !important; color: var(--reso-gray-600) !important; line-height: 1.5 !important; }
    .pagefind-ui .pagefind-ui__result-tags { display: none !important; }
    .pagefind-ui .pagefind-ui__result { border-color: var(--reso-gray-200) !important; padding: 0.75rem 0 !important; }
    .dd-result-version { display: inline-block; font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.125rem 0.4375rem; border-radius: 0.1875rem; background: var(--reso-gray-100); color: var(--reso-gray-500); margin-left: 0.5rem; vertical-align: middle; }
    html.dark .search-modal { background: #1e293b !important; }
    html.dark .pagefind-ui .pagefind-ui__search-input { background: #2d3748 !important; border-color: #4a5568 !important; color: #e2e8f0 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-input::placeholder { color: #718096 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-clear { color: #a0aec0 !important; }
    html.dark .pagefind-ui .pagefind-ui__search-clear:hover { color: #e2e8f0 !important; }
    html.dark .dd-search-meta { border-color: #4a5568; }
    html.dark .pagefind-ui .pagefind-ui__result-link { color: #63b3ed !important; }
    html.dark .pagefind-ui .pagefind-ui__result-excerpt { color: #a0aec0 !important; }
    html.dark .pagefind-ui .pagefind-ui__result { border-color: #4a5568 !important; }
    html.dark .dd-search-filter-pill { background: transparent; border-color: #4a5568; color: #a0aec0; }
    html.dark .dd-search-filter-pill:hover { border-color: #63b3ed; color: #63b3ed; }
    html.dark .dd-search-filter-pill.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }
    html.dark .dd-result-version { background: #2d3748; color: #a0aec0; }
  </style>
  <link href="/pagefind/pagefind-ui.css" rel="stylesheet">
  <script>(function(){var t=localStorage.getItem('dd-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');})()</script>
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
      <a href="/dd/">Data Dictionary</a>
      <a href="https://github.com/RESOStandards/reso-tools">GitHub</a>
      <a href="https://certification.reso.org">Certification</a>
      <a href="https://reso.org">RESO.org</a>
      <button class="search-trigger" id="searchTrigger" type="button">
        <svg viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        Search<kbd>/</kbd>
      </button>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark mode">
        <svg class="icon-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24"><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41M12 6a6 6 0 100 12 6 6 0 000-12z"/></svg>
      </button>
    </nav>
  </header>

  <main class="dd-landing">
    <div class="dd-landing-header">
      <h1>Data Dictionary</h1>
      <p>The RESO Data Dictionary defines standard resources, fields and lookups for the exchange of real estate data.</p>
      <div class="dd-hero-search" id="heroSearch">
        <svg class="dd-hero-search-icon" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        <input class="dd-hero-search-input" type="text" placeholder="Search fields, resources and lookups..." readonly />
        <kbd class="dd-hero-search-kbd">/</kbd>
      </div>
    </div>

    <div class="dd-landing-grid">
      ${tilesHtml}
    </div>

    <div class="dd-landing-note">
      DD 2.0 is the current version for RESO certification. Ratified standards are published on the <a href="https://transport.reso.org" target="_blank" rel="noopener">RESO Transport site</a>. Log in to view <a href="https://reso.atlassian.net/wiki/spaces/DD/overview?homepageId=3305046895" target="_blank" rel="noopener">Data Dictionary discussions</a>.
    </div>

    <div class="dd-landing-related">
      <h3>Related Resources</h3>
      <div class="dd-landing-related-grid">
        <a href="https://ddwiki.reso.org" class="dd-landing-related-item">
          <div class="dd-landing-related-icon dd-landing-related-icon-navy">
            <svg viewBox="0 0 24 24"><path d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7c-2 0-3 1-3 3zm5 1h6m-6 3h6m-6 3h4"/></svg>
          </div>
          <div class="dd-landing-related-text">
            <h4>Data Dictionary Wiki</h4>
            <p>Browse all standard fields, resources and lookups</p>
          </div>
        </a>
        <a href="https://certification.reso.org" class="dd-landing-related-item">
          <div class="dd-landing-related-icon dd-landing-related-icon-green">
            <svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
          </div>
          <div class="dd-landing-related-text">
            <h4>Certification Portal</h4>
            <p>View certification results and analytics</p>
          </div>
        </a>
        <a href="https://transport.reso.org" class="dd-landing-related-item">
          <div class="dd-landing-related-icon dd-landing-related-icon-orange">
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/></svg>
          </div>
          <div class="dd-landing-related-text">
            <h4>Transport Specifications</h4>
            <p>Official RESO transport specifications and endorsements</p>
          </div>
        </a>
        <a href="https://www.reso.org/data-dictionary/" class="dd-landing-related-item">
          <div class="dd-landing-related-icon dd-landing-related-icon-blue">
            <svg viewBox="0 0 24 24"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div class="dd-landing-related-text">
            <h4>About the Data Dictionary</h4>
            <p>Learn about the RESO Data Dictionary program</p>
          </div>
        </a>
      </div>
    </div>
    <div class="dd-landing-acknowledgements">
      <p>The RESO Data Dictionary is a collaborative effort by industry experts who volunteer their time and expertise. <a href="https://www.reso.org/data-dictionary/acknowledgements/" target="_blank" rel="noopener">View contributors</a></p>
    </div>
  </main>

  <!-- Search modal -->
  <div class="search-modal-overlay" id="searchOverlay">
    <div class="search-modal" id="searchModal">
      <div id="search"></div>
    </div>
  </div>
  <template id="searchFiltersTemplate">
    <div class="dd-search-meta">
      <div class="dd-search-filters" id="ddSearchFilters">
        <button class="dd-search-filter-pill active" data-version="">All</button>
        ${allData.map(({ vCfg }) => `<button class="dd-search-filter-pill" data-version="${vCfg.version}">DD ${vCfg.version}</button>`).join('\n        ')}
      </div>
      <div class="dd-search-count" id="ddSearchCount"></div>
    </div>
  </template>

  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} <a href="https://reso.org">Real Estate Standards Organization (RESO)</a>. All rights reserved.</p>
    <p style="margin-top: 0.5rem;">
      <a href="https://github.com/RESOStandards/reso-tools">Source</a> &middot;
      <a href="https://certification.reso.org">Certification Analytics</a> &middot;
      <a href="https://www.reso.org/eula/">Terms of Use</a>
    </p>
  </footer>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Pagefind search
      var activeFilter = '';
      var pfUI = null;
      var searchEl = document.getElementById('search');
      var modalEl = document.getElementById('searchModal');
      var countEl = null;
      var filtersEl = null;
      var observer = null;

      function initPagefind(filterVersion) {
        var prevTerm = '';
        var prevInput = searchEl.querySelector('.pagefind-ui__search-input');
        if (prevInput) prevTerm = prevInput.value || '';
        if (observer) { observer.disconnect(); observer = null; }
        searchEl.innerHTML = '';
        var opts = { element: '#search', showSubResults: true, showImages: false, resetStyles: false };
        if (filterVersion) opts.filters = { 'dd-version': filterVersion };
        pfUI = new PagefindUI(opts);

        injectFilters();
        attachScrollLoader();

        var processing = false;
        observer = new MutationObserver(function() {
          if (processing) return;
          processing = true;
          requestAnimationFrame(function() {
            searchEl.querySelectorAll('.pagefind-ui__result-link:not([data-badge])').forEach(function(link) {
              link.setAttribute('data-badge', '1');
              var url = link.getAttribute('href') || '';
              var m = url.match(/\\/DD(\\d+\\.\\d+)\\//);
              if (m) {
                var badge = document.createElement('span');
                badge.className = 'dd-result-version';
                badge.textContent = 'DD ' + m[1];
                link.appendChild(badge);
              }
            });
            var msg = searchEl.querySelector('.pagefind-ui__message');
            if (msg && countEl) {
              var txt = msg.textContent || '';
              var cm = txt.match(/(\\d+)\\s+result/);
              var newCount = cm ? cm[1] + ' results' : '';
              if (countEl.textContent !== newCount) countEl.textContent = newCount;
            }
            processing = false;
          });
        });
        observer.observe(searchEl, { childList: true, subtree: true });

        if (prevTerm) {
          setTimeout(function() { pfUI.triggerSearch(prevTerm); }, 100);
        }
      }

      function injectFilters() {
        var form = searchEl.querySelector('.pagefind-ui__form');
        if (!form) return;
        var tpl = document.getElementById('searchFiltersTemplate');
        var clone = tpl.content.cloneNode(true);
        var drawer = form.querySelector('.pagefind-ui__drawer');
        if (drawer) form.insertBefore(clone, drawer);
        else form.appendChild(clone);
        filtersEl = form.querySelector('.dd-search-filters');
        countEl = form.querySelector('.dd-search-count');

        if (filtersEl) {
          filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) {
            b.classList.toggle('active', b.dataset.version === activeFilter);
          });
        }

        filtersEl.addEventListener('click', function(e) {
          var btn = e.target.closest('.dd-search-filter-pill');
          if (!btn || typeof PagefindUI === 'undefined') return;
          filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          activeFilter = btn.dataset.version;
          initPagefind(activeFilter);
        });
      }

      function attachScrollLoader() {
        var drawer = searchEl.querySelector('.pagefind-ui__drawer');
        if (!drawer) return;
        drawer.addEventListener('scroll', function() {
          if (drawer.scrollTop + drawer.clientHeight >= drawer.scrollHeight - 300) {
            var btn = searchEl.querySelector('.pagefind-ui__button');
            if (btn) btn.click();
          }
        });
      }

      var s = document.createElement('script');
      s.src = '/pagefind/pagefind-ui.js';
      s.onload = function() { if (typeof PagefindUI !== 'undefined') initPagefind(''); };
      document.head.appendChild(s);

      // Header hamburger
      document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('headerNav').classList.toggle('open');
      });

      // Search modal
      var overlay = document.getElementById('searchOverlay');
      function openSearch() {
        overlay.classList.add('active');
        setTimeout(function() {
          var pfInput = searchEl.querySelector('.pagefind-ui__search-input');
          if (pfInput) pfInput.focus();
        }, 100);
      }
      document.getElementById('searchTrigger').addEventListener('click', openSearch);
      document.getElementById('heroSearch').addEventListener('click', openSearch);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.classList.remove('active'); });
      document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          openSearch();
        }
        if (e.key === 'Escape') overlay.classList.remove('active');
      });

      // Theme toggle
      document.getElementById('themeToggle').addEventListener('click', function() {
        var isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('dd-theme', isDark ? 'dark' : 'light');
      });
    });
  </script>
</body>
</html>`;

  writeFileSync(join(OUTPUT_DIR, 'index.html'), html);
  console.log('  Generated DD landing page');
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

    const xrefCount = generateXrefPages(vCfg, data, VERSIONS);
    pageCount += xrefCount;

    console.log(`  Generated ${pageCount} pages (${xrefCount} cross-reference)`);
  }

  // Generate DD landing page
  generateDDLandingPage(allData);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Generator failed:', err);
  process.exit(1);
});
