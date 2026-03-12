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

// Resource descriptions sourced from the RESO Data Dictionary
const RESOURCE_DESCRIPTIONS = {
  Property: 'Fields commonly used in a Multiple Listing Service (MLS) listing.',
  Association: 'Fields pertaining to the local real estate trade association.',
  Caravan: 'Fields and lookups for the date, time, location and other particulars about caravan events.',
  CaravanStop: 'Stops along a caravan tour, connecting Caravan records to Open House records.',
  ContactListingNotes: 'Notes about a given listing from interactions between the contact and member within a consumer portal.',
  ContactListings: 'Maintains the relationship between contacts and members around listings in consumer portals.',
  Contacts: 'Information on client and other contacts of the member.',
  EntityEvent: 'An event log offering an alternative to timestamps, providing an OData-compliant logical timestamp methodology.',
  Field: 'Metadata about available fields on a given server in a predictable and user-friendly format.',
  HistoryTransactional: 'A transactional history of the listing, showing before and after values of field changes.',
  InternetTracking: 'A standard data set for recording and transfer of event-related information of real estate products.',
  InternetTrackingSummary: 'Sum of specific tracking events over a period of time, such as listings viewed or shared.',
  LockOrBox: 'Lockbox, smart lock and showing agent information.',
  Lookup: 'Metadata about lookups (enumerations) available on a given server.',
  Media: 'Photos, virtual tours, documents, supplements and other media related to listings.',
  Member: 'Roster of agents, brokers, appraisers, assistants, affiliates and other MLS/association members.',
  MemberAssociation: 'Joining information relating Member and Association records to each other.',
  MemberStateLicense: 'Supports members that hold multiple state licenses.',
  OUID: 'Organization Unique Identifier (UOI), a common ID system for organizations that exchange real estate data.',
  Office: 'Roster of offices who are members of the MLS and/or association.',
  OfficeAssociation: 'Joining information relating Office and Association records to each other.',
  OfficeCorporateLicense: 'Supports offices that hold multiple state licenses.',
  OpenHouse: 'Fields commonly used to record an open house event.',
  OtherPhone: 'Additional phone numbers for contacts or members, with type information.',
  PropertyGreenVerification: 'Multiple performance ratings applied to a property listing.',
  PropertyPowerProduction: 'Different means of producing power on a property, such as solar and wind systems.',
  PropertyPowerStorage: 'Different means of storing power on a property.',
  PropertyRooms: 'Detailed information about separate rooms in a property.',
  PropertyUnitTypes: 'Unit type details for residential income and multifamily properties.',
  Prospecting: 'Automatic email connecting Contacts and SavedSearch resources to send results matching saved search criteria.',
  Queue: 'Events that have occurred with records in other resources.',
  Rules: 'Business and system rules transmitted from host to client application.',
  SavedSearch: 'Saved search criteria and related data.',
  ShowingAppointment: 'Fields associated with showing appointments, including method, date, time and more.',
  ShowingAvailability: 'Fields associated with property availability for showings, including method, dates and duration.',
  ShowingRequest: 'Fields associated with showing requests, including method, date, time and more.',
  SocialMedia: 'Social media accounts for members, offices, contacts and other entities.',
  TeamMembers: 'Fields tying Member records to related Teams records.',
  Teams: 'Name and other information about teams of members who work together.',
  TransactionManagement: 'Tracking different types of transactions such as listing for sale or listing for lease.',
};

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

async function fetchUsageStats(allData) {
  const { TOKEN_URI, CLIENT_ID, CLIENT_SECRET, RESO_AGGS_URL } = process.env;
  if (!TOKEN_URI || !CLIENT_ID || !CLIENT_SECRET || !RESO_AGGS_URL) {
    console.log('Aggs API credentials not found, skipping usage stats');
    return null;
  }

  console.log('Fetching OAuth2 token...');
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
    console.warn('Failed to get OAuth2 token:', tokenRes.status);
    return null;
  }
  const { access_token } = await tokenRes.json();

  // Build a combined payload from all versions (union of resources/fields/lookups)
  const fieldsByResource = {};
  const lookupsByField = {};
  for (const { data } of allData) {
    for (const [resourceName, fields] of Object.entries(data.resourceMap)) {
      if (!fieldsByResource[resourceName]) fieldsByResource[resourceName] = new Set();
      for (const field of fields) {
        if (field.StandardName) fieldsByResource[resourceName].add(field.StandardName);
        if (field.LookupStatus?.includes('with Enumerations') && field.LookupName) {
          const lkKey = `${resourceName}:${field.StandardName}`;
          if (!lookupsByField[lkKey]) lookupsByField[lkKey] = new Set();
          for (const lk of (data.lookupMap[field.LookupName] || [])) {
            if (lk.StandardLookupValue) lookupsByField[lkKey].add(lk.StandardLookupValue);
          }
        }
      }
    }
  }

  const payload = [];
  for (const [resourceName, fieldSet] of Object.entries(fieldsByResource)) {
    const fieldNames = [...fieldSet];
    if (fieldNames.length > 0) {
      payload.push({ resourceName, fieldNames });
    }
  }
  for (const [key, lookupSet] of Object.entries(lookupsByField)) {
    const [resourceName, fieldName] = key.split(':');
    const lookupValues = [...lookupSet];
    if (lookupValues.length > 0) {
      payload.push({ resourceName, fieldName, lookupValues });
    }
  }

  console.log(`Fetching usage stats (${payload.length} queries)...`);
  const aggsRes = await fetch(RESO_AGGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!aggsRes.ok) {
    console.warn('Failed to fetch aggs:', aggsRes.status);
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
  return Math.round(mean * 100) + '%';
}

function usageHtml(stats, totalProviders) {
  if (!stats) {
    return `<div class="dd-usage dd-usage-na">
      <span class="dd-usage-label">Adoption</span><span class="dd-usage-value">0%</span>
      <p class="dd-usage-note">Usage data not yet available</p>
    </div>`;
  }
  const total = totalProviders || 0;
  const pct = total ? Math.round((stats.recipients / total) * 100) : 0;
  const adoptionDetail = total ? `${formatNumber(stats.recipients)} of ${formatNumber(total)} Organizations` : '';
  return `<div class="dd-usage">
    <span class="dd-usage-label">Adoption</span>
    <span class="dd-usage-value">${pct}%</span>
    ${adoptionDetail ? `<span class="dd-usage-detail">${adoptionDetail}</span>` : ''}
  </div>`;
}

function usageBadge(stats, totalProviders) {
  if (!stats) return '<span class="dd-usage-badge dd-usage-badge-na">&mdash;</span>';
  const pct = totalProviders ? Math.round((stats.recipients / totalProviders) * 100) + '%' : formatPercent(stats.mean);
  return `<span class="dd-usage-badge">${pct}</span>`;
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
// Shared CSS/JS extracted into functions so they can be written as external files
// ---------------------------------------------------------------------------

function getPageCSS() {
  return `    :root {
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
    html.dark .dd-resource-card,
    html.dark .search-modal { background: var(--reso-gray-100); }
    html.dark .dd-resource-card { border-color: var(--reso-gray-200); }
    html.dark .dd-resource-card h3 { color: #edf2f7; }
    html.dark .dd-metadata-card h2 { color: #edf2f7; }
    html.dark .dd-metadata-card h3 { color: #a0aec0; }
    html.dark .dd-resource-count { color: var(--reso-gray-500); }
    html.dark .dd-sidebar { background: var(--reso-gray-50); border-color: var(--reso-gray-200); }
    html.dark .dd-sidebar-title { color: #edf2f7; }
    html.dark .dd-sidebar-header { border-color: var(--reso-gray-200); }
    html.dark .dd-version-select { background: var(--reso-gray-100); border-color: var(--reso-gray-200); color: var(--reso-gray-700); }
    html.dark .dd-sidebar-search input { background: var(--reso-gray-100); border-color: var(--reso-gray-200); color: var(--reso-gray-700); }
    html.dark .dd-definition-callout { background: var(--reso-gray-100); color: var(--reso-gray-600); border-left-color: var(--reso-blue); }
    html.dark .dd-page-legacy-value { color: var(--reso-gray-500); }
    html.dark .dd-page-legacy-value code { background: var(--reso-gray-200); color: var(--reso-gray-700); }
    html.dark .dd-copy-btn { color: var(--reso-gray-500); }
    html.dark .dd-copy-btn:hover { color: var(--reso-blue); background: var(--reso-gray-200); }
    html.dark .dd-fields-table,
    html.dark .dd-lookups-table { background: var(--reso-gray-100); border-color: var(--reso-gray-200); }
    html.dark .dd-fields-table th,
    html.dark .dd-lookups-table th { background: var(--reso-gray-50); color: var(--reso-gray-500); }
    html.dark .dd-fields-table td,
    html.dark .dd-lookups-table td { color: var(--reso-gray-600); }
    html.dark .dd-fields-table th, html.dark .dd-fields-table td,
    html.dark .dd-lookups-table th, html.dark .dd-lookups-table td { border-bottom-color: var(--reso-gray-200); }
    html.dark .dd-fields-table tbody tr:nth-child(even),
    html.dark .dd-lookups-table tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.03); }
    html.dark .dd-fields-table tbody tr:hover,
    html.dark .dd-lookups-table tbody tr:hover { background: var(--reso-gray-200); }
    html.dark .dd-group-heading { color: #edf2f7; border-bottom-color: var(--reso-gray-200); }

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
    body.search-open { overflow: hidden; }
    .search-modal {
      background: white;
      border-radius: 0.75rem;
      width: 90%;
      max-width: 640px;
      height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    @media (max-width: 768px) {
      .search-modal-overlay { padding-top: 1rem; }
      .search-modal { width: calc(100% - 1.5rem); height: 85vh; border-radius: 0.5rem; }
    }

    /* Pagefind layout — input+pills fixed at top, drawer scrolls */
    #search, .pagefind-ui, .pagefind-ui .pagefind-ui__form {
      display: flex !important;
      flex-direction: column !important;
      flex: 1 !important;
      min-height: 0 !important;
    }
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
    /* Custom search input overlay */
    .dd-search-input {
      width: 100%;
      border: 1.5px solid var(--reso-gray-300);
      border-radius: 0.5rem;
      padding: 0.625rem 3.5rem 0.625rem 2.5rem;
      font-size: 1rem;
      color: var(--reso-gray-800);
      background: var(--reso-gray-50);
      font-family: inherit;
      box-sizing: border-box;
    }
    .dd-search-input::placeholder { color: var(--reso-gray-500); }
    .dd-search-input:focus {
      border-color: var(--reso-blue);
      box-shadow: 0 0 0 3px rgba(0,126,158,0.15);
      outline: none;
    }
    html.dark .dd-search-input { background: #2d3748; border-color: #4a5568; color: #e2e8f0; }
    html.dark .dd-search-input::placeholder { color: #718096; }
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
    .pagefind-ui .pagefind-ui__button { height: 0 !important; overflow: hidden !important; opacity: 0 !important; padding: 0 !important; margin: 0 !important; border: none !important; }
    .pagefind-ui .pagefind-ui__message { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; }
    .pagefind-ui .pagefind-ui__filter-panel { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; }

    /* Drawer fills remaining space and scrolls */
    .pagefind-ui .pagefind-ui__drawer {
      padding: 0 1rem 1rem !important;
      overflow-y: auto !important;
      flex: 1 !important;
      min-height: 0 !important;
    }
    .pagefind-ui .pagefind-ui__result-link { color: var(--reso-blue) !important; font-weight: 600 !important; }
    .pagefind-ui .pagefind-ui__result-excerpt { font-size: 0.8125rem !important; color: var(--reso-gray-600) !important; line-height: 1.5 !important; }
    .pagefind-ui .pagefind-ui__result-tags { display: none !important; }
    .pagefind-ui .pagefind-ui__result { border-color: var(--reso-gray-200) !important; padding: 0.75rem 0 !important; }

    /* Welcome state */
    .dd-search-welcome {
      display: none;
      text-align: center;
      padding: 2rem 1rem 3rem;
      color: var(--reso-gray-500);
      font-size: 0.9375rem;
      flex: 1;
      align-items: center;
      justify-content: flex-start;
      flex-direction: column;
      padding-top: 2rem;
    }
    .dd-search-welcome.visible { display: flex; }
    .dd-search-welcome-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.6; }
    .dd-search-welcome p { margin: 0 0 0.5rem; line-height: 1.5; }
    .dd-search-hint { font-size: 0.75rem; opacity: 0.7; }
    .dd-search-hint kbd {
      display: inline-block;
      padding: 0.125rem 0.375rem;
      font-size: 0.6875rem;
      font-family: inherit;
      background: var(--reso-gray-200);
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.25rem;
    }
    html.dark .dd-search-welcome { color: #a0aec0; }
    html.dark .dd-search-hint kbd { background: #2d3748; border-color: #4a5568; color: #a0aec0; }

    /* No results message */
    .dd-search-empty {
      display: none;
      text-align: center;
      padding: 3rem 1rem;
      color: var(--reso-gray-500);
      font-size: 0.875rem;
    }
    .dd-search-empty.visible { display: block; }
    html.dark .dd-search-empty { color: #a0aec0; }

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
    .dd-page-generated {
      border-top: 1px solid var(--reso-gray-200);
      margin-top: 2rem;
      padding-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--reso-gray-400);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .dd-page-generated a {
      color: var(--reso-gray-500);
      text-decoration: none;
    }
    .dd-page-generated a:hover {
      color: var(--reso-blue);
      text-decoration: underline;
    }

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
    .dd-nav-group-link.active { color: var(--reso-blue); font-weight: 700; background: var(--reso-gray-100); }
    .dd-nav-group.has-children > .dd-nav-group-link::after {
      content: '\\25B6';
      font-size: 0.75em;
      margin-left: 0.5rem;
      color: var(--reso-gray-500);
      transition: transform 0.15s;
      display: inline-block;
      vertical-align: middle;
    }
    .dd-nav-group.has-children.expanded > .dd-nav-group-link::after {
      transform: rotate(90deg);
      color: var(--reso-blue);
    }
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
    .dd-page-header h1 { font-size: 1.5rem; font-weight: 700; color: var(--reso-gray-800); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .dd-page-subtitle { font-size: 0.875rem; color: var(--reso-gray-500); margin-top: 0.25rem; }
    .dd-page-legacy-value { font-size: 0.8125rem; color: var(--reso-gray-500); margin-top: 0.25rem; }
    .dd-page-legacy-value code { background: var(--reso-gray-100); padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-size: 0.8125rem; }
    .dd-definition-callout {
      background: var(--reso-gray-50);
      border-left: 3px solid var(--reso-blue);
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.9375rem;
      line-height: 1.5;
      color: var(--reso-gray-700);
      border-radius: 0 0.375rem 0.375rem 0;
    }
    .dd-copy-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      padding: 0.25rem;
      cursor: pointer;
      color: var(--reso-gray-400);
      border-radius: 0.25rem;
      transition: color 0.15s, background 0.15s;
      flex-shrink: 0;
    }
    .dd-copy-btn:hover { color: var(--reso-blue); background: var(--reso-gray-100); }
    .dd-copy-btn.copied { color: var(--reso-green); }
    .dd-search-norm { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }

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
    .dd-resource-desc { font-size: 0.75rem; color: var(--reso-gray-600); line-height: 1.4; margin-top: 0.25rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .dd-resource-count { font-size: 0.75rem; color: var(--reso-gray-500); margin-top: 0.375rem; }

    /* Fields table */
    .dd-fields-table-wrapper { margin-top: 0.5rem; }
    .dd-group-heading {
      font-size: 1rem;
      font-weight: 600;
      color: var(--reso-navy);
      margin: 1.5rem 0 0.5rem;
      padding-bottom: 0.375rem;
      border-bottom: 2px solid var(--reso-gray-200);
      scroll-margin-top: calc(var(--sticky-thead-top, 180px) + 2.5rem);
    }
    .dd-group-heading:first-child { margin-top: 0; }
    .dd-group-depth-2 { font-size: 0.9375rem; border-bottom-width: 1px; }
    .dd-group-depth-3 { font-size: 0.875rem; border-bottom-width: 1px; }
    .dd-group-parent { color: var(--reso-gray-400); font-weight: 400; }
    .dd-group-sep { color: var(--reso-gray-500); font-weight: 500; font-size: 1.1em; }

    .dd-fields-table, .dd-lookups-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
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
    /* Sticky column headers — always active */
    .dd-fields-table-wrapper .dd-fields-table {
      overflow: visible;
      border-radius: 0;
    }
    .dd-fields-table-wrapper .dd-fields-table th {
      position: sticky;
      top: var(--sticky-thead-top, 180px);
      z-index: 5;
      box-shadow: 0 1px 0 var(--reso-gray-200);
    }
    /* In grouped view, hide all table theads — sticky div header replaces them */
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table thead {
      display: none;
    }
    /* Sticky column header bar for grouped view */
    .dd-sticky-col-headers {
      display: none;
      position: sticky;
      top: var(--sticky-thead-top, 180px);
      z-index: 6;
      grid-template-columns: 22% 1fr 17% 11%;
      background: var(--reso-gray-50);
      font-weight: 600;
      color: var(--reso-gray-600);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 0.5rem 0.75rem;
      margin: 0 1px;
      border-bottom: 1px solid var(--reso-gray-200);
      box-shadow: 0 1px 0 var(--reso-gray-200);
    }
    html.dark .dd-sticky-col-headers {
      background: var(--reso-gray-50);
      color: var(--reso-gray-500);
      border-bottom-color: var(--reso-gray-200);
    }
    .dd-fields-table-wrapper.dd-grouped .dd-sticky-col-headers {
      display: grid;
    }
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table {
      table-layout: fixed;
    }
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table td:nth-child(1) { width: 22%; }
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table td:nth-child(2) { width: auto; }
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table td:nth-child(3) { width: 18%; }
    .dd-fields-table-wrapper.dd-grouped .dd-fields-table td:nth-child(4) { width: 12%; }
    /* Mobile group indicator — sticky chip below column headers */
    .dd-mobile-group-indicator {
      display: none;
      position: sticky;
      top: calc(var(--sticky-thead-top, 180px) + 1.75rem);
      z-index: 4;
      background: var(--reso-navy);
      color: white;
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 0.25rem 0.625rem;
      border-radius: 0 0 0.375rem 0.375rem;
      width: fit-content;
      margin: 0 auto -0.5rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      letter-spacing: 0.02em;
      pointer-events: none;
      transition: opacity 0.15s;
    }
    @media (max-width: 768px) {
      .dd-resource-sticky {
        position: static;
      }
      .dd-fields-table-wrapper .dd-fields-table th {
        top: 64px;
      }
      .dd-mobile-group-indicator {
        top: calc(64px + 1.75rem);
      }
      .dd-fields-table-wrapper.dd-grouped .dd-mobile-group-indicator {
        display: block;
      }
    }
    .dd-fields-table tbody tr:nth-child(even), .dd-lookups-table tbody tr:nth-child(even) {
      background: rgba(0, 0, 0, 0.04);
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

    .dd-usage-detail { font-size: 0.75rem; color: var(--reso-gray-400); grid-column: 1 / -1; }
    html.dark .dd-usage-detail { color: #718096; }

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
    .dd-metadata-table th small { display: block; font-size: 0.625rem; font-weight: 400; color: var(--reso-gray-400); text-transform: none; letter-spacing: 0; margin-top: 0.0625rem; }
    .dd-metadata-table td { padding: 0.375rem 0; color: var(--reso-gray-700); }
    .dd-metadata-table tr { border-bottom: 1px solid var(--reso-gray-100); }

    .dd-meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 2rem;
    }
    @media (max-width: 768px) {
      .dd-meta-grid { grid-template-columns: 1fr; }
    }
    .dd-meta-grid .dd-metadata-table { width: 100%; }

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

    /* Sticky resource header */
    .dd-resource-sticky {
      position: sticky;
      top: 64px;
      z-index: 10;
      background: var(--reso-gray-50);
      margin: -1.5rem -2rem 0;
      padding: 1.5rem 2rem 0.25rem;
    }
    @media (max-width: 768px) {
      .dd-resource-sticky { margin: -1rem -1rem 0; padding: 1rem 1rem 0.25rem; }
    }
    html.dark .dd-resource-sticky { background: var(--reso-gray-50); }

    /* Sort controls */
    .dd-sort-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
      flex-wrap: wrap;
    }
    .dd-sort-controls label {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--reso-gray-500);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-sort-pill {
      display: inline-flex;
      align-items: center;
      padding: 0.3125rem 0.625rem;
      border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--reso-gray-600);
      background: transparent;
      cursor: pointer;
      text-decoration: none;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      line-height: 1.2;
    }
    .dd-sort-pill:hover { border-color: var(--reso-blue); color: var(--reso-blue); }
    .dd-sort-pill.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }
    .dd-sort-pill .dd-sort-arrow { margin-left: 0.25rem; font-size: 0.5rem; }
    .dd-group-toggle {
      margin-left: auto;
      display: inline-flex; align-items: center;
      padding: 0.3125rem 0.625rem; border: 1px solid var(--reso-gray-300);
      border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600;
      color: var(--reso-gray-600); background: transparent; cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      line-height: 1.2;
    }
    .dd-group-toggle:hover { border-color: var(--reso-blue); color: var(--reso-blue); }
    .dd-group-toggle.active { background: var(--reso-blue); border-color: var(--reso-blue); color: white; }

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
    .badge-green { background: var(--reso-green); color: white; }

    /* Sidebar sections — collapsible accordion */
    .dd-sidebar-section { margin-bottom: 0; border-bottom: 1px solid var(--reso-gray-200); }
    .dd-sidebar-section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.625rem 1rem;
      font-size: 0.625rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--reso-gray-500);
      cursor: pointer;
      user-select: none;
    }
    .dd-sidebar-section-title:hover { color: var(--reso-blue); }
    .dd-sidebar-section-title .dd-section-arrow {
      font-size: 0.5rem;
      transition: transform 0.2s;
    }
    .dd-sidebar-section:not(.expanded) .dd-section-arrow { transform: rotate(-90deg); }
    .dd-sidebar-section:not(.expanded) > .dd-nav-resources { display: none; }

    /* About pages */
    .dd-about-section { margin-bottom: 2rem; }
    .dd-about-section h2 {
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--reso-gray-800);
      margin-bottom: 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--reso-gray-200);
    }
    .dd-about-section h3 {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--reso-gray-700);
      margin: 1rem 0 0.5rem;
    }
    .dd-about-section p {
      font-size: 0.875rem;
      color: var(--reso-gray-700);
      line-height: 1.7;
      margin-bottom: 0.75rem;
    }
    .dd-about-section ul, .dd-about-section ol {
      font-size: 0.875rem;
      color: var(--reso-gray-700);
      line-height: 1.7;
      margin: 0 0 0.75rem 1.5rem;
    }
    .dd-about-section li { margin-bottom: 0.25rem; }

    .dd-def-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .dd-def-item {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
    }
    html.dark .dd-def-item { background: var(--reso-gray-100); border-color: var(--reso-gray-200); }
    .dd-def-item dt {
      font-size: 0.8125rem;
      font-weight: 700;
      color: var(--reso-navy);
      margin-bottom: 0.25rem;
    }
    html.dark .dd-def-item dt { color: #90cdf4; }
    .dd-def-item dd {
      font-size: 0.8125rem;
      color: var(--reso-gray-600);
      line-height: 1.6;
      margin: 0;
    }
    .dd-def-item .dd-def-values {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      margin-top: 0.375rem;
    }
    .dd-def-item .dd-def-tag {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 500;
      background: var(--reso-gray-100);
      color: var(--reso-gray-600);
    }
    html.dark .dd-def-item .dd-def-tag { background: var(--reso-gray-200); }

    .dd-about-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.375rem;
      overflow: hidden;
      margin-bottom: 1rem;
    }
    html.dark .dd-about-table { background: var(--reso-gray-100); }
    .dd-about-table th, .dd-about-table td {
      padding: 0.5rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--reso-gray-100);
    }
    .dd-about-table th {
      background: var(--reso-gray-50);
      font-weight: 600;
      color: var(--reso-gray-600);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .dd-about-table tbody tr:hover { background: var(--reso-blue-light); }
    .dd-about-table a { color: var(--reso-blue); text-decoration: none; font-weight: 600; }
    .dd-about-table a:hover { text-decoration: underline; }

    .dd-about-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .dd-about-card {
      background: white;
      border: 1px solid var(--reso-gray-200);
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
      text-decoration: none;
      color: inherit;
      transition: box-shadow 0.15s, border-color 0.15s;
    }
    .dd-about-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-color: var(--reso-blue); }
    html.dark .dd-about-card { background: var(--reso-gray-100); border-color: var(--reso-gray-200); }
    .dd-about-card h3 { font-size: 0.9375rem; font-weight: 600; color: var(--reso-navy); margin: 0 0 0.25rem; }
    html.dark .dd-about-card h3 { color: #edf2f7; }
    .dd-about-card p { font-size: 0.75rem; color: var(--reso-gray-600); line-height: 1.4; margin: 0; }

    .dd-callout {
      background: var(--reso-blue-light);
      border-left: 4px solid var(--reso-blue);
      border-radius: 0 0.375rem 0.375rem 0;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      font-size: 0.8125rem;
      color: var(--reso-gray-700);
    }
    .dd-callout strong { color: var(--reso-gray-800); }`;
}

function getPageJS() {
  return `    document.addEventListener('DOMContentLoaded', function() {
      var currentVersion = document.body.dataset.version;
      var activeFilter = currentVersion;
      var pfUI = null;
      var searchEl = document.getElementById('search');
      var modalEl = document.getElementById('searchModal');
      var countEl = null;
      var filtersEl = null;
      var ddCustomInput = null;

      var observer = null;

      function initPagefind() {
        pfUI = new PagefindUI({
          element: '#search', showSubResults: false, showImages: false, resetStyles: false,
          processResult: function(result) {
            var parts = [];
            if (result.meta && result.meta.description) parts.push(result.meta.description);
            if (result.meta && result.meta.date) parts.push(result.meta.date);
            var line1 = parts.join(' &middot; ');
            var def = (result.meta && result.meta.definition) ? result.meta.definition : '';
            result.excerpt = (line1 && def) ? line1 + '<br>' + def : (line1 || def || result.excerpt);
            return result;
          }
        });

        // Inject filter pills before the drawer
        var form = searchEl.querySelector('.pagefind-ui__form');
        if (form) {
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
            filtersEl.addEventListener('click', function(e) {
              var btn = e.target.closest('.dd-search-filter-pill');
              if (!btn) return;
              filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) { b.classList.remove('active'); });
              btn.classList.add('active');
              activeFilter = btn.dataset.version;
              applyFilter(activeFilter);
              var welcomeText = document.getElementById('ddSearchWelcomeText');
              if (welcomeText) {
                welcomeText.textContent = activeFilter
                  ? 'Search across Data Dictionary ' + activeFilter + ' resources, fields and lookup values.'
                  : 'Search across all Data Dictionary resources, fields and lookup values.';
              }
            });
          }
        }

        // Custom input overlay: user types here, we normalize and proxy to Pagefind
        var pfInput = searchEl.querySelector('.pagefind-ui__search-input');
        if (pfInput) {
          pfInput.style.position = 'absolute';
          pfInput.style.opacity = '0';
          pfInput.style.pointerEvents = 'none';
          var customInput = document.createElement('input');
          customInput.type = 'text';
          customInput.placeholder = 'Search...';
          customInput.className = 'dd-search-input';
          pfInput.parentNode.insertBefore(customInput, pfInput);
          ddCustomInput = customInput;

          function clearSearch() {
            customInput.value = '';
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var emptyEl = document.getElementById('ddSearchEmpty');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.add('visible');
            if (emptyEl) emptyEl.classList.remove('visible');
            if (drawerEl) drawerEl.style.display = 'none';
            if (countEl) countEl.textContent = '';
            pfUI.triggerSearch('');
          }

          var normDebounce = null;
          customInput.addEventListener('input', function() {
            var raw = customInput.value;
            var hasQuery = raw.trim().length > 0;
            if (!hasQuery) { clearSearch(); return; }
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var emptyEl = document.getElementById('ddSearchEmpty');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.remove('visible');
            if (emptyEl) emptyEl.classList.remove('visible');
            if (drawerEl) drawerEl.style.display = '';
            clearTimeout(normDebounce);
            normDebounce = setTimeout(function() {
              var normalized = customInput.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
              if (normalized) pfUI.triggerSearch(normalized);
            }, 150);
          });

          // Sync Pagefind's Clear button with our custom input
          var clearBtn = searchEl.querySelector('.pagefind-ui__search-clear');
          if (clearBtn) {
            clearBtn.addEventListener('click', function() { clearSearch(); customInput.focus(); });
          }
        }

        // Attach infinite scroll on the drawer
        var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
        if (drawerEl) {
          drawerEl.addEventListener('scroll', function() {
            if (drawerEl.scrollTop + drawerEl.clientHeight >= drawerEl.scrollHeight - 300) {
              var btn = searchEl.querySelector('.pagefind-ui__button');
              if (btn) btn.click();
            }
          });
        }

        // Observe for version badges, result count, and auto-load
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
            // Re-sort: exact title matches go first
            var query = ddCustomInput ? ddCustomInput.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
            if (query) {
              var resultsList = searchEl.querySelector('.pagefind-ui__results');
              if (resultsList) {
                var items = Array.from(resultsList.querySelectorAll('.pagefind-ui__result'));
                var needsSort = items.some(function(item) {
                  var link = item.querySelector('.pagefind-ui__result-link');
                  if (!link) return false;
                  var title = (link.textContent || '').replace(/DD\\s*\\d+\\.\\d+$/, '').trim();
                  return title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === query;
                });
                if (needsSort) {
                  observer.disconnect();
                  items.forEach(function(item) {
                    var link = item.querySelector('.pagefind-ui__result-link');
                    if (!link) return;
                    var title = (link.textContent || '').replace(/DD\\s*\\d+\\.\\d+$/, '').trim();
                    var normTitle = title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    if (normTitle === query) {
                      resultsList.insertBefore(item, resultsList.firstChild);
                    }
                  });
                  observer.observe(searchEl, { childList: true, subtree: true });
                }
              }
            }
            var hasQuery = ddCustomInput && ddCustomInput.value.trim().length > 0;
            var msg = searchEl.querySelector('.pagefind-ui__message');
            var emptyEl = document.getElementById('ddSearchEmpty');
            if (msg && countEl) {
              if (!hasQuery) {
                countEl.textContent = '';
                if (emptyEl) emptyEl.classList.remove('visible');
              } else {
                var txt = msg.textContent || '';
                var cm = txt.match(/(\\d+)\\s+result/);
                var count = cm ? parseInt(cm[1], 10) : -1;
                var newCount = count > 0 ? count + ' results' : '';
                if (countEl.textContent !== newCount) countEl.textContent = newCount;
                if (emptyEl) emptyEl.classList.toggle('visible', count === 0);
              }
            }
            var dEl = searchEl.querySelector('.pagefind-ui__drawer');
            var loadBtn = searchEl.querySelector('.pagefind-ui__button');
            if (dEl && loadBtn && dEl.scrollHeight <= dEl.clientHeight) {
              setTimeout(function() { loadBtn.click(); }, 50);
            }
            processing = false;
          });
        });
        observer.observe(searchEl, { childList: true, subtree: true });

        // Apply initial filter and set welcome text
        if (activeFilter) {
          pfUI.triggerFilters({ 'dd-version': [activeFilter] });
          var welcomeText = document.getElementById('ddSearchWelcomeText');
          if (welcomeText) {
            welcomeText.textContent = 'Search across Data Dictionary ' + activeFilter + ' resources, fields and lookup values.';
          }
        }
      }

      function applyFilter(version) {
        if (!pfUI) return;
        if (version) {
          pfUI.triggerFilters({ 'dd-version': [version] });
        } else {
          pfUI.triggerFilters({});
        }
        // Re-trigger current search term (normalized) so results update
        var raw = ddCustomInput ? ddCustomInput.value : '';
        if (raw) {
          pfUI.triggerSearch(raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase());
        }
      }

      // Load Pagefind
      var s = document.createElement('script');
      s.src = '/pagefind/pagefind-ui.js';
      s.onload = function() { if (typeof PagefindUI !== 'undefined') initPagefind(); };
      document.head.appendChild(s);

      // Header hamburger
      document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('headerNav').classList.toggle('open');
      });

      // Search modal
      var overlay = document.getElementById('searchOverlay');
      function openSearch() {
        overlay.classList.add('active');
        document.body.classList.add('search-open');
        setTimeout(function() {
          if (ddCustomInput) {
            ddCustomInput.focus();
            var hasQuery = ddCustomInput.value.trim().length > 0;
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.toggle('visible', !hasQuery);
            if (drawerEl) drawerEl.style.display = hasQuery ? '' : 'none';
            if (!hasQuery && countEl) countEl.textContent = '';
          }
        }, 100);
      }
      function closeSearch() {
        overlay.classList.remove('active');
        document.body.classList.remove('search-open');
      }
      // Sidebar accordion — one open at a time
      document.querySelectorAll('.dd-sidebar-section-title').forEach(function(title) {
        title.addEventListener('click', function() {
          var section = title.parentElement;
          var wasExpanded = section.classList.contains('expanded');
          document.querySelectorAll('.dd-sidebar-section').forEach(function(s) {
            s.classList.remove('expanded');
          });
          if (!wasExpanded) section.classList.add('expanded');
        });
      });

      document.getElementById('searchTrigger').addEventListener('click', openSearch);
      var sidebarSearchEl = document.getElementById('sidebarSearch');
      if (sidebarSearchEl) sidebarSearchEl.addEventListener('click', openSearch);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeSearch(); });
      document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          openSearch();
        }
        if (e.key === 'Escape') closeSearch();
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

      // Toggle subgroup visibility in sidebar
      document.querySelectorAll('.dd-nav-group.has-children > .dd-nav-group-link').forEach(function(link) {
        link.addEventListener('click', function(e) {
          var li = link.closest('.dd-nav-group');
          if (li.classList.contains('expanded')) {
            e.preventDefault();
            li.classList.remove('expanded');
          } else {
            li.classList.add('expanded');
          }
        });
      });

      // Theme toggle
      document.getElementById('themeToggle').addEventListener('click', function() {
        var isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('dd-theme', isDark ? 'dark' : 'light');
      });

      // Copy-to-clipboard buttons
      document.querySelectorAll('.dd-copy-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          var text = btn.getAttribute('data-copy');
          if (!text) return;
          navigator.clipboard.writeText(text).then(function() {
            var svg = btn.querySelector('svg');
            var origHTML = svg.outerHTML;
            svg.outerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
            btn.classList.add('copied');
            setTimeout(function() {
              btn.innerHTML = origHTML;
              btn.classList.remove('copied');
            }, 1500);
          });
        });
      });

      // Collapsible panels
      document.querySelectorAll('.dd-collapsible-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
          btn.parentElement.classList.toggle('open');
        });
      });

      // Pill-based sort helper — returns a reset function
      function initSortPills(container, onSort) {
        if (!container) return function() {};
        var pills = Array.from(container.querySelectorAll('.dd-sort-pill'));
        var currentField = pills.length ? pills[0].dataset.sort : '';
        var ascending = true;
        pills.forEach(function(pill) {
          pill.addEventListener('click', function() {
            var sf = pill.dataset.sort;
            if (sf === currentField) {
              ascending = !ascending;
            } else {
              currentField = sf;
              ascending = true;
              pills.forEach(function(p) { p.classList.remove('active'); });
              pill.classList.add('active');
            }
            var arrow = pill.querySelector('.dd-sort-arrow');
            pills.forEach(function(p) {
              var a = p.querySelector('.dd-sort-arrow');
              if (a) a.innerHTML = '&#9650;';
            });
            if (arrow) arrow.innerHTML = ascending ? '&#9650;' : '&#9660;';
            onSort(currentField, ascending);
          });
        });
        return function resetPills() {
          currentField = pills.length ? pills[0].dataset.sort : '';
          ascending = true;
          pills.forEach(function(p) {
            p.classList.remove('active');
            var a = p.querySelector('.dd-sort-arrow');
            if (a) a.innerHTML = '&#9650;';
          });
          if (pills.length) pills[0].classList.add('active');
        };
      }

      // Sort controls for version landing (resource grid)
      var resGrid = document.getElementById('ddResourceGrid');
      if (resGrid) {
        var resSortContainer = resGrid.previousElementSibling;
        initSortPills(resSortContainer, function(field, asc) {
          var cards = Array.from(resGrid.querySelectorAll('.dd-resource-card'));
          cards.sort(function(a, b) {
            if (field === 'name') {
              return asc ? a.dataset.name.localeCompare(b.dataset.name) : b.dataset.name.localeCompare(a.dataset.name);
            } else if (field === 'fields') {
              var fa = parseInt(a.dataset.fields), fb = parseInt(b.dataset.fields);
              return asc ? fb - fa : fa - fb;
            }
            return 0;
          });
          cards.forEach(function(c) { resGrid.appendChild(c); });
        });
      }

      // Sort controls for resource pages
      var wrapper = document.querySelector('.dd-fields-table-wrapper');
      if (wrapper) {
        var groupToggle = document.getElementById('ddGroupToggle');
        var originalHTML = wrapper.innerHTML;
        var groupsVisible = !!groupToggle;

        // Calculate sticky offset from resource sticky header
        function updateStickyOffset() {
          var stickyHeader = document.querySelector('.dd-resource-sticky');
          if (stickyHeader) {
            var rect = stickyHeader.getBoundingClientRect();
            var top = rect.height + 64;
            wrapper.style.setProperty('--sticky-thead-top', top + 'px');
          }
        }
        updateStickyOffset();
        window.addEventListener('resize', updateStickyOffset);

        function flatSort(field, ascending) {
          var headings = wrapper.querySelectorAll('.dd-group-heading');
          var tables = wrapper.querySelectorAll('.dd-fields-table');
          headings.forEach(function(h) { h.style.display = 'none'; });
          var allRows = [];
          tables.forEach(function(t) {
            Array.from(t.querySelectorAll('tbody tr')).forEach(function(r) { allRows.push(r); });
          });
          allRows.sort(function(a, b) {
            var va, vb;
            if (field === 'name') {
              va = a.dataset.name || ''; vb = b.dataset.name || '';
              return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
            } else if (field === 'usage') {
              va = parseFloat(a.dataset.usage) || -1; vb = parseFloat(b.dataset.usage) || -1;
              return ascending ? vb - va : va - vb;
            } else if (field === 'added') {
              va = a.dataset.added || ''; vb = b.dataset.added || '';
              return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
            } else if (field === 'type') {
              va = a.dataset.type || ''; vb = b.dataset.type || '';
              return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
            } else if (field === 'revised') {
              va = a.dataset.revised || ''; vb = b.dataset.revised || '';
              return ascending ? vb.localeCompare(va) : va.localeCompare(vb);
            }
            return 0;
          });
          if (tables.length > 0) {
            var mainTbody = tables[0].querySelector('tbody');
            allRows.forEach(function(r) { mainTbody.appendChild(r); });
            for (var i = 1; i < tables.length; i++) tables[i].style.display = 'none';
          }
          wrapper.classList.remove('dd-grouped');
        }

        // Sidebar group tree for the active resource
        var sidebarGroups = document.querySelector('.dd-nav-resource.expanded > .dd-nav-groups');

        var fieldSortContainer = document.querySelector('.dd-sort-controls');
        var resetPills = initSortPills(fieldSortContainer, function(field, ascending) {
          if (groupToggle && groupsVisible) {
            groupsVisible = false;
            groupToggle.classList.remove('active');
          }
          flatSort(field, ascending);
          updateStickyOffset();
          if (sidebarGroups) sidebarGroups.style.display = 'none';
        });

        if (groupToggle) {
          groupToggle.addEventListener('click', function() {
            if (groupsVisible) {
              groupsVisible = false;
              groupToggle.classList.remove('active');
              flatSort('name', true);
              resetPills();
              updateStickyOffset();
              if (sidebarGroups) sidebarGroups.style.display = 'none';
            } else {
              groupsVisible = true;
              groupToggle.classList.add('active');
              wrapper.classList.add('dd-grouped');
              wrapper.innerHTML = originalHTML;
              resetPills();
              updateStickyOffset();
              initScrollSpy();
              if (sidebarGroups) sidebarGroups.style.display = '';
            }
          });
        }
      }

      // Scroll-spy: sync sidebar tree with visible group headings
      var groupLinks = document.querySelectorAll('.dd-nav-group-link');
      var activeGroupLink = null;
      var currentObserver = null;

      function initScrollSpy() {
        var groupHeadings = document.querySelectorAll('.dd-group-heading');
        if (groupHeadings.length === 0) return;
        var mobileGroupLabel = document.getElementById('ddMobileGroupLabel');

        if (currentObserver) currentObserver.disconnect();

        currentObserver = new IntersectionObserver(function(entries) {
          var topEntry = null;
          entries.forEach(function(entry) {
            if (entry.isIntersecting) {
              if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
                topEntry = entry;
              }
            }
          });
          if (topEntry) activateGroupLink(topEntry.target.id, mobileGroupLabel);
        }, { rootMargin: '-80px 0px -60% 0px' });

        groupHeadings.forEach(function(h) { currentObserver.observe(h); });
      }

      function activateGroupLink(id, mobileGroupLabel) {
        if (activeGroupLink) activeGroupLink.classList.remove('active');
        var link = null;
        for (var i = 0; i < groupLinks.length; i++) {
          if (groupLinks[i].getAttribute('href') === '#' + id) {
            link = groupLinks[i];
            break;
          }
        }
        if (!link) return;
        activeGroupLink = link;
        link.classList.add('active');
        // Update mobile group indicator
        if (mobileGroupLabel) {
          mobileGroupLabel.textContent = link.textContent.trim();
        }
        // Expand this group and all ancestor group nodes
        var group = link.closest('.dd-nav-group');
        while (group) {
          group.classList.add('expanded');
          group = group.parentElement.closest('.dd-nav-group');
        }
        // Scroll sidebar to keep active link visible
        var sidebar = document.getElementById('ddSidebar');
        if (sidebar && link.offsetParent) {
          var linkRect = link.getBoundingClientRect();
          var sidebarRect = sidebar.getBoundingClientRect();
          if (linkRect.top < sidebarRect.top || linkRect.bottom > sidebarRect.bottom) {
            link.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      }

      initScrollSpy();
    });`;
}

function getLandingCSS() {
  return `    :root {
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
    body.search-open { overflow: hidden; }
    .search-modal {
      background: white;
      border-radius: 0.75rem;
      width: 90%;
      max-width: 640px;
      height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    @media (max-width: 768px) {
      .search-modal-overlay { padding-top: 1rem; }
      .search-modal { width: calc(100% - 1.5rem); height: 85vh; border-radius: 0.5rem; }
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
    .dd-search-input {
      width: 100%; border: 1.5px solid var(--reso-gray-300); border-radius: 0.5rem;
      padding: 0.625rem 3.5rem 0.625rem 2.5rem; font-size: 1rem;
      color: var(--reso-gray-800); background: var(--reso-gray-50); font-family: inherit; box-sizing: border-box;
    }
    .dd-search-input::placeholder { color: var(--reso-gray-500); }
    .dd-search-input:focus { border-color: var(--reso-blue); box-shadow: 0 0 0 3px rgba(0,126,158,0.15); outline: none; }
    html.dark .dd-search-input { background: #2d3748; border-color: #4a5568; color: #e2e8f0; }
    html.dark .dd-search-input::placeholder { color: #718096; }
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
    .pagefind-ui .pagefind-ui__button { height: 0 !important; overflow: hidden !important; opacity: 0 !important; padding: 0 !important; margin: 0 !important; border: none !important; }
    .pagefind-ui .pagefind-ui__message { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; }
    .pagefind-ui .pagefind-ui__filter-panel { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; }
    .pagefind-ui .pagefind-ui__drawer { padding: 0 1rem 1rem !important; overflow-y: auto !important; flex: 1 !important; min-height: 0 !important; }
    .pagefind-ui .pagefind-ui__result-link { color: var(--reso-blue) !important; font-weight: 600 !important; }
    .pagefind-ui .pagefind-ui__result-excerpt { font-size: 0.8125rem !important; color: var(--reso-gray-600) !important; line-height: 1.5 !important; }
    .pagefind-ui .pagefind-ui__result-tags { display: none !important; }
    .pagefind-ui .pagefind-ui__result { border-color: var(--reso-gray-200) !important; padding: 0.75rem 0 !important; }
    .dd-result-version { display: inline-block; font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.125rem 0.4375rem; border-radius: 0.1875rem; background: var(--reso-gray-100); color: var(--reso-gray-500); margin-left: 0.5rem; vertical-align: middle; }
    .dd-search-welcome { display: none; text-align: center; padding: 2rem 1rem 3rem; padding-top: 2rem; color: var(--reso-gray-500); font-size: 0.9375rem; flex: 1; align-items: center; justify-content: flex-start; flex-direction: column; }
    .dd-search-welcome.visible { display: flex; }
    .dd-search-welcome-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.6; }
    .dd-search-welcome p { margin: 0 0 0.5rem; line-height: 1.5; }
    .dd-search-hint { font-size: 0.75rem; opacity: 0.7; }
    .dd-search-hint kbd { display: inline-block; padding: 0.125rem 0.375rem; font-size: 0.6875rem; font-family: inherit; background: var(--reso-gray-200); border: 1px solid var(--reso-gray-300); border-radius: 0.25rem; }
    html.dark .dd-search-welcome { color: #a0aec0; }
    html.dark .dd-search-hint kbd { background: #2d3748; border-color: #4a5568; color: #a0aec0; }
    .dd-search-empty { display: none; text-align: center; padding: 3rem 1rem; color: var(--reso-gray-500); font-size: 0.875rem; }
    .dd-search-empty.visible { display: block; }
    html.dark .dd-search-empty { color: #a0aec0; }
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
    html.dark .dd-result-version { background: #2d3748; color: #a0aec0; }`;
}

function getLandingJS() {
  return `    document.addEventListener('DOMContentLoaded', function() {
      // Pagefind search
      var activeFilter = '';
      var pfUI = null;
      var searchEl = document.getElementById('search');
      var modalEl = document.getElementById('searchModal');
      var countEl = null;
      var filtersEl = null;
      var ddCustomInput = null;
      var observer = null;

      function initPagefind() {
        pfUI = new PagefindUI({
          element: '#search', showSubResults: false, showImages: false, resetStyles: false,
          processResult: function(result) {
            var parts = [];
            if (result.meta && result.meta.description) parts.push(result.meta.description);
            if (result.meta && result.meta.date) parts.push(result.meta.date);
            var line1 = parts.join(' &middot; ');
            var def = (result.meta && result.meta.definition) ? result.meta.definition : '';
            result.excerpt = (line1 && def) ? line1 + '<br>' + def : (line1 || def || result.excerpt);
            return result;
          }
        });

        var form = searchEl.querySelector('.pagefind-ui__form');
        if (form) {
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
            filtersEl.addEventListener('click', function(e) {
              var btn = e.target.closest('.dd-search-filter-pill');
              if (!btn) return;
              filtersEl.querySelectorAll('.dd-search-filter-pill').forEach(function(b) { b.classList.remove('active'); });
              btn.classList.add('active');
              activeFilter = btn.dataset.version;
              applyFilter(activeFilter);
              var welcomeText = document.getElementById('ddSearchWelcomeText');
              if (welcomeText) {
                welcomeText.textContent = activeFilter
                  ? 'Search across Data Dictionary ' + activeFilter + ' resources, fields and lookup values.'
                  : 'Search across all Data Dictionary resources, fields and lookup values.';
              }
            });
          }
        }

        // Custom input overlay: user types here, we normalize and proxy to Pagefind
        var pfInput = searchEl.querySelector('.pagefind-ui__search-input');
        if (pfInput) {
          pfInput.style.position = 'absolute';
          pfInput.style.opacity = '0';
          pfInput.style.pointerEvents = 'none';
          var customInput = document.createElement('input');
          customInput.type = 'text';
          customInput.placeholder = 'Search...';
          customInput.className = 'dd-search-input';
          pfInput.parentNode.insertBefore(customInput, pfInput);
          ddCustomInput = customInput;

          function clearSearch() {
            customInput.value = '';
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var emptyEl = document.getElementById('ddSearchEmpty');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.add('visible');
            if (emptyEl) emptyEl.classList.remove('visible');
            if (drawerEl) drawerEl.style.display = 'none';
            if (countEl) countEl.textContent = '';
            pfUI.triggerSearch('');
          }

          var normDebounce = null;
          customInput.addEventListener('input', function() {
            var raw = customInput.value;
            var hasQuery = raw.trim().length > 0;
            if (!hasQuery) { clearSearch(); return; }
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var emptyEl = document.getElementById('ddSearchEmpty');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.remove('visible');
            if (emptyEl) emptyEl.classList.remove('visible');
            if (drawerEl) drawerEl.style.display = '';
            clearTimeout(normDebounce);
            normDebounce = setTimeout(function() {
              var normalized = customInput.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
              if (normalized) pfUI.triggerSearch(normalized);
            }, 150);
          });

          // Sync Pagefind's Clear button with our custom input
          var clearBtn = searchEl.querySelector('.pagefind-ui__search-clear');
          if (clearBtn) {
            clearBtn.addEventListener('click', function() { clearSearch(); customInput.focus(); });
          }
        }

        var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
        if (drawerEl) {
          drawerEl.addEventListener('scroll', function() {
            if (drawerEl.scrollTop + drawerEl.clientHeight >= drawerEl.scrollHeight - 300) {
              var btn = searchEl.querySelector('.pagefind-ui__button');
              if (btn) btn.click();
            }
          });
        }

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
            // Re-sort: exact title matches go first
            var query = ddCustomInput ? ddCustomInput.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
            if (query) {
              var resultsList = searchEl.querySelector('.pagefind-ui__results');
              if (resultsList) {
                var items = Array.from(resultsList.querySelectorAll('.pagefind-ui__result'));
                var needsSort = items.some(function(item) {
                  var link = item.querySelector('.pagefind-ui__result-link');
                  if (!link) return false;
                  var title = (link.textContent || '').replace(/DD\\s*\\d+\\.\\d+$/, '').trim();
                  return title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === query;
                });
                if (needsSort) {
                  observer.disconnect();
                  items.forEach(function(item) {
                    var link = item.querySelector('.pagefind-ui__result-link');
                    if (!link) return;
                    var title = (link.textContent || '').replace(/DD\\s*\\d+\\.\\d+$/, '').trim();
                    var normTitle = title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    if (normTitle === query) {
                      resultsList.insertBefore(item, resultsList.firstChild);
                    }
                  });
                  observer.observe(searchEl, { childList: true, subtree: true });
                }
              }
            }
            var hasQuery = ddCustomInput && ddCustomInput.value.trim().length > 0;
            var msg = searchEl.querySelector('.pagefind-ui__message');
            var emptyEl = document.getElementById('ddSearchEmpty');
            if (msg && countEl) {
              if (!hasQuery) {
                countEl.textContent = '';
                if (emptyEl) emptyEl.classList.remove('visible');
              } else {
                var txt = msg.textContent || '';
                var cm = txt.match(/(\\d+)\\s+result/);
                var count = cm ? parseInt(cm[1], 10) : -1;
                var newCount = count > 0 ? count + ' results' : '';
                if (countEl.textContent !== newCount) countEl.textContent = newCount;
                if (emptyEl) emptyEl.classList.toggle('visible', count === 0);
              }
            }
            var dEl = searchEl.querySelector('.pagefind-ui__drawer');
            var loadBtn = searchEl.querySelector('.pagefind-ui__button');
            if (dEl && loadBtn && dEl.scrollHeight <= dEl.clientHeight) {
              setTimeout(function() { loadBtn.click(); }, 50);
            }
            processing = false;
          });
        });
        observer.observe(searchEl, { childList: true, subtree: true });

        if (activeFilter) {
          pfUI.triggerFilters({ 'dd-version': [activeFilter] });
        }
      }

      function applyFilter(version) {
        if (!pfUI) return;
        if (version) {
          pfUI.triggerFilters({ 'dd-version': [version] });
        } else {
          pfUI.triggerFilters({});
        }
        var raw = ddCustomInput ? ddCustomInput.value : '';
        if (raw) {
          pfUI.triggerSearch(raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase());
        }
      }

      var s = document.createElement('script');
      s.src = '/pagefind/pagefind-ui.js';
      s.onload = function() { if (typeof PagefindUI !== 'undefined') initPagefind(); };
      document.head.appendChild(s);

      // Header hamburger
      document.getElementById('menuToggle').addEventListener('click', function() {
        document.getElementById('headerNav').classList.toggle('open');
      });

      // Search modal
      var overlay = document.getElementById('searchOverlay');
      function openSearch() {
        overlay.classList.add('active');
        document.body.classList.add('search-open');
        setTimeout(function() {
          if (ddCustomInput) {
            ddCustomInput.focus();
            var hasQuery = ddCustomInput.value.trim().length > 0;
            var welcomeEl = document.getElementById('ddSearchWelcome');
            var drawerEl = searchEl.querySelector('.pagefind-ui__drawer');
            if (welcomeEl) welcomeEl.classList.toggle('visible', !hasQuery);
            if (drawerEl) drawerEl.style.display = hasQuery ? '' : 'none';
            if (!hasQuery && countEl) countEl.textContent = '';
          }
        }, 100);
      }
      function closeSearch() {
        overlay.classList.remove('active');
        document.body.classList.remove('search-open');
      }
      document.getElementById('searchTrigger').addEventListener('click', openSearch);
      document.getElementById('heroSearch').addEventListener('click', openSearch);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeSearch(); });
      document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          openSearch();
        }
        if (e.key === 'Escape') closeSearch();
      });

      // Theme toggle
      document.getElementById('themeToggle').addEventListener('click', function() {
        var isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('dd-theme', isDark ? 'dark' : 'light');
      });
    });`;
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
  <link rel="stylesheet" href="/dd/assets/dd.css">
  <link href="/pagefind/pagefind-ui.css" rel="stylesheet">
  <script>(function(){var t=localStorage.getItem('dd-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');})()</script>
</head>
<body data-version="${version}">
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
      <div class="dd-page-generated"><a href="/dd/DD${version}/about/terms/" target="_blank">Terms and Definitions</a><span>Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
    </div>
  </div>

  <!-- Search modal -->
  <div class="search-modal-overlay" id="searchOverlay">
    <div class="search-modal" id="searchModal">
      <div id="search"></div>
      <div class="dd-search-welcome visible" id="ddSearchWelcome">
        <div class="dd-search-welcome-icon">\u{1F50D}</div>
        <p id="ddSearchWelcomeText">Search across all Data Dictionary resources, fields and lookup values.</p>
        <p class="dd-search-hint">Press <kbd>Esc</kbd> to close</p>
      </div>
      <div class="dd-search-empty" id="ddSearchEmpty">No results found. Try a different search term or filter.</div>
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

  <script src="/dd/assets/dd.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sidebar HTML Generator
// ---------------------------------------------------------------------------

function generateSidebarHtml(vCfg, data, activeResource, activePage) {
  const { version } = vCfg;
  const allResources = Object.keys(data.resourceMap).sort();
  // Property first, then the rest alphabetically
  const resources = allResources.includes('Property')
    ? ['Property', ...allResources.filter(r => r !== 'Property')]
    : allResources;

  // About section (expanded if an about page is active)
  const aboutPages = getAboutPages(version);
  const aboutExpanded = activePage != null;
  let html = `<div class="dd-sidebar-section${aboutExpanded ? ' expanded' : ''}" data-section="about">\n`;
  html += '<div class="dd-sidebar-section-title">About <span class="dd-section-arrow">&#9660;</span></div>\n';
  html += '<ul class="dd-nav-resources">\n';
  for (const page of aboutPages) {
    const isActive = activePage === page.slug;
    html += `<li class="dd-nav-resource"><a href="/dd/DD${version}/about/${page.slug ? page.slug + '/' : ''}" class="dd-nav-resource-link${isActive ? ' active' : ''}">${escapeHtml(page.title)}</a></li>\n`;
  }
  html += '</ul>\n</div>\n';

  // Resources section (expanded by default unless an about page is active)
  html += `<div class="dd-sidebar-section${!aboutExpanded ? ' expanded' : ''}" data-section="resources">\n`;
  html += '<div class="dd-sidebar-section-title">Resources <span class="dd-section-arrow">&#9660;</span></div>\n';
  html += '<ul class="dd-nav-resources">\n';
  for (const rn of resources) {
    const fields = data.resourceMap[rn];
    const tree = buildGroupTree(fields);
    const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();
    const isActive = rn === activeResource;

    html += `<li class="dd-nav-resource${isActive ? ' expanded' : ''}">\n`;
    html += `  <a href="${ddUrl(version, rn)}" class="dd-nav-resource-link${isActive ? ' active' : ''}">${escapeHtml(rn)}</a>\n`;

    if (childGroups.length > 0) {
      html += `  <ul class="dd-nav-groups">\n`;
      html += renderSidebarGroups(version, rn, tree, [], isActive);
      html += `  </ul>\n`;
    }
    html += `</li>\n`;
  }
  html += '</ul>\n</div>\n';
  return html;
}

function renderSidebarGroups(version, resourceName, tree, path, anchorOnly) {
  const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();
  let html = '';

  for (const group of childGroups) {
    const groupPath = [...path, group];
    const groupId = 'group-' + groupPath.join('-');
    const subGroups = Object.keys(tree[group]).filter(k => !k.startsWith('_'));
    const href = anchorOnly ? `#${groupId}` : `${ddUrl(version, resourceName)}#${groupId}`;

    html += `    <li class="dd-nav-group${subGroups.length > 0 ? ' has-children' : ''}">\n`;
    html += `      <a href="${href}" class="dd-nav-group-link">${escapeHtml(group)}</a>\n`;
    if (subGroups.length > 0) {
      html += `      <ul class="dd-nav-subgroups">\n`;
      html += renderSidebarGroups(version, resourceName, tree[group], groupPath, anchorOnly);
      html += `      </ul>\n`;
    }
    html += `    </li>\n`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// About Pages Configuration
// ---------------------------------------------------------------------------

function getAboutPages(version) {
  const pages = [
    { slug: '', title: 'Introduction' },
    { slug: 'changelog', title: 'Change Log' },
    { slug: 'certification', title: 'Certification' },
    { slug: 'terms', title: 'Terms and Definitions' },
    { slug: 'deprecated', title: 'Deprecated Fields' },
    { slug: 'resources', title: 'Resource Summary' },
    { slug: 'search-tips', title: 'Search Tips' },
  ];
  if (version === '2.0' || version === '2.1') {
    pages.splice(1, 0, { slug: 'release-guide', title: 'Release Guide' });
  }
  return pages;
}

function generateAboutPages(vCfg, data, allVersions) {
  const { version, label, approved } = vCfg;
  const is20 = version === '2.0' || version === '2.1';
  const aboutDir = join(OUTPUT_DIR, `DD${version}`, 'about');
  mkdirSync(aboutDir, { recursive: true });

  const pages = getAboutPages(version);
  let pageCount = 0;

  for (const page of pages) {
    const contentHtml = generateAboutContent(page.slug, vCfg, data, is20);
    const bc = page.slug
      ? breadcrumbHtml(version, label, [
          { label: 'About', url: `/dd/DD${version}/about/` },
          { label: page.title },
        ])
      : breadcrumbHtml(version, label, [{ label: 'About' }]);

    let html = bc;
    html += `<div class="dd-page-header"><h1>${escapeHtml(page.title)}</h1>`;
    html += `<p class="dd-page-subtitle">${escapeHtml(label)} Documentation</p></div>`;
    html += contentHtml;

    const sidebarHtml = generateSidebarHtml(vCfg, data, null, page.slug);
    const dir = page.slug ? join(aboutDir, page.slug) : aboutDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), wrapPage(
      `${page.title} - ${label}`, version, sidebarHtml, html, allVersions
    ));
    pageCount++;
  }
  return pageCount;
}

function generateAboutContent(slug, vCfg, data, is20) {
  switch (slug) {
    case '': return aboutIntroduction(vCfg);
    case 'changelog': return aboutChangelog(vCfg, is20);
    case 'certification': return aboutCertification();
    case 'terms': return aboutTerms();
    case 'deprecated': return aboutDeprecated(vCfg);
    case 'resources': return aboutResources(vCfg, data);
    case 'search-tips': return aboutSearchTips();
    case 'release-guide': return aboutReleaseGuide();
    default: return '<p>Page not found.</p>';
  }
}

function aboutIntroduction(vCfg) {
  const { version, label, approved } = vCfg;
  let html = '<div class="dd-about-section">';
  html += '<h2>Purpose</h2>';
  html += `<p>The RESO Data Dictionary is a common reference for fields and lookups (enumerations) found in RESO-certified data sources. It provides universal guidelines for MLS listing input modules. Standardized terminology prevents implementation errors, eases field mapping and fosters innovation across the real estate industry.</p>`;
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Structure</h2>';
  html += `<p>The Data Dictionary is organized in a hierarchy:</p>`;
  html += '<div class="dd-about-cards">';
  html += '<div class="dd-about-card"><h3>Resources</h3><p>Top-level categories such as Property, Member, Office and Media</p></div>';
  html += '<div class="dd-about-card"><h3>Groups</h3><p>Logical groupings of related fields within a resource</p></div>';
  html += '<div class="dd-about-card"><h3>Fields</h3><p>Individual data elements with names, types and definitions</p></div>';
  html += '<div class="dd-about-card"><h3>Lookups</h3><p>Enumerations of valid values for fields that accept a controlled list</p></div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Contributing</h2>';
  html += `<p>Proposed additions to the Data Dictionary require the following:</p>`;
  html += '<ul>';
  html += '<li>Name following RESO naming conventions</li>';
  html += '<li>Definition describing the element</li>';
  html += '<li>Data type and maximum length</li>';
  html += '<li>Lookups, if applicable</li>';
  html += '<li>Justification and utilization metrics</li>';
  html += '<li>Review for duplication with existing elements</li>';
  html += '</ul>';
  html += '<p>Contact <a href="mailto:info@reso.org">info@reso.org</a> for more information about the contribution process.</p>';
  html += '</div>';

  if (vCfg.approved) {
    html += `<div class="dd-callout"><strong>${escapeHtml(vCfg.label)}</strong> was approved on ${escapeHtml(vCfg.approved)}.</div>`;
  }

  return html;
}

function aboutChangelog(vCfg, is20) {
  let html = '<div class="dd-about-section">';

  if (is20) {
    html += '<h2>DD 2.0 Changes (2021\u20132024)</h2>';
    html += '<ul>';
    html += '<li>Added <strong>ArchitecturalStyle</strong> field</li>';
    html += '<li>Added showing resources: <strong>ShowingAvailability</strong>, <strong>ShowingAppointment</strong> and <strong>ShowingRequest</strong></li>';
    html += '<li>Added <strong>French Canadian</strong> display names</li>';
    html += '<li>Added <strong>PropertyTimeZone</strong> field</li>';
    html += '<li>Deprecated repeating element <em>[type]</em> fields</li>';
    html += '<li>Deprecated <strong>KeyNumeric</strong> fields</li>';
    html += '<li>Stricter standard enforcement and certification tooling</li>';
    html += '</ul>';
    html += '</div>';
  }

  html += '<div class="dd-about-section">';
  html += '<h2>DD 1.7 Changes (2017\u20132021)</h2>';
  html += '<ul>';
  html += '<li>Added new resources: <strong>Queue</strong>, <strong>Rules</strong>, <strong>SocialMedia</strong> and <strong>OtherPhone</strong></li>';
  html += '<li>Added approximately 750 new lookup values</li>';
  html += '<li>Added <strong>Spanish Standard Names</strong></li>';
  html += '<li>Renamed <strong>PropertyID</strong> to <strong>UniversalPropertyId</strong></li>';
  html += '<li>Board approved <strong>December 2018</strong></li>';
  html += '</ul>';
  html += '</div>';

  return html;
}

function aboutCertification() {
  let html = '<div class="dd-about-section">';
  html += '<h2>Certification Model</h2>';
  html += `<p>RESO replaced the previous metallic-tier certification system with a <strong>Core + Endorsements</strong> model. Core certification aligns with the RESO Web API specification and ensures baseline compliance.</p>`;
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Endorsements</h2>';
  html += '<div class="dd-about-cards">';
  html += '<div class="dd-about-card"><h3>IDX Payload</h3><p>Fields required for Internet Data Exchange</p></div>';
  html += '<div class="dd-about-card"><h3>BBO Payload</h3><p>Fields required for Broker Back Office operations</p></div>';
  html += '<div class="dd-about-card"><h3>JSON DD</h3><p>Data Dictionary metadata served via JSON</p></div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Process</h2>';
  html += '<ul>';
  html += '<li>Certifications expire after two Data Dictionary versions</li>';
  html += '<li>Testing is conducted using RESO certification tools</li>';
  html += '<li>Contact <a href="mailto:dev@reso.org">dev@reso.org</a> for certification inquiries</li>';
  html += '</ul>';
  html += '</div>';

  return html;
}

function aboutTerms() {
  let html = '<div class="dd-about-section">';
  html += '<p>Key terminology used throughout the Data Dictionary.</p>';
  html += '<dl class="dd-def-grid">';

  const terms = [
    { term: 'Standard Name', def: 'The canonical machine-readable name for a field or lookup value.' },
    { term: 'Definition', def: 'A human-readable description of what an element represents.' },
    { term: 'Added in Version', def: 'The Data Dictionary version in which the element was first introduced.' },
    { term: 'BEDES', def: 'Building Energy Data Exchange Specification \u2014 a related standard referenced by some DD elements.' },
    { term: 'Collection', def: 'A set of related records accessible via the Web API (typically maps to a resource).' },
    { term: 'Groups', def: 'Logical groupings of fields within a resource (e.g., Listing, Location, Tax).' },
    { term: 'Synonym', def: 'An alternative display name for a standard field or lookup value.' },
    { term: 'Lookup Name', def: 'The identifier for a lookup (enumeration) that a field references.' },
  ];

  for (const t of terms) {
    html += '<div class="dd-def-item"><dl>';
    html += `<dt>${escapeHtml(t.term)}</dt>`;
    html += `<dd>${escapeHtml(t.def)}</dd>`;
    html += '</dl></div>';
  }
  html += '</dl>';
  html += '</div>';

  // Element Status
  html += '<div class="dd-about-section">';
  html += '<h2>Element Status</h2>';
  html += '<dl class="dd-def-grid">';
  const statuses = [
    { term: 'Active', def: 'The element is part of the current Data Dictionary and may be used in certification.' },
    { term: 'Deprecated', def: 'The element is scheduled for removal. It is still recognized but should not be used in new implementations.' },
    { term: 'Deleted', def: 'The element has been removed from the Data Dictionary.' },
    { term: 'Proposed', def: 'The element is under consideration and has not yet been approved.' },
  ];
  for (const s of statuses) {
    html += '<div class="dd-def-item"><dl>';
    html += `<dt>${escapeHtml(s.term)}</dt>`;
    html += `<dd>${escapeHtml(s.def)}</dd>`;
    html += '</dl></div>';
  }
  html += '</dl>';
  html += '</div>';

  // Lookup Status
  html += '<div class="dd-about-section">';
  html += '<h2>Lookup Status</h2>';
  html += '<dl class="dd-def-grid">';
  const lookupStatuses = [
    { term: 'Open', def: 'Any value is allowed. No standard enumeration is defined.' },
    { term: 'Open with Enumerations', def: 'Standard lookup values are defined but providers may also include additional local values.' },
    { term: 'Locked', def: 'Only the standard lookup values are allowed.' },
  ];
  for (const ls of lookupStatuses) {
    html += '<div class="dd-def-item"><dl>';
    html += `<dt>${escapeHtml(ls.term)}</dt>`;
    html += `<dd>${escapeHtml(ls.def)}</dd>`;
    html += '</dl></div>';
  }
  html += '</dl>';
  html += '</div>';

  // Property Types
  html += '<div class="dd-about-section">';
  html += '<h2>Property Types</h2>';
  html += '<dl class="dd-def-grid">';
  const propTypes = [
    { code: 'RESI', name: 'Residential' },
    { code: 'RLSE', name: 'Residential Lease' },
    { code: 'RINC', name: 'Residential Income' },
    { code: 'LAND', name: 'Land' },
    { code: 'MOBI', name: 'Mobile Home' },
    { code: 'FARM', name: 'Farm' },
    { code: 'COMS', name: 'Commercial Sale' },
    { code: 'COML', name: 'Commercial Lease' },
    { code: 'BUSO', name: 'Business Opportunity' },
  ];
  for (const pt of propTypes) {
    html += '<div class="dd-def-item"><dl>';
    html += `<dt>${escapeHtml(pt.code)}</dt>`;
    html += `<dd>${escapeHtml(pt.name)}</dd>`;
    html += '</dl></div>';
  }
  html += '</dl>';
  html += '</div>';

  // Simple Data Types
  html += '<div class="dd-about-section">';
  html += '<h2>Simple Data Types</h2>';
  html += '<div class="dd-about-section">';
  const dataTypes = [
    { type: 'Boolean', def: 'True or false value.' },
    { type: 'Collection', def: 'A multi-valued field referencing a set of lookup values.' },
    { type: 'Date', def: 'A calendar date without time.' },
    { type: 'Number', def: 'A numeric value (integer or decimal).' },
    { type: 'String', def: 'A sequence of characters with a defined maximum length.' },
    { type: 'String List, Single', def: 'A single value selected from a lookup.' },
    { type: 'String List, Multi', def: 'Multiple values selected from a lookup, represented as a collection.' },
    { type: 'Timestamp', def: 'A date and time value, typically in ISO 8601 format.' },
  ];
  html += '<dl class="dd-def-grid">';
  for (const dt of dataTypes) {
    html += '<div class="dd-def-item"><dl>';
    html += `<dt>${escapeHtml(dt.type)}</dt>`;
    html += `<dd>${escapeHtml(dt.def)}</dd>`;
    html += '</dl></div>';
  }
  html += '</dl>';
  html += '</div></div>';

  return html;
}

function aboutDeprecated(vCfg) {
  let html = '';

  html += '<div class="dd-about-section">';
  html += '<h2>Deprecated in DD 2.0</h2>';
  html += '<p>The following categories of fields were deprecated in DD 2.0:</p>';
  html += '<h3>Repeating Element Fields</h3>';
  html += '<p>Fields that followed the pattern <code>[Type]1</code>, <code>[Type]2</code>, <code>[Type]3</code> (e.g., <code>Appliances1</code>) were deprecated in favor of collection-typed fields.</p>';
  html += '<h3>KeyNumeric Fields</h3>';
  html += '<p>Fields ending in <code>KeyNumeric</code> were deprecated. Use the standard key fields instead.</p>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Deprecated in DD 1.7</h2>';
  html += '<p>No fields were deprecated in DD 1.7.</p>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Deprecated in DD 1.6</h2>';
  html += '<p>The following fields were removed in DD 1.6:</p>';
  html += '<table class="dd-about-table"><thead><tr><th>Field</th></tr></thead><tbody>';
  const deprecated16 = ['ApprovalStatus', 'Gas', 'Gender', 'Group', 'Groups', 'TaxExemptions', 'Telephone'];
  for (const f of deprecated16) {
    html += `<tr><td>${escapeHtml(f)}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '</div>';

  return html;
}

function aboutResources(vCfg, data) {
  const { version, label } = vCfg;
  const allResources = Object.keys(data.resourceMap).sort();
  // Property first
  const resources = allResources.includes('Property')
    ? ['Property', ...allResources.filter(r => r !== 'Property')]
    : allResources;

  let html = '<div class="dd-about-section">';
  html += '<h2>Resource Summary</h2>';
  html += `<p>${escapeHtml(label)} contains ${formatNumber(resources.length)} resources and ${formatNumber(data.fields.length)} total fields.</p>`;
  html += '<table class="dd-about-table"><thead><tr><th>Resource</th><th>Description</th><th>Fields</th></tr></thead><tbody>';
  for (const rn of resources) {
    const fieldCount = data.resourceMap[rn].length;
    const desc = RESOURCE_DESCRIPTIONS[rn] || '';
    html += `<tr>`;
    html += `<td><a href="${ddUrl(version, rn)}">${escapeHtml(rn)}</a></td>`;
    html += `<td>${escapeHtml(desc)}</td>`;
    html += `<td>${formatNumber(fieldCount)}</td>`;
    html += `</tr>`;
  }
  html += '</tbody></table>';
  html += '</div>';

  return html;
}

function aboutSearchTips() {
  let html = '<div class="dd-about-section">';
  html += '<h2>Using Site Search</h2>';
  html += '<p>Press <kbd>/</kbd> or click the search button in the header to open the search modal. Search works across all Data Dictionary resources, fields and lookup values.</p>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>How Search Works</h2>';
  html += '<p>Search input is normalized to match Data Dictionary naming conventions. Punctuation and special characters are stripped so that terms like <code>ListPrice</code>, <code>list price</code> and <code>list-price</code> all produce the same results.</p>';
  html += '<p>When you enter multiple words, all terms must be present in a page for it to appear in results (implicit AND). Results are ranked by relevance, with page titles weighted highest.</p>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Version Filtering</h2>';
  html += '<p>When search results appear, use the version filter pills at the top to narrow results to a specific Data Dictionary version.</p>';
  html += '</div>';

  return html;
}

function aboutReleaseGuide() {
  let html = '<div class="dd-about-section">';
  html += '<h2>DD 2.0 Release Overview</h2>';
  html += '<p>DD 2.0 is a major release with stricter enforcement of standard field names, types and lookups. It introduces an updated certification framework and a formal process for handling field name variations.</p>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Certification Testing Stages</h2>';
  html += '<p>DD 2.0 certification involves four testing stages:</p>';
  html += '<div class="dd-about-cards">';
  html += '<div class="dd-about-card"><h3>1. Metadata Validation</h3><p>Verify server metadata matches expected schema structure</p></div>';
  html += '<div class="dd-about-card"><h3>2. Variations Report</h3><p>Map local field names to standard names using variation strategies</p></div>';
  html += '<div class="dd-about-card"><h3>3. Sampling &amp; Data Availability</h3><p>Check that advertised fields contain actual data</p></div>';
  html += '<div class="dd-about-card"><h3>4. Schema Validation</h3><p>Confirm field types, lengths and lookups match the standard</p></div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Variation Matching</h2>';
  html += '<p>Five strategies are used to match local field names to Data Dictionary standard names:</p>';
  html += '<ol>';
  html += '<li>Exact match on standard name</li>';
  html += '<li>Case-insensitive match</li>';
  html += '<li>Match on display name or synonym</li>';
  html += '<li>Fuzzy match using edit distance</li>';
  html += '<li>Manual mapping via configuration</li>';
  html += '</ol>';
  html += '</div>';

  html += '<div class="dd-about-section">';
  html += '<h2>Resources</h2>';
  html += '<p>Certification tools are available on <a href="https://github.com/RESOStandards">GitHub</a>. For questions about DD 2.0 certification, contact <a href="mailto:dev@reso.org">dev@reso.org</a>.</p>';
  html += '</div>';

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
    <button class="dd-sort-pill active" data-sort="name">Name <span class="dd-sort-arrow">&#9650;</span></button>
    <button class="dd-sort-pill" data-sort="fields">Field Count <span class="dd-sort-arrow">&#9650;</span></button>
  </div>`;

  html += `<div class="dd-resource-grid" id="ddResourceGrid">`;
  for (const rn of resources) {
    const fieldCount = resourceMap[rn].length;
    const desc = RESOURCE_DESCRIPTIONS[rn];
    html += `<a href="${ddUrl(version, rn)}" class="dd-resource-card" data-name="${escapeHtml(rn)}" data-fields="${fieldCount}">`;
    html += `<h3>${escapeHtml(rn)}</h3>`;
    if (desc) html += `<p class="dd-resource-desc">${escapeHtml(desc)}</p>`;
    html += `<span class="dd-resource-count">${formatNumber(fieldCount)} field${fieldCount !== 1 ? 's' : ''}</span>`;
    html += `</a>`;
  }
  html += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, null);
  const dir = join(OUTPUT_DIR, `DD${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(label, version, sidebarHtml, html, allVersions));
}

function generateResourcePage(vCfg, data, resourceName, usageStats, allVersions, totalProviders) {
  const { version, label } = vCfg;
  const fields = data.resourceMap[resourceName];
  const groupTree = buildGroupTree(fields);
  const resourceStats = usageStats?.[resourceName];

  let html = '<div class="dd-resource-sticky">';
  html += breadcrumbHtml(version, label, [{ label: resourceName }]);
  const resNorm = resourceName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const resDesc = RESOURCE_DESCRIPTIONS[resourceName];
  html += `<div class="dd-page-header"><h1 data-pagefind-meta="title" data-pagefind-weight="10">${escapeHtml(resourceName)} Resource <button class="dd-copy-btn" data-copy="${escapeHtml(resourceName)}" title="Copy name"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></h1>`;
  html += `<span class="dd-search-norm" data-pagefind-weight="100">${resNorm}</span>`;
  const latestRevised = fields.reduce((latest, f) => {
    if (f.RevisedDate && (!latest || f.RevisedDate > latest)) return f.RevisedDate;
    return latest;
  }, null);
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">${formatNumber(fields.length)} fields`;
  if (latestRevised) html += ` &middot; Last revised ${escapeHtml(latestRevised)}`;
  html += `</p>`;
  if (latestRevised) html += `<span class="dd-search-norm" data-pagefind-meta="date">${escapeHtml(latestRevised)}</span>`;
  html += `</div>`;
  if (resDesc) html += `<div class="dd-definition-callout">${escapeHtml(resDesc)}</div>`;

  const hasGroups = Object.keys(groupTree).some(k => !k.startsWith('_'));
  html += `<div class="dd-sort-controls">
    <label>Sort by</label>
    <button class="dd-sort-pill active" data-sort="name">Name <span class="dd-sort-arrow">&#9650;</span></button>
    <button class="dd-sort-pill" data-sort="type">Type <span class="dd-sort-arrow">&#9650;</span></button>
    <button class="dd-sort-pill" data-sort="usage">Usage <span class="dd-sort-arrow">&#9650;</span></button>
    <button class="dd-sort-pill" data-sort="added">Date Added <span class="dd-sort-arrow">&#9650;</span></button>
    <button class="dd-sort-pill" data-sort="revised">Revised <span class="dd-sort-arrow">&#9650;</span></button>
    ${hasGroups ? '<button class="dd-group-toggle active" id="ddGroupToggle">Show Groups</button>' : ''}
  </div>`;
  html += '</div>';

  html += renderGroupedFields(version, resourceName, fields, groupTree, resourceStats, totalProviders);

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${resourceName} - ${label}`, version, sidebarHtml, html, allVersions
  ));
}

function renderGroupedFields(version, resourceName, fields, tree, resourceStats, totalProviders) {
  const sections = [];
  collectSections(tree, [], sections);

  const hasGroupedSections = sections.some(s => s.path.length > 0);

  const wrapperClasses = 'dd-fields-table-wrapper' + (hasGroupedSections ? ' dd-grouped' : '');
  let html = `<div class="${wrapperClasses}" data-pagefind-ignore>`;
  if (hasGroupedSections) {
    html += `<div class="dd-sticky-col-headers"><span>Field</span><span>Definition</span><span>Type</span><span>Usage</span></div>`;
    html += `<div class="dd-mobile-group-indicator" id="ddMobileGroupLabel"></div>`;
  }
  for (const section of sections) {
    const groupId = 'group-' + section.path.join('-');

    if (section.path.length > 0) {
      const depth = section.path.length;
      const headingContent = section.path.map((part, i) => {
        if (i < section.path.length - 1) {
          return `<span class="dd-group-parent">${escapeHtml(part)}</span>`;
        }
        return escapeHtml(part);
      }).join(' <span class="dd-group-sep">&rsaquo;</span> ');
      html += `<h2 class="dd-group-heading dd-group-depth-${depth}" id="${escapeHtml(groupId)}">${headingContent}</h2>`;
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
      const usageVal = stats?.recipients != null && totalProviders ? stats.recipients / totalProviders : -1;

      html += `<tr data-name="${escapeHtml(field.StandardName)}" data-type="${escapeHtml(field.SimpleDataType || '')}" data-usage="${usageVal}" data-added="${escapeHtml(field.AddedInVersion || '')}" data-revised="${escapeHtml(field.RevisedDate || '')}" data-group="${escapeHtml(section.path.join(' > '))}">`;
      html += `<td><a href="${fieldUrl}" class="dd-field-link">${escapeHtml(field.DisplayName || field.StandardName)}</a>`;
      html += `<div class="dd-field-standard-name">${escapeHtml(field.StandardName)}</div></td>`;
      html += `<td class="dd-field-def">${escapeHtml(truncate(field.Definition, DEFINITION_TRUNCATE_LENGTH))}`;
      if (field.Definition && field.Definition.length > DEFINITION_TRUNCATE_LENGTH) {
        html += ` <a href="${fieldUrl}" class="dd-more-link">more</a>`;
      }
      html += `</td>`;
      html += `<td><span class="dd-type-badge">${escapeHtml(field.SimpleDataType)}</span></td>`;
      html += `<td>${usageBadge(stats, totalProviders)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  html += '</div>';
  return html;
}

function collectSections(tree, path, sections) {
  const childGroups = Object.keys(tree).filter(k => !k.startsWith('_')).sort();
  const fieldNames = tree._fields || [];
  const ungrouped = tree._ungrouped || [];

  // Add this node's own fields first, then recurse into children
  if (fieldNames.length > 0) {
    sections.push({ path, fields: fieldNames.sort() });
  }

  for (const group of childGroups) {
    collectSections(tree[group], [...path, group], sections);
  }

  if (ungrouped.length > 0 && path.length === 0) {
    sections.push({ path: [], fields: ungrouped.sort() });
  }
}

function generateFieldPage(vCfg, data, resourceName, field, usageStats, allVersions, totalProviders) {
  const { version, label } = vCfg;
  const resourceStats = usageStats?.[resourceName];
  const fieldStats = resourceStats?.[field.StandardName];

  let html = breadcrumbHtml(version, label, [
    { label: resourceName, url: ddUrl(version, resourceName) },
    { label: field.DisplayName || field.StandardName },
  ]);

  const fieldNorm = field.StandardName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  html += `<div class="dd-page-header"><h1 data-pagefind-meta="title" data-pagefind-weight="10">${escapeHtml(field.StandardName)} Field <button class="dd-copy-btn" data-copy="${escapeHtml(field.StandardName)}" title="Copy name"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></h1>`;
  html += `<span class="dd-search-norm" data-pagefind-weight="100">${fieldNorm}</span>`;
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">${escapeHtml(resourceName)} Resource</p>`;
  if (field.Definition) html += `<span class="dd-search-norm" data-pagefind-meta="definition">${escapeHtml(truncate(field.Definition, 200))}</span>`;
  if (field.RevisedDate) html += `<span class="dd-search-norm" data-pagefind-meta="date">${escapeHtml(field.RevisedDate)}</span>`;
  html += `</div>`;
  if (field.Definition) html += `<div class="dd-definition-callout">${escapeHtml(field.Definition)}</div>`;

  // Metadata — two-column grid, indexed so Pagefind can match on field name, definition, etc.
  const leftRows = [
    ['Standard Name', field.StandardName],
    ['Display Name', field.DisplayName],
    ['Group', field.Groups],
    ['Simple Data Type', field.SimpleDataType],
    ['Max Length<small>suggested</small>', field.SugMaxLength],
    ['Max Precision<small>suggested</small>', field.SugMaxPrecision],
    ['Synonyms', field.Synonyms],
    ['Status', field.ElementStatus, 'ElementStatus'],
    ['BEDES', field.BEDES],
  ];
  const rightRows = [
    ['Lookup Status', field.LookupStatus],
    ['Lookup', field.LookupName],
    ['Property Types', field.PropertyTypes, 'PropertyTypes'],
    ['Payloads', field.Payloads, 'Payloads'],
    ['Spanish Name', field.SpanishDisplayName],
    ['French-Canadian Name', field.FrenchCanadianDisplayName],
    ['Status Change Date', field.StatusChangeDate],
    ['Revised Date', field.RevisedDate],
    ['Added in Version', field.AddedInVersion, 'AddedInVersion'],
    ['Source Resource', field.SourceResource],
    ['Repeating Element', field.RepeatingElement],
  ];

  function renderMetaTable(rows) {
    let t = '<table class="dd-metadata-table">';
    for (const [lbl, value, xrefKey] of rows) {
      const display = value || '\u2014';
      const rendered = (value && xrefKey) ? xrefLinksForField(version, xrefKey, value) : escapeHtml(display);
      // Labels may contain <small> tags for subtitles
      const labelHtml = lbl.includes('<') ? lbl : escapeHtml(lbl);
      t += `<tr><th>${labelHtml}</th><td>${rendered}</td></tr>`;
    }
    t += '</table>';
    return t;
  }

  html += `<div class="dd-metadata-card"><h2>Details</h2>`;
  html += `<div class="dd-meta-grid">`;
  html += renderMetaTable(leftRows);
  html += renderMetaTable(rightRows);
  html += `</div></div>`;

  // Usage
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Usage</h2>${usageHtml(fieldStats, totalProviders)}</div>`;

  // Lookups panel
  if (field.LookupStatus?.includes('with Enumerations') && field.LookupName) {
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
      html += `<td>${usageBadge(lkStats, totalProviders)}</td>`;
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
  const weight = fieldStats?.recipients != null && totalProviders ? fieldStats.recipients / totalProviders : undefined;
  writeFileSync(join(dir, 'index.html'), wrapPage(
    `${field.DisplayName || field.StandardName} - ${resourceName}`, version, sidebarHtml, html, allVersions, { pagefindWeight: weight }
  ));
}

function generateLookupPage(vCfg, data, resourceName, field, lookup, usageStats, allVersions, totalProviders) {
  const { version, label } = vCfg;
  const resourceStats = usageStats?.[resourceName];
  const fieldStats = resourceStats?.[field.StandardName];
  const lookupStats = fieldStats?.lookups?.[lookup.StandardLookupValue];

  let html = breadcrumbHtml(version, label, [
    { label: resourceName, url: ddUrl(version, resourceName) },
    { label: field.DisplayName || field.StandardName, url: ddUrl(version, resourceName, field.StandardName) },
    { label: lookup.StandardLookupValue },
  ]);

  const lookupDisplay = lookup.StandardLookupValue.replace(/([a-z])([A-Z])/g, '$1 $2');
  const lookupNorm = lookup.StandardLookupValue.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  html += `<div class="dd-page-header"><h1 data-pagefind-meta="title" data-pagefind-weight="10">${escapeHtml(lookupDisplay)} Lookup <button class="dd-copy-btn" data-copy="${escapeHtml(lookup.StandardLookupValue)}" title="Copy value"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></h1>`;
  html += `<span class="dd-search-norm" data-pagefind-weight="100">${lookupNorm}</span>`;
  if (lookup.LegacyODataValue && lookup.LegacyODataValue !== lookup.StandardLookupValue) {
    html += `<p class="dd-page-legacy-value">Legacy OData Value: <code>${escapeHtml(lookup.LegacyODataValue)}</code></p>`;
  }
  html += `<p class="dd-page-subtitle" data-pagefind-meta="description">Lookup value for ${escapeHtml(field.DisplayName || field.StandardName)} (${escapeHtml(resourceName)})</p>`;
  if (lookup.Definition) html += `<span class="dd-search-norm" data-pagefind-meta="definition">${escapeHtml(truncate(lookup.Definition, 200))}</span>`;
  if (lookup.RevisedDate) html += `<span class="dd-search-norm" data-pagefind-meta="date">${escapeHtml(lookup.RevisedDate)}</span>`;
  html += `</div>`;
  if (lookup.Definition) html += `<div class="dd-definition-callout">${escapeHtml(lookup.Definition)}</div>`;

  // Metadata — two-column grid
  const lkLeftRows = [
    ['Lookup Name', lookup.LookupName],
    ['Standard Value', lookup.StandardLookupValue],
    ['Legacy OData Value', lookup.LegacyODataValue],
    ['Synonyms', lookup.Synonyms],
    ['Status', lookup.ElementStatus, 'ElementStatus'],
    ['BEDES', lookup.BEDES],
  ];
  const lkRightRows = [
    ['References', lookup.References, 'PropertyTypes'],
    ['Spanish Value', lookup.SpanishLookupValue],
    ['French-Canadian Value', lookup.FrenchCanadianLookupValue],
    ['Status Change Date', lookup.StatusChangeDate],
    ['Revised Date', lookup.RevisedDate],
    ['Added in Version', lookup.AddedInVersion, 'AddedInVersion'],
  ];

  function renderLkMetaTable(rows) {
    let t = '<table class="dd-metadata-table">';
    for (const [lbl, value, xrefKey] of rows) {
      const display = value || '\u2014';
      const rendered = (value && xrefKey) ? xrefLinksForField(version, xrefKey, value) : escapeHtml(display);
      t += `<tr><th>${escapeHtml(lbl)}</th><td>${rendered}</td></tr>`;
    }
    t += '</table>';
    return t;
  }

  html += `<div class="dd-metadata-card"><h2>Details</h2>`;
  html += `<div class="dd-meta-grid">`;
  html += renderLkMetaTable(lkLeftRows);
  html += renderLkMetaTable(lkRightRows);
  html += `</div></div>`;

  // Usage
  html += `<div class="dd-metadata-card" data-pagefind-ignore><h2>Usage</h2>`;
  html += `<h3>Standard Value</h3>${usageHtml(lookupStats, totalProviders)}`;
  html += `</div>`;

  const sidebarHtml = generateSidebarHtml(vCfg, data, resourceName);
  const dir = join(OUTPUT_DIR, `DD${version}`, resourceName, field.StandardName, lookup.StandardLookupValue);
  mkdirSync(dir, { recursive: true });
  const weight = lookupStats?.recipients != null && totalProviders ? lookupStats.recipients / totalProviders : undefined;
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
  <link rel="stylesheet" href="/dd/assets/dd-landing.css">
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
        <a href="/dd/" class="dd-landing-related-item">
          <div class="dd-landing-related-icon dd-landing-related-icon-navy">
            <svg viewBox="0 0 24 24"><path d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7c-2 0-3 1-3 3zm5 1h6m-6 3h6m-6 3h4"/></svg>
          </div>
          <div class="dd-landing-related-text">
            <h4>Data Dictionary Documentation</h4>
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
      <div class="dd-search-welcome visible" id="ddSearchWelcome">
        <div class="dd-search-welcome-icon">\u{1F50D}</div>
        <p id="ddSearchWelcomeText">Search across all Data Dictionary resources, fields and lookup values.</p>
        <p class="dd-search-hint">Press <kbd>Esc</kbd> to close</p>
      </div>
      <div class="dd-search-empty" id="ddSearchEmpty">No results found. Try a different search term or filter.</div>
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

  <script src="/dd/assets/dd-landing.js"></script>
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

  // Fetch usage stats once (version-agnostic, covers all resources/fields/lookups)
  let usageStats = null;
  const totalProvidersByResource = {};
  try {
    usageStats = await fetchUsageStats(allData);
  } catch (err) {
    console.warn('Error fetching usage stats:', err.message);
  }

  // Derive total organizations per resource: the field with the most
  // recipients is the best proxy for the total number of organizations
  if (usageStats) {
    for (const [resourceName, resource] of Object.entries(usageStats)) {
      let maxRecipients = 0;
      for (const [key, stats] of Object.entries(resource)) {
        if (key === 'lookups' || !stats?.recipients) continue;
        if (stats.recipients > maxRecipients) {
          maxRecipients = stats.recipients;
        }
      }
      if (maxRecipients > 0) totalProvidersByResource[resourceName] = maxRecipients;
    }
  }

  for (const { vCfg, data } of allData) {
    console.log(`\nGenerating ${vCfg.label}...`);

    generateVersionLanding(vCfg, data, VERSIONS);

    let pageCount = 1;
    for (const [resourceName, fields] of Object.entries(data.resourceMap)) {
      const totalProviders = totalProvidersByResource[resourceName] || 0;
      generateResourcePage(vCfg, data, resourceName, usageStats, VERSIONS, totalProviders);
      pageCount++;

      for (const field of fields) {
        generateFieldPage(vCfg, data, resourceName, field, usageStats, VERSIONS, totalProviders);
        pageCount++;

        if (field.LookupStatus?.includes('with Enumerations') && field.LookupName) {
          const lookupValues = data.lookupMap[field.LookupName] || [];
          for (const lk of lookupValues) {
            generateLookupPage(vCfg, data, resourceName, field, lk, usageStats, VERSIONS, totalProviders);
            pageCount++;
          }
        }
      }
    }

    const aboutCount = generateAboutPages(vCfg, data, VERSIONS);
    pageCount += aboutCount;

    const xrefCount = generateXrefPages(vCfg, data, VERSIONS);
    pageCount += xrefCount;

    console.log(`  Generated ${pageCount} pages (${aboutCount} about, ${xrefCount} cross-reference)`);
  }

  // Generate DD landing page
  generateDDLandingPage(allData);

  // Write shared assets
  const assetsDir = join(OUTPUT_DIR, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'dd.css'), getPageCSS());
  writeFileSync(join(assetsDir, 'dd.js'), getPageJS());
  writeFileSync(join(assetsDir, 'dd-landing.css'), getLandingCSS());
  writeFileSync(join(assetsDir, 'dd-landing.js'), getLandingJS());
  console.log('  Written shared assets to dd-output/assets/');

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Generator failed:', err);
  process.exit(1);
});
