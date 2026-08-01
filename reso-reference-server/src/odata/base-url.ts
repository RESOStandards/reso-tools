import type { Request } from 'express';

/**
 * Resolve the absolute base URL used to build response links (`@odata.context`, `@odata.nextLink`,
 * `@odata.id`, `@odata.editLink`, and the `Location` header).
 *
 * An explicit `override` (the `BASE_URL` env / config) always wins — the deterministic knob for a deployment
 * whose public origin the container can't observe from the request (e.g. behind a CDN that rewrites the `Host`
 * header, or an operator pinning a canonical FQDN like `https://reference-server.reso.org`).
 *
 * Otherwise the base is derived PER REQUEST from what the client actually connected to: `req.get('host')`
 * carries the published host + port (it passes through Docker port-mapping untouched, and most proxies —
 * including AWS ALB — preserve it), and `req.protocol` honors `X-Forwarded-Proto` once `trust proxy` is
 * enabled. This keeps every emitted URL ABSOLUTE — the interop-safe, ecosystem-normal form the whole
 * Microsoft OData client stack (Excel / Power Query / Power BI, the .NET OData client) and both major RESO
 * producers (Spark, Trestle/Cotality) rely on — yet correct with no static config in the local, Docker, and
 * direct-FQDN cases.
 *
 * Request-derivation is the documented remediation for proxy/port URL bugs (OData/AspNetCoreOData #1257,
 * OData/WebApi #1559). Relative URLs were considered and rejected: `@odata.context` must be absolute for the
 * dominant client stack, and a relative `@odata.nextLink` resolves against that context first (OData JSON
 * Format v4.01 §4.3), so relative can't buy host-independence without breaking those clients.
 */
export const resolveBaseUrl = (req: Request, override?: string): string =>
  override ?? `${req.protocol}://${req.get('host') ?? req.hostname}`;
