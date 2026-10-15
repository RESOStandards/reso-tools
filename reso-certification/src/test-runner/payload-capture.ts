/**
 * Saving what a certification run received, not only what it asked for.
 *
 * A Core report records `requestUrl` per scenario and no response body, and `responseBody` is
 * populated only for error detail. So a run that PASSES leaves nothing to inspect: the verbose log
 * shows every request and no reply, which is enough to verify a skip (a skipped scenario issues no
 * query at all) and not enough to verify a pass. Whether an assertion read what it meant to read
 * cannot be checked after the fact, and re-running against a proxy is not always possible on a live
 * provider endpoint.
 *
 * This wraps the run's requester so each exchange is written to a directory. OFF unless a directory
 * is given: capture writes a provider's data to disk, which is the kind of thing that must be asked
 * for rather than defaulted into.
 *
 * **Credentials never reach disk, by construction.** Headers are kept by ALLOWLIST and the
 * `authToken` is never carried over in any form. Nothing is filtered out, so there is no pattern to
 * get wrong: a header reaches disk only because it was named on purpose.
 */

import { type RequestOptions, odataDefaultHeaders } from './client.js';
import type { ODataRequester } from './requester.js';
import type { ODataResponse } from './types.js';

/**
 * The headers a capture KEEPS. Anything not named here is dropped.
 *
 * An allowlist, not a filter on credentials. Josh, 2026-10-15: "having required headers and default
 * empty makes more sense than filtering out auth."
 *
 * The difference is which way the rule fails. A denylist has to anticipate every place a credential
 * can live — `Authorization`, `X-Api-Key`, `X-Auth-Token`, whatever a provider invents next — and
 * leaks the first one nobody thought of. An allowlist defaults to empty, so a header reaches disk
 * only because someone named it here on purpose. A new exotic auth header cannot leak, because it
 * was never on the list.
 *
 * The list is deliberately short: each entry is a header that says something about OData
 * conformance, which is what a capture exists to let someone check. Each carries its reason below,
 * and the notable omissions carry theirs, so a later reader can tell a decision from an oversight.
 *
 * Add to it deliberately. Every addition is a claim that the header carries no secret.
 */
const KEPT_HEADERS: ReadonlySet<string> = new Set([
  // ── The OData family ────────────────────────────────────────────────────────────────────────
  // Version negotiation, which is what Core tests. The Core spec names `OData-Version` throughout,
  // and its absence from an earlier draft of this capture is what started this list.
  'odata-version',
  'odata-maxversion',
  // Returned on a create and used to request snapshot isolation. Neither is exercised by a Core
  // read run; both are kept because they are OData protocol headers and the moment Add/Edit is
  // wired to this capture they are the first two anyone looks for.
  'odata-entityid',
  'odata-isolation',

  // ── Format ──────────────────────────────────────────────────────────────────────────────────
  // Normative in Core: "If a request for metadata does not specify a format preference (via
  // `Accept` header or `$format`) then the XML representation MUST be returned."
  'accept',
  'content-type',

  // ── Locale ──────────────────────────────────────────────────────────────────────────────────
  // Core: "Services SHOULD order language-dependent strings according to the content-language of
  // the response". A collation result that looks wrong is read here first.
  'accept-language',
  'content-language',

  // ── Paging ──────────────────────────────────────────────────────────────────────────────────
  // What was asked of the server and what it says it honored. A `maxpagesize` the server quietly
  // ignored shows up as these two disagreeing and nowhere else.
  'prefer',
  'preference-applied',

  // ── Why a run behaved the way it did ───────────────────────────────────────────────────────
  // Cert retries only 429 and 503, honoring this, so a long run with no failures is explained here
  // or not at all.
  'retry-after',
  // The scheme expected when auth failed. A challenge from the server, never a credential, and the
  // header a reader most needs when a run 401s.
  'www-authenticate'
]);

// Deliberately absent, so the omissions read as decisions rather than oversights:
//   authorization and every other credential carrier — the whole reason this is an allowlist.
//   etag / if-match / location — concurrency and redirection; nothing in Core or DD turns on them.
//   content-length — the body is right here; its length is not a second fact.
//   cache-control / date / server / access-control-* — say nothing about OData conformance.
//
// Sourced from `proposals/web-api-core.md` and `proposals/data-dictionary.md` in RESOStandards/
// transport. Both specs are sparse on headers: they name `Authorization`, `OData-Version`,
// `Accept` and `Content-Language` normatively and little else, so the rest of this list is the
// OData protocol family plus the three headers that explain how a run behaved.

/** True when a header is one the capture keeps. Case-insensitive: header names are. */
export const isKeptHeader = (name: string): boolean => KEPT_HEADERS.has(name.toLowerCase());

/**
 * A header record reduced to the kept names, in any casing. Default empty.
 *
 * NOT applied to a response body. A body is provider listing data and is the thing the capture
 * exists to show; reducing it would quietly corrupt the record being kept.
 */
export const onlyKeptHeaders = (record: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(record ?? {}).filter(([name]) => isKeptHeader(name)));

/**
 * One exchange's metadata. The body is NOT here: it is written beside this, verbatim.
 *
 * Frozen on construction. A capture is evidence, and evidence that a later stage can edit in place
 * is not evidence.
 */
export interface CapturedExchange {
  readonly seq: number;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** The file holding the response exactly as it came off the wire. */
  readonly bodyFile: string;
  readonly bodyBytes: number;
}

/**
 * The extension a body is saved under, from what the server said it sent.
 *
 * `$metadata` returns XML while everything else returns JSON, and saving an XML document as
 * `.json` makes it unopenable by the tools someone would reach for. Read from `content-type`
 * rather than guessed from the URL.
 */
export const bodyExtension = (contentType: string | undefined): string => {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('xml')) return 'xml';
  if (type.includes('json')) return 'json';
  if (type.includes('text/')) return 'txt';
  return 'bin';
};

/**
 * A stable, sortable, filesystem-safe NAME STEM for one exchange. The body and its metadata are
 * written as `<stem>.<ext>` and `<stem>.meta.json`, so the pair sorts together.
 *
 * Sequence first so the directory reads in request order, which is the order a run is reasoned
 * about. The URL's path and query follow, with every character outside `[A-Za-z0-9._-]` collapsed,
 * so a name is recognizable without being a path. Truncated, because an OData query can exceed what
 * a filesystem accepts and a name is a label rather than the record.
 */
export const captureStem = (seq: number, method: string, url: string): string => {
  const tail = url.replace(/^https?:\/\/[^/]+/i, '');
  const slug = tail
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${String(seq).padStart(4, '0')}-${method.toLowerCase()}${slug ? `-${slug}` : ''}`;
};

/** What the capturing requester needs in order to persist one exchange. Injected, so the wrapper is
 *  testable without touching a filesystem. */
export type CaptureWriter = (fileName: string, contents: string) => Promise<void>;

/**
 * Wrap a requester so every exchange is written.
 *
 * The response is returned unchanged and a write failure never fails the run: capture is
 * instrumentation, and a full disk must not turn a passing certification into a failing one. The
 * error surfaces through `onWriteError` so it is visible rather than swallowed.
 */
export const createCapturingRequester = (
  inner: ODataRequester,
  write: CaptureWriter,
  onWriteError?: (fileName: string, error: unknown) => void
): ODataRequester => {
  // Scoped to this wrapper and never read outside it: one run, one sequence.
  let seq = 0;
  return {
    request: async (options: RequestOptions & { readonly odataVersion?: string }): Promise<ODataResponse> => {
      const response = await inner.request(options);
      seq += 1;

      const responseHeaders = onlyKeptHeaders(response.headers);
      const stem = captureStem(seq, options.method, options.url);
      const bodyFile = `${stem}.${bodyExtension(response.headers?.['content-type'] ?? response.headers?.['Content-Type'])}`;

      // The body goes to disk EXACTLY as it came off the wire. `response.body` is the parsed
      // object; writing that would re-serialize it, which reorders keys and can move the precision
      // of an Edm.Decimal — so the file would no longer be what the server sent, which is the only
      // thing it is there to prove.
      const rawBody = response.rawBody ?? '';

      const exchange: CapturedExchange = Object.freeze({
        seq,
        method: options.method,
        url: options.url,
        status: response.status,
        // The headers as SENT, not as passed. `odataRequest` adds `OData-Version` on the caller's
        // behalf below this seam, taken from the same function that adds them so the two cannot
        // drift. The `authToken` is never carried over in any form.
        requestHeaders: onlyKeptHeaders({ ...odataDefaultHeaders(options.odataVersion), ...options.headers }),
        responseHeaders,
        bodyFile,
        bodyBytes: Buffer.byteLength(rawBody, 'utf-8')
      });

      try {
        await write(bodyFile, rawBody);
        await write(`${stem}.meta.json`, `${JSON.stringify(exchange, null, 2)}\n`);
      } catch (error) {
        onWriteError?.(stem, error);
      }
      return response;
    }
  };
};
