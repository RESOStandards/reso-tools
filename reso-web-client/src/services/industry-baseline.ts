/**
 * Industry performance baseline service.
 *
 * Singleton that fetches industry-wide performance averages from
 * the Cert API on first access and caches them for the session.
 * Non-blocking — callers get null if the data is not yet available.
 *
 * TODO: post-conference, move this into the Replication State Service
 * so it lives alongside the other cert state rather than as a standalone.
 *
 * Usage:
 *   // On dashboard mount (fire-and-forget):
 *   initIndustryBaseline();
 *
 *   // In a component (synchronous, non-blocking):
 *   const baseline = getIndustryBaseline();
 */

export interface IndustryBaseline {
  readonly avgResponseMs: number;
  readonly avgBandwidth: number;
  readonly avgResponseBytes: number;
  /** Top resources ranked by industry usage (record count descending). */
  readonly topResources: ReadonlyArray<string>;
  /** Number of certified providers in the dataset. */
  readonly providerCount: number;
}

let cache: IndustryBaseline | null = null;
let fetchPromise: Promise<IndustryBaseline | null> | null = null;

const CERT_API = 'https://certqa.reso.org/api/v1';
const proxy = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${CERT_API}${path}`)}`;

/** Known metadata keys in performanceReport (everything else is a resource name). */
const PERF_META_KEYS = new Set([
  'reportId', 'type', 'version', 'description', 'generatedOn',
  'recipientUoi', 'providerUoi', 'providerUsi', 'optInStatus', 'opted_in',
  'averageResponseTimeMillis', 'averageBandwidth', 'averageResponseBytes',
]);

/** Initialize the baseline fetch. Safe to call multiple times — only fetches once. */
export const initIndustryBaseline = (): void => {
  if (cache || fetchPromise) return;

  fetchPromise = (async (): Promise<IndustryBaseline | null> => {
    try {
      // 1. Fetch recent DD reports
      const filterRes = await fetch(proxy('/certification_reports/filter'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          options: {
            from: 0,
            endorsementFilter: ['data_dictionary'],
            statusFilter: [],
            showMyResults: false,
            providerUoi: null,
            searchKey: '',
            sortBy: 'desc',
            sortByTimestamp: true,
          },
        }),
      });
      if (!filterRes.ok) return null;
      const filterData = await filterRes.json();

      const allReports = Object.values(filterData.reportsByOrgs ?? {})
        .flat() as ReadonlyArray<Record<string, unknown>>;

      // 2. Find a report with non-null performance data (some providers opt out).
      //    Paginate through endorsements if needed — same scroll pattern as the cert dashboard.
      let perfReport: Record<string, unknown> | null = null;
      let marketAvg: Record<string, number> | null = null;
      let remainingReports = [...allReports] as Array<Record<string, unknown>>;
      let nextFrom = filterData.lastUoiIndex ?? null;

      const tryReports = async (reports: ReadonlyArray<Record<string, unknown>>): Promise<boolean> => {
        for (const report of reports) {
          if (!report?.id) continue;
          const perfRes = await fetch(
            proxy(`/payload/performance/provider-metrics/${report.id}`),
            { headers: { Accept: 'application/json' } },
          );
          if (!perfRes.ok) continue;
          const perfData = await perfRes.json();
          if (perfData.performanceReport != null) {
            perfReport = perfData.performanceReport;
            marketAvg = perfData.marketAverage ?? null;
            return true;
          }
          // Even opted-out reports have marketAverage — grab it as fallback
          if (!marketAvg && perfData.marketAverage) {
            marketAvg = perfData.marketAverage;
          }
        }
        return false;
      };

      // Try first page
      let found = await tryReports(remainingReports.slice(0, 10));

      // Scroll through additional pages if needed (up to 3 pages)
      let pages = 0;
      while (!found && nextFrom != null && pages < 3) {
        pages++;
        const scrollRes = await fetch(proxy('/certification_reports/filter'), {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            options: {
              from: nextFrom,
              endorsementFilter: ['data_dictionary'],
              statusFilter: [],
              showMyResults: false,
              providerUoi: null,
              searchKey: '',
              sortBy: 'desc',
              sortByTimestamp: true,
            },
          }),
        });
        if (!scrollRes.ok) break;
        const scrollData = await scrollRes.json();
        const moreReports = Object.values(scrollData.reportsByOrgs ?? {})
          .flat() as Array<Record<string, unknown>>;
        if (moreReports.length === 0) break;
        nextFrom = scrollData.lastUoiIndex ?? null;
        found = await tryReports(moreReports.slice(0, 10));
      }

      if (!marketAvg) return null;

      // 3. Extract per-resource stats and rank by record count
      const topResources: string[] = [];
      if (perfReport) {
        const resourceEntries = Object.entries(perfReport)
          .filter(([k]) => !PERF_META_KEYS.has(k))
          .filter(([, v]) => v != null && typeof v === 'object')
          .map(([name, stats]) => ({
            name,
            records: (stats as Record<string, number>)?.numRecordsFetched ?? 0,
          }))
          .sort((a, b) => b.records - a.records);
        topResources.push(...resourceEntries.slice(0, 5).map(r => r.name));
      }

      // 4. Fetch market averages for provider count
      let providerCount = 0;
      try {
        const mktRes = await fetch(
          proxy('/certification_reports/market-average/data_dictionary'),
          { headers: { Accept: 'application/json' } },
        );
        if (mktRes.ok) {
          const mktData = await mktRes.json();
          providerCount = mktData.docCount ?? 0;
        }
      } catch { /* non-critical */ }

      const mkt = marketAvg as Record<string, number>;
      cache = {
        avgResponseMs: mkt.averageResponseTimeMillis ?? 0,
        avgBandwidth: mkt.averageBandwidth ?? 0,
        avgResponseBytes: mkt.averageResponseBytes ?? 0,
        topResources,
        providerCount,
      };
      return cache;
    } catch {
      return null;
    }
  })();
};

/** Get the cached baseline synchronously. Auto-inits if not yet started. Returns null until data arrives. */
export const getIndustryBaseline = (): IndustryBaseline | null => {
  if (!cache && !fetchPromise) initIndustryBaseline();
  return cache;
};

/**
 * Locked resource order for the current session.
 * Set once from industry data or from an initial observation, never re-sorted.
 */
let resourceOrder: ReadonlyArray<string> | null = null;

/** Lock resource display order. Prefers industry ranking; falls back to provided order (needs 3+ resources). */
export const lockResourceOrder = (fallbackOrder: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (cache && cache.topResources.length > 0) {
    resourceOrder = cache.topResources;
  } else if (!resourceOrder && fallbackOrder.length >= 5) {
    resourceOrder = fallbackOrder;
  }
  return resourceOrder ?? fallbackOrder;
};

/** Get the locked resource order. Returns null if not yet locked. */
export const getResourceOrder = (): ReadonlyArray<string> | null => {
  // Upgrade to industry order if it arrived after initial lock
  if (cache && cache.topResources.length > 0) {
    resourceOrder = cache.topResources;
  }
  return resourceOrder;
};
