/**
 * Detail Report placeholder — will show per-endorsement deep dive
 * with metadata, field availability and threshold filters.
 *
 * For now, shows a placeholder with breadcrumb navigation back to
 * the org summary page.
 */

import { NavLink, useParams } from 'react-router';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

export const DetailReportPage = () => {
  const { uoi, endorsementId } = useParams<{
    readonly uoi: string;
    readonly endorsementId: string;
  }>();

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className={`${PAGE_CONTAINER} pt-6 pb-20`}>
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-6" aria-label="Breadcrumb">
          <NavLink to="/cert" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Certification</NavLink>
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z" clipRule="evenodd" />
          </svg>
          {uoi && (
            <>
              <NavLink to={`/cert/orgs/${uoi}`} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Summary</NavLink>
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z" clipRule="evenodd" />
              </svg>
            </>
          )}
          <span className="text-gray-700 dark:text-gray-300 font-medium">Detail Report</span>
        </nav>

        {/* Placeholder */}
        <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-12 text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Detail Report</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Per-endorsement deep dive with metadata, field availability and threshold filters.
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">
            {endorsementId ?? 'No endorsement selected'}
          </p>
          <p className="mt-6 text-xs text-gray-400 dark:text-gray-500">
            Coming soon
          </p>
        </div>
      </div>
    </div>
  );
};
