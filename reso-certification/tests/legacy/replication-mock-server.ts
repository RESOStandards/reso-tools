/**
 * Minimal in-process OData collection endpoint for testing the replication strategies offline.
 *
 * Answers what the legacy replication iterator actually sends, per strategy:
 *   - count probe        GET /{Resource}?$count=true                → { @odata.count }
 *   - TopAndSkip         GET /{Resource}?$top=N&$skip=M             → records [M, M+N)
 *   - TimestampAsc/Desc  GET /{Resource}?$top=N&$filter=<ts op iso>&$orderby=<ts asc|desc>
 *   - NextLink           GET /{Resource} (+ Prefer: odata.maxpagesize=N), then follows @odata.nextLink
 *
 * Every non-empty page advertises an `@odata.nextLink` when more rows remain — the NextLink strategy follows
 * it; the others ignore it and page by $skip / boundary filter. A page past the end returns `{ value: [] }` and
 * no nextLink, which is how each strategy terminates. Uses an OS-assigned port (listen(0)) for tests.
 */

import type { Server } from 'node:http';
import express from 'express';

export interface ReplicationMockOptions {
  readonly resource: string;
  readonly records: ReadonlyArray<Record<string, unknown>>;
  /** Timestamp field the strategies filter/order on (the engine hardcodes ModificationTimestamp). */
  readonly timestampField?: string;
}

export interface ReplicationMockServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const toInt = (v?: string): number | undefined => (v == null ? undefined : Number.parseInt(v, 10));

/** Apply the timestamp boundary clause the timestamp strategies emit (ignoring any trailing `and …` clause). */
const applyFilter = (
  records: ReadonlyArray<Record<string, unknown>>,
  filter: string | undefined,
  tsField: string,
): ReadonlyArray<Record<string, unknown>> => {
  if (!filter) return records;
  const match = filter.match(new RegExp(`${tsField}\\s+(ge|gt|le|lt)\\s+(\\S+)`));
  if (!match) return records;
  const [, op, iso] = match;
  const bound = new Date(iso).getTime();
  return records.filter(r => {
    const t = new Date(String(r[tsField])).getTime();
    if (op === 'ge') return t >= bound;
    if (op === 'gt') return t > bound;
    if (op === 'le') return t <= bound;
    return t < bound; // lt
  });
};

/**
 * Order the rows the way a real server would. With NO `$orderby` (what TopAndSkip sends) rows stay in
 * insertion order — we do NOT impose a sort the client didn't ask for, so the test can't hide TopAndSkip's
 * reliance on a stable server default order. With `$orderby <ts> asc|desc` (the timestamp strategies) sort by
 * the timestamp field, tie-broken by ListingKey so equal-timestamp paging is deterministic.
 */
const applyOrderby = (
  records: ReadonlyArray<Record<string, unknown>>,
  orderby: string | undefined,
  tsField: string,
): ReadonlyArray<Record<string, unknown>> => {
  if (!orderby) return records; // insertion order — the server's default; TopAndSkip depends on it being stable
  const desc = orderby.toLowerCase().includes('desc');
  return [...records].sort((a, b) => {
    const ta = new Date(String(a[tsField])).getTime();
    const tb = new Date(String(b[tsField])).getTime();
    if (ta !== tb) return desc ? tb - ta : ta - tb;
    const ka = String(a.ListingKey ?? '');
    const kb = String(b.ListingKey ?? '');
    return desc ? kb.localeCompare(ka) : ka.localeCompare(kb);
  });
};

const parseMaxPageSize = (prefer: string | undefined): number | undefined => {
  const match = prefer?.match(/odata\.maxpagesize\s*=\s*(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
};

export const startReplicationMockServer = async (opts: ReplicationMockOptions): Promise<ReplicationMockServer> => {
  const tsField = opts.timestampField ?? 'ModificationTimestamp';
  const app = express();

  app.get(`/${opts.resource}`, (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const base = `${req.protocol}://${req.get('host')}`;

    // Count probe — the iterator reads @odata.count and pages separately.
    if (q['$count'] === 'true' && q['$top'] == null && q['$skip'] == null && q['$filter'] == null) {
      res.json({ '@odata.count': opts.records.length, value: [] });
      return;
    }

    const ordered = applyOrderby(applyFilter(opts.records, q['$filter'], tsField), q['$orderby'], tsField);
    const pageSize = toInt(q['$top']) ?? parseMaxPageSize(req.get('prefer')) ?? 100;
    const skip = toInt(q['$skip']) ?? 0;
    const page = ordered.slice(skip, skip + pageSize);

    const body: Record<string, unknown> = { '@odata.context': `${base}/$metadata#${opts.resource}`, value: page };
    if (skip + pageSize < ordered.length) {
      body['@odata.nextLink'] = `${base}/${opts.resource}?$skip=${skip + pageSize}`;
    }
    res.json(body);
  });

  return new Promise<ReplicationMockServer>(resolve => {
    const server: Server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
};
