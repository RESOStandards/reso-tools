/**
 * Generates a RESO metadata report (server-metadata.json) from a DD XLSX sheet.
 *
 * Reads the Fields and Lookups sheets from a RESO Data Dictionary XLSX file
 * and produces the same JSON format used by the reference server and
 * certification tools.
 *
 * Usage:
 *   npx tsx src/metadata/generate-from-xlsx.ts <path-to-xlsx> [version]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { MetadataReport, MetadataReportField, MetadataReportLookup, MetadataReportResource } from './serializer.js';

// ── XLSX reading (dynamic import to avoid hard dependency) ──

interface SheetRow {
  readonly [key: string]: string | number | boolean | null | undefined;
}

const readSheet = async (xlsxPath: string, sheetName: string): Promise<ReadonlyArray<SheetRow>> => {
  const xlsxModule = await import('xlsx');
  const XLSX = xlsxModule.default ?? xlsxModule;
  const workbook = XLSX.readFile(xlsxPath);

  // Handle both singular and plural sheet names (2.0 uses "Fields"/"Lookups", 2.1 uses "Field"/"Lookup")
  const actualName = workbook.SheetNames.find((n: string) =>
    n.toLowerCase() === sheetName.toLowerCase() ||
    n.toLowerCase() === sheetName.toLowerCase() + 's'
  );

  if (!actualName) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`);
  }

  return XLSX.utils.sheet_to_json(workbook.Sheets[actualName], { defval: '' }) as ReadonlyArray<SheetRow>;
};

// ── Constants ──

const ENUM_NAMESPACE = 'org.reso.metadata.enums';

/** Build the correct wiki base URL for a DD version. */
const getWikiBaseUrl = (version: string): string => {
  // DD 2.1+ uses dd.reso.org
  if (version !== '1.7' && version !== '2.0') {
    return `https://dd.reso.org/DD${version}`;
  }
  // DD 2.0 and 1.7 use the legacy ddwiki
  const wikiVersion = version === '1.7' ? 'DDW17' : 'DDW20';
  return `https://ddwiki.reso.org/display/${wikiVersion}`;
};

/** Rewrite a wiki URL from the sheet to match the target version. */
const rewriteWikiUrl = (sheetUrl: string, version: string): string => {
  if (!sheetUrl) return '';
  // If version is 2.1+, rewrite ddwiki URLs to dd.reso.org
  if (version !== '1.7' && version !== '2.0' && sheetUrl.includes('ddwiki.reso.org')) {
    const baseUrl = getWikiBaseUrl(version);
    // Extract the page name from the ddwiki URL: /display/DDW20/PageName → PageName
    const match = sheetUrl.match(/\/display\/DDW\d+\/(.+)/);
    if (match) {
      const pageName = match[1].replace(/\+/g, '/');
      return `${baseUrl}/${pageName}`;
    }
  }
  return sheetUrl;
};

// ── Type mapping ──

/** Map DD SimpleDataType to OData Edm type info. */
const mapFieldType = (
  field: SheetRow,
): { type: string; nullable: boolean; maxLength?: number; scale?: number; precision?: number; isCollection?: boolean } => {
  const simpleType = String(field.SimpleDataType ?? '').trim();
  const lookupName = String(field.LookupName ?? '').trim();
  const sugMaxLength = field.SugMaxLength ? Number(field.SugMaxLength) : undefined;
  const sugMaxPrecision = field.SugMaxPrecision ? Number(field.SugMaxPrecision) : undefined;
  const repeatingElement = String(field.RepeatingElement ?? '').toLowerCase() === 'yes';

  // Lookup fields
  if (lookupName) {
    const fqdn = `${ENUM_NAMESPACE}.${lookupName}`;
    if (simpleType === 'String List, Multi' || repeatingElement) {
      return { type: `Collection(${fqdn})`, nullable: true, isCollection: true };
    }
    return { type: fqdn, nullable: true };
  }

  switch (simpleType) {
    case 'Number':
      if (sugMaxPrecision && sugMaxPrecision > 0) {
        // Decimal: DD uses SugMaxLength as precision and SugMaxPrecision as scale
        return {
          type: 'Edm.Decimal',
          nullable: true,
          precision: sugMaxLength,
          scale: sugMaxPrecision,
        };
      }
      // Integer (no decimal places)
      return { type: 'Edm.Int64', nullable: true };

    case 'String':
      return {
        type: 'Edm.String',
        nullable: true,
        ...(sugMaxLength ? { maxLength: sugMaxLength } : {}),
      };

    case 'Boolean':
      return { type: 'Edm.Boolean', nullable: true };

    case 'Date':
      return { type: 'Edm.Date', nullable: true };

    case 'Timestamp':
      return { type: 'Edm.DateTimeOffset', nullable: true };

    case 'String List, Single':
      // Single lookup without a LookupName (shouldn't happen but handle gracefully)
      return { type: 'Edm.String', nullable: true };

    case 'String List, Multi':
      // Multi lookup without a LookupName
      return { type: 'Collection(Edm.String)', nullable: true, isCollection: true };

    default:
      return { type: 'Edm.String', nullable: true };
  }
};

// ── Field processing ──

const processField = (row: SheetRow, version: string): MetadataReportField | null => {
  const resourceName = String(row.ResourceName ?? '').trim();
  const fieldName = String(row.StandardName ?? '').trim();
  const displayName = String(row.DisplayName ?? '').trim();
  const definition = String(row.Definition ?? '').trim();
  const rawWikiUrl = String(row.WikiPageUrl ?? '').trim();
  const wikiPageUrl = rewriteWikiUrl(rawWikiUrl, version);
  const lookupName = String(row.LookupName ?? '').trim();
  const payloads = String(row.Payloads ?? '').trim();
  const sourceResource = String(row.SourceResource ?? '').trim();

  if (!resourceName || !fieldName) return null;

  // SourceResource indicates a navigation property (expansion)
  const isExpansion = !!sourceResource;
  const simpleType = String(row.SimpleDataType ?? '').trim();

  // For expansions, the type is a reference to the target entity type
  const { type: mappedType, nullable, maxLength, scale, precision, isCollection: mappedIsCollection } = mapFieldType(row);
  const entityNamespace = ENUM_NAMESPACE.replace('.enums', '');
  const expansionType = isExpansion
    ? (simpleType === 'Collection'
      ? `Collection(${entityNamespace}.${sourceResource})`
      : `${entityNamespace}.${sourceResource}`)
    : mappedType;
  const type = isExpansion ? expansionType : mappedType;
  const isCollection = isExpansion ? simpleType === 'Collection' : mappedIsCollection;

  const annotations: Array<{ readonly term: string; readonly value: string }> = [];

  if (displayName) {
    annotations.push({ term: 'RESO.OData.Metadata.StandardName', value: displayName });
  }
  if (wikiPageUrl) {
    annotations.push({ term: 'RESO.DDWikiUrl', value: wikiPageUrl });
  }
  if (definition) {
    annotations.push({ term: 'Core.Description', value: definition });
  }
  if (payloads) {
    annotations.push({ term: 'RESO.OData.Metadata.Payloads', value: payloads });
  }

  return {
    resourceName,
    fieldName,
    type,
    ...(nullable != null ? { nullable } : {}),
    ...(maxLength != null ? { maxLength } : {}),
    ...(scale != null ? { scale } : {}),
    ...(precision != null ? { precision } : {}),
    ...(isCollection ? { isCollection } : {}),
    ...(isExpansion ? { isExpansion: true, typeName: sourceResource } : {}),
    ...(lookupName && !isExpansion ? { isEnumeration: true } : {}),
    annotations,
  };
};

// ── Lookup processing ──

const processLookup = (row: SheetRow, version: string): MetadataReportLookup | null => {
  const lookupName = String(row.LookupName ?? '').trim();
  const lookupValue = String(row.LegacyODataValue ?? row.StandardLookupValue ?? '').trim();
  const standardValue = String(row.StandardLookupValue ?? '').trim();
  const definition = String(row.Definition ?? '').trim();

  if (!lookupName || !lookupValue) return null;

  const annotations: Array<{ readonly term: string; readonly value: string }> = [];

  if (standardValue) {
    annotations.push({ term: 'RESO.OData.Metadata.StandardName', value: standardValue });
  }

  // Build wiki URL for lookup value
  const baseUrl = getWikiBaseUrl(version);
  const lookupPageName = standardValue || lookupValue;
  const wikiUrl = version !== '1.7' && version !== '2.0'
    ? `${baseUrl}/lookups/${encodeURIComponent(lookupName)}/${encodeURIComponent(lookupPageName)}`
    : `${baseUrl}/${encodeURIComponent(lookupPageName)}`;
  annotations.push({ term: 'RESO.DDWikiUrl', value: wikiUrl });

  if (definition) {
    annotations.push({ term: 'Core.Description', value: definition });
  }

  return {
    lookupName: `${ENUM_NAMESPACE}.${lookupName}`,
    lookupValue,
    type: 'Edm.Int32',
    ...(annotations.length > 0 ? { annotations } : {}),
  };
};

// ── Resource extraction ──

const extractResources = (
  fields: ReadonlyArray<MetadataReportField>,
  version: string,
): ReadonlyArray<MetadataReportResource> => {
  const seen = new Set<string>();
  const resources: MetadataReportResource[] = [];

  for (const field of fields) {
    if (!seen.has(field.resourceName)) {
      seen.add(field.resourceName);
      const baseUrl = getWikiBaseUrl(version);
      const resourceUrl = version !== '1.7' && version !== '2.0'
        ? `${baseUrl}/${field.resourceName}`
        : `${baseUrl}/${field.resourceName}+Resource`;
      resources.push({
        resourceName: field.resourceName,
        wikiPageURL: resourceUrl,
      });
    }
  }

  return resources;
};

// ── Main generator ──

/**
 * Generate a RESO metadata report from a DD XLSX file.
 *
 * @param xlsxPath Path to the RESO Data Dictionary XLSX file
 * @param version DD version (e.g., "2.0")
 * @returns MetadataReport in the standard server-metadata.json format
 */
export const generateMetadataReportFromXlsx = async (
  xlsxPath: string,
  version: string,
): Promise<MetadataReport> => {
  const fieldRows = await readSheet(xlsxPath, 'Field');
  const lookupRows = await readSheet(xlsxPath, 'Lookup');

  const fields = fieldRows
    .map(row => processField(row, version))
    .filter((f): f is MetadataReportField => f !== null);

  const lookups = lookupRows
    .map(row => processLookup(row, version))
    .filter((l): l is MetadataReportLookup => l !== null);

  // Add placeholder values for open enumerations (enum types with no values in the sheet).
  // OData EnumType requires at least one member.
  const lookupNamesWithValues = new Set(lookups.map(l => l.lookupName));
  const enumFieldLookupNames = new Set(
    fields
      .filter(f => f.isEnumeration && f.type.includes(ENUM_NAMESPACE))
      .map(f => {
        const rawType = f.type.startsWith('Collection(') ? f.type.slice('Collection('.length, -1) : f.type;
        return rawType;
      })
  );

  const placeholderLookups: MetadataReportLookup[] = [];
  for (const fqdn of enumFieldLookupNames) {
    if (!lookupNamesWithValues.has(fqdn)) {
      const shortName = fqdn.slice(fqdn.lastIndexOf('.') + 1);
      placeholderLookups.push({
        lookupName: fqdn,
        lookupValue: `Sample${shortName}EnumValue`,
        type: 'Edm.Int32',
        annotations: [
          { term: 'RESO.OData.Metadata.StandardName', value: `Sample ${shortName} Enum Value` },
        ],
      });
    }
  }

  const resources = extractResources(fields, version);

  return {
    description: 'RESO Data Dictionary Metadata Report',
    version,
    generatedOn: new Date().toISOString(),
    resources,
    models: resources.map(r => ({
      modelName: r.resourceName,
      modelType: 'EntityType' as const,
      properties: [],
      navigationProperties: [],
    })),
    fields,
    lookups: [...lookups, ...placeholderLookups],
    actions: [],
    functions: [],
  };
};

// ── CLI entry point ──

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: npx tsx src/metadata/generate-from-xlsx.ts <path-to-xlsx> [version]');
    process.exit(1);
  }

  const xlsxPath = resolve(args[0]);
  const version = args[1] ?? '2.0';

  console.log(`Generating metadata report from ${basename(xlsxPath)} (DD ${version})...`);

  const report = await generateMetadataReportFromXlsx(xlsxPath, version);

  const outputPath = xlsxPath.replace(/\.xlsx$/i, '.metadata-report.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`Resources: ${report.resources.length}`);
  console.log(`Fields: ${report.fields.length}`);
  console.log(`Lookups: ${report.lookups.length}`);
  console.log(`Written to: ${outputPath}`);
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
