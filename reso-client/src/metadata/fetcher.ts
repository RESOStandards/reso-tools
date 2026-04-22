/**
 * OData metadata fetcher — retrieves and parses CSDL/EDMX metadata
 * from an OData server's $metadata endpoint.
 *
 * Also detects the server's OData version from the response header
 * or EDMX namespace, so subsequent requests can send the correct
 * OData-Version header.
 */

import { parseCsdlXml } from '../csdl/parser.js';
import type { CsdlSchema } from '../csdl/types.js';

/**
 * Fetch raw EDMX XML metadata from an OData server.
 *
 * @param baseUrl - Server base URL (e.g. "http://localhost:8080")
 * @param token - Bearer authentication token
 * @returns Raw XML metadata string
 */
export interface MetadataFetchOptions {
  /** Add $format=application/xml query parameter. Default: false. Some servers require it, others reject it. */
  readonly useFormatParam?: boolean;
}

/** Result of fetching metadata — includes the raw XML and detected OData version. */
export interface MetadataFetchResult {
  /** Raw EDMX XML string. */
  readonly xml: string;
  /** Detected OData version from the response header or EDMX namespace. */
  readonly odataVersion: string | undefined;
}

/**
 * Detect the OData version from EDMX XML content.
 *
 * OData 4.0:  xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"
 * OData 4.01: xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.01"
 *
 * Falls back to checking the Version attribute on the edmx:Edmx element.
 */
const detectVersionFromXml = (xml: string): string | undefined => {
  // Look for Version="X.XX" on the edmx:Edmx element
  const versionMatch = xml.match(/<edmx:Edmx[^>]+Version="([^"]+)"/);
  if (versionMatch) return versionMatch[1];
  // Also try without namespace prefix
  const altMatch = xml.match(/<Edmx[^>]+Version="([^"]+)"/);
  return altMatch?.[1];
};

export const fetchRawMetadata = async (baseUrl: string, token: string, options: MetadataFetchOptions = {}): Promise<string> => {
  const result = await fetchRawMetadataWithVersion(baseUrl, token, options);
  return result.xml;
};

/** Fetch raw metadata and detect the server's OData version. */
export const fetchRawMetadataWithVersion = async (baseUrl: string, token: string, options: MetadataFetchOptions = {}): Promise<MetadataFetchResult> => {
  const formatParam = options.useFormatParam ? '?$format=application/xml' : '';
  const metadataUrl = `${baseUrl.replace(/\/$/, '')}/$metadata${formatParam}`;
  const response = await fetch(metadataUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/xml',
      'Accept-Encoding': 'gzip, deflate'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata from ${metadataUrl}: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  // Detect OData version: prefer response header, fall back to EDMX Version attribute
  const headerVersion = response.headers.get('OData-Version') ?? response.headers.get('odata-version');
  const xmlVersion = detectVersionFromXml(xml);
  const odataVersion = headerVersion ?? xmlVersion;

  return { xml, odataVersion };
};

/**
 * Fetch and parse CSDL metadata from an OData server.
 *
 * @param baseUrl - Server base URL
 * @param token - Bearer authentication token
 * @returns Parsed CSDL schema
 */
export const fetchAndParseMetadata = async (baseUrl: string, token: string, options?: MetadataFetchOptions): Promise<CsdlSchema> => {
  const xml = await fetchRawMetadata(baseUrl, token, options);
  return parseCsdlXml(xml);
};
