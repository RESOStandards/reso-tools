/**
 * Generic OData replication iterator — the paging loop, and nothing else.
 *
 * A dumb client. It issues requests, yields pages, and enforces nothing from certification: no
 * completeness assertion, no spec rule, no verdict. Everything a certification run needs to
 * *conclude* from a walk belongs to the caller.
 *
 * ## Why TopAndSkip, and only TopAndSkip
 *
 * The Data Dictionary specification prescribes `$top`/`$skip` for Lookup Resource replication:
 * "All records will be replicated from the `Lookup` resource using `$top` and `$skip` queries"
 * (DD spec, certification testing rules). Changing the query used for that same functionality
 * would impose a new rule on an existing element — requiring a provider's Lookup resource to
 * support `@odata.nextLink` when the 2.x rules never asked for it — which needs a major version
 * change. So 2.x is TopAndSkip, and the other three strategies are declared but not implemented.
 * The whole replication engine is rewritten in 2.2; building an abstraction for the others now
 * would be throwaway.
 *
 * Note that server-driven paging IS used against this resource elsewhere, for *sampling*. That is
 * a different operation from replication and is not affected by any of the above.
 *
 * ## The rule that matters
 *
 * `$top` stays fixed at the requested window. `$skip` advances by the number of records the server
 * **actually served**, which is not always what was asked for — the specification is explicit that
 * "Clients should be prepared to paginate with page sizes less than the requested size. For
 * example, if 1,000 were requested but only 100 were supported on the server, the consumer's next
 * query should have a `$top=100` and `$skip=100`."
 *
 * Both failure modes around that rule are real and this iterator avoids each:
 *
 *  - Advancing `$skip` by the *requested* window leaves gaps. Ask for 1,000, receive 200, skip to
 *    1,000, and records 201 through 1,000 are never fetched. The total looks plausible and the
 *    missing rows are scattered rather than at the end.
 *  - Treating a short page as end-of-data truncates. A provider serving 200 rows per page is not
 *    telling you the collection ended at 200. **A short page is not end-of-data.** The walk ends
 *    only on a page that returns no records at all.
 *
 * `$top` is never combined with nextLink-following here. A `$top` on a server-driven walk bounds
 * that walk — the server offers links until `$top` is reached or it runs out — which is a valid
 * thing for a caller to want but is the opposite of replicating a complete set.
 *
 * ## `@odata.count`
 *
 * Surfaced on the page when a server volunteers one, and never acted upon: not a loop bound, not a
 * termination condition, not an assertion. Advertised counts are not reliable enough to decide on,
 * and a count-based guard would also mask a broken walk rather than fix it. The iterator never
 * requests `$count` of its own accord.
 *
 * ## No progress
 *
 * A non-200 does not advance `$skip`. The walk yields that page and stops, rather than reissuing an
 * identical request. The caller sees the status and decides what it means.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ODataRequester, buildResourceUrl, webRequester } from '../test-runner/index.js';

// ── Strategies ──

/**
 * The replication strategies. Only {@link REPLICATION_STRATEGIES.TOP_AND_SKIP} is implemented in
 * 2.x; the rest are declared so a caller names a strategy explicitly rather than relying on a
 * default, and so the 2.2 engine has the vocabulary already fixed.
 */
export const REPLICATION_STRATEGIES = Object.freeze({
  TOP_AND_SKIP: 'TopAndSkip',
  TIMESTAMP_ASC: 'TimestampAsc',
  TIMESTAMP_DESC: 'TimestampDesc',
  NEXT_LINK: 'NextLink'
} as const);

export type ReplicationStrategy = (typeof REPLICATION_STRATEGIES)[keyof typeof REPLICATION_STRATEGIES];

/** Every strategy name, for a caller that needs to validate input. */
export const REPLICATION_STRATEGY_VALUES: ReadonlyArray<ReplicationStrategy> = Object.values(REPLICATION_STRATEGIES);

/** The default requested window. A server may serve fewer, which the walk handles. */
export const DEFAULT_PAGE_SIZE = 1000;

// ── Types ──

/** One page of a replication walk. */
export interface ReplicationPage {
  /** The records this page carried. Empty on a non-200, and empty on the page that ends the walk. */
  readonly records: ReadonlyArray<Record<string, unknown>>;
  readonly status: number;
  /** The URL actually requested, for a caller that needs to report the failing request. */
  readonly requestUrl: string;
  /** 1-based. */
  readonly pageNumber: number;
  /** Running total across the walk, including this page. */
  readonly totalRecordsFetched: number;
  /** `@odata.count` if the server volunteered one. Recorded, never acted on. */
  readonly advertisedCount?: number;
  /** The raw response body on a non-200, so the caller can build its own error. */
  readonly errorBody?: string;
}

export interface ReplicationConfig {
  /** OData service root, no resource name and no query. */
  readonly serviceRootUri: string;
  readonly resourceName: string;
  readonly strategy: ReplicationStrategy;
  readonly authToken: string;
  /** The requested `$top`. Defaults to {@link DEFAULT_PAGE_SIZE}. */
  readonly pageSize?: number;
  readonly odataVersion?: string;
  /**
   * Any valid OData query options, e.g. `$filter`, `$expand`, `$orderby`. Preserved on every
   * request. The iterator owns `$top` and `$skip` and will override those two if passed here.
   *
   * Note that the iterator never *adds* an `$orderby` of its own. A caller may pass one; a client
   * silently injecting one to stabilize paging changes what the server was asked for.
   */
  readonly query?: Readonly<Record<string, string>>;
  /** Injectable request seam. Defaults to the production requester. */
  readonly requester?: ODataRequester;
  /** When set, each page is written here as JSON. Omitted, nothing touches disk. */
  readonly outputPath?: string;
}

// ── URL construction ──

/**
 * Build one request URL: the caller's query options, then `$top` and `$skip`, which this iterator
 * owns. `URLSearchParams` percent-encodes values, which OData accepts for `$filter` and friends.
 */
const buildPageUrl = (
  serviceRootUri: string,
  resourceName: string,
  top: number,
  skip: number,
  query: Readonly<Record<string, string>> = {}
): string => {
  const url = new URL(buildResourceUrl(serviceRootUri, resourceName));
  for (const [key, value] of Object.entries(query)) {
    if (key !== '$top' && key !== '$skip') url.searchParams.set(key, value);
  }
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$skip', String(skip));
  return url.toString();
};

/** `@odata.count` if present and numeric. Read for the record, never for a decision. */
const readAdvertisedCount = (body: unknown): number | undefined => {
  const raw = (body as Record<string, unknown> | null)?.['@odata.count'];
  const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
};

/**
 * The page's records.
 *
 * A `value` that is present but is not an array is a malformed collection response, and it is
 * refused rather than read as an empty page. Substituting `[]` there would end the walk and report
 * "the resource exists and has no rows", which is a clean-looking wrong answer of exactly the kind
 * this module was rewritten to remove. Refusing is protocol validation, not a certification verdict:
 * the caller still decides what a failure means.
 *
 * An absent or null `value` is still treated as an empty page. That is the prior behavior and is
 * left alone deliberately, so this change cannot newly fail a provider that answers an empty
 * collection that way.
 */
const readRecords = (body: unknown, requestUrl: string): ReadonlyArray<Record<string, unknown>> => {
  const value = (body as { value?: unknown } | null)?.value;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Malformed OData collection response from ${requestUrl}: "value" is ${typeof value}, not an array. Refusing to read it as an empty page.`
    );
  }
  return value as ReadonlyArray<Record<string, unknown>>;
};

const stringifyBody = (body: unknown): string => (typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body ?? ''));

// ── The walk ──

/**
 * Replicate a resource, yielding one page at a time.
 *
 * The caller controls when to stop by breaking out of the loop, so there is no record limit here.
 * Consuming to completion walks the whole collection.
 *
 * `async function*` rather than an arrow: an arrow function cannot be a generator. The loop's
 * cursor state is local to the generator and dies with it — none of it is observable outside.
 */
export async function* replicationIterator(config: ReplicationConfig): AsyncGenerator<ReplicationPage> {
  if (config.strategy !== REPLICATION_STRATEGIES.TOP_AND_SKIP) {
    throw new Error(
      `Replication strategy '${config.strategy}' is not implemented. The Data Dictionary rules prescribe '${REPLICATION_STRATEGIES.TOP_AND_SKIP}' for 2.x; the rest arrive with the 2.2 replication engine rewrite.`
    );
  }

  const requester = config.requester ?? webRequester;
  const top = config.pageSize ?? DEFAULT_PAGE_SIZE;

  // Cursor state, local to this generator. `skip` advances by records SERVED, never by `top`.
  let skip = 0;
  let pageNumber = 0;

  for (;;) {
    const requestUrl = buildPageUrl(config.serviceRootUri, config.resourceName, top, skip, config.query);
    const response = await requester.request({
      method: 'GET',
      url: requestUrl,
      authToken: config.authToken,
      odataVersion: config.odataVersion
    });

    pageNumber += 1;

    // A non-200 does not advance the cursor. Yield it and stop, rather than reissuing the same
    // request. What the status MEANS is the caller's to decide — this client has no opinion.
    if (response.status !== 200) {
      yield {
        records: [],
        status: response.status,
        requestUrl,
        pageNumber,
        totalRecordsFetched: skip,
        errorBody: stringifyBody(response.body)
      };
      return;
    }

    const records = readRecords(response.body, requestUrl);
    skip += records.length;

    if (config.outputPath && records.length > 0) {
      await mkdir(config.outputPath, { recursive: true });
      await writeFile(
        join(config.outputPath, `${config.resourceName}-page-${pageNumber}.json`),
        JSON.stringify({ value: records }, null, 2),
        'utf-8'
      );
    }

    yield {
      records,
      status: response.status,
      requestUrl,
      pageNumber,
      totalRecordsFetched: skip,
      advertisedCount: readAdvertisedCount(response.body)
    };

    // The ONLY termination on a successful response: the server returned nothing. A short page
    // means the server served less than asked for, not that the collection ended.
    if (records.length === 0) return;
  }
}
