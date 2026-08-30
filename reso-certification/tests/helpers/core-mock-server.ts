import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * A fetch-level mock OData server for end-to-end Web API Core runs. It routes the three request
 * shapes a Core run makes — the service document, `$metadata`, and resource queries — to canned
 * responses, and lets a test inject the failure paths (invalid metadata, a 401, empty data, slow)
 * so `runCoreCompliance` can be exercised whole without a live server. Pair it with report-file
 * assertions (read `result.context.outputPath`) for run-completion / verdict guardrails.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/commander');

/** A minimal, valid EDMX (one `Property` resource with a key) — enough to sample and test. */
export const VALID_EDMX = readFileSync(join(FIXTURES, 'good-edmx.xml'), 'utf-8');
/** Parseable XML whose schema is invalid (a `Property` with no key) — fails XSD/semantic validation. */
export const INVALID_EDMX = readFileSync(join(FIXTURES, 'bad-edmx-no-keyfield.xml'), 'utf-8');

export interface CoreMockOptions {
  /** EDMX served at `$metadata` (default: VALID_EDMX). */
  readonly metadataXml?: string;
  /** HTTP status for `$metadata` (default 200). */
  readonly metadataStatus?: number;
  /** HTTP status for resource queries (default 200) — set 401 to abort sampling with fatal-auth. */
  readonly resourceStatus?: number;
  /** Body for resource queries (default: zero rows, which makes scenarios SKIP rather than fail). */
  readonly resourceBody?: unknown;
}

export interface InstalledMock {
  /** Every URL fetched, in order — for asserting what the run did (and did not) request. */
  readonly calls: ReadonlyArray<string>;
  restore(): void;
}

const odataJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'odata-version': '4.01' }
  });

/**
 * Install the mock over `globalThis.fetch` (restore in afterEach). `base` is the server URL the
 * run is configured with; every request is routed by its path relative to `base`.
 */
export const installCoreMockServer = (base: string, opts: CoreMockOptions = {}): InstalledMock => {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    // $metadata (may carry a $format query) — checked first so it never falls through to a resource.
    if (url.includes('/$metadata')) {
      return new Response(opts.metadataXml ?? VALID_EDMX, {
        status: opts.metadataStatus ?? 200,
        headers: { 'content-type': 'application/xml', 'odata-version': '4.01' }
      });
    }

    // Service document: the base URL itself (optionally with a trailing slash / query, no resource).
    const path = url.startsWith(base) ? url.slice(base.length).replace(/^\//, '') : url;
    if (path === '' || path.startsWith('?')) {
      return odataJson({ '@odata.context': `${base}/$metadata`, value: [{ name: 'Property', url: 'Property' }] });
    }

    // Resource query — default is zero rows, which the sampler treats as "can't sample" (skip), not fail.
    return odataJson(opts.resourceBody ?? { value: [], '@odata.count': 0 }, opts.resourceStatus ?? 200);
  });

  return { calls, restore: () => spy.mockRestore() };
};
