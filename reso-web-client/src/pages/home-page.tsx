import { NavLink } from 'react-router';
import { useServer } from '../context/server-context';

/** Card wrapper for landing page sections. */
const Card = ({ title, description, to, href, icon, disabled }: {
  readonly title: string;
  readonly description: string;
  /** Client-side route (NavLink). */
  readonly to?: string;
  /** External / server-side URL (plain anchor). */
  readonly href?: string;
  readonly icon: React.ReactNode;
  readonly disabled?: boolean;
}) => {
  const baseClass = 'group block p-6 rounded-xl border transition-all';
  const enabledClass = `${baseClass} bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md`;
  const disabledClass = `${baseClass} bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 opacity-60 cursor-not-allowed`;

  const content = (
    <>
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${disabled ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 group-hover:bg-blue-100 dark:group-hover:bg-blue-900/50'} transition-colors`}>
          {icon}
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{description}</p>
      {disabled && <span className="inline-block mt-3 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">Coming Soon</span>}
    </>
  );

  if (disabled) {
    return <div className={disabledClass}>{content}</div>;
  }

  if (href) {
    return <a href={href} className={enabledClass}>{content}</a>;
  }

  return <NavLink to={to ?? '/'} className={enabledClass}>{content}</NavLink>;
};

/** Server status badge shown on the landing page. */
const ServerStatus = () => {
  const { activeServer, resources, isLoadingResources } = useServer();

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-2 h-2 rounded-full ${isLoadingResources ? 'bg-yellow-400 animate-pulse' : 'bg-green-500'}`} />
      <span className="text-gray-600 dark:text-gray-400">
        Connected to <span className="font-medium text-gray-900 dark:text-white">{activeServer.name}</span>
        {resources && !isLoadingResources && (
          <span className="text-gray-400 dark:text-gray-500"> &middot; {resources.length} resources</span>
        )}
      </span>
    </div>
  );
};

/** Landing page with navigation cards for the main app sections. */
export const HomePage = () => {
  const { resources } = useServer();
  const firstResource = resources?.[0]?.name ?? 'Property';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">RESO Dashboard</h1>
          <p className="text-gray-600 dark:text-gray-400 text-lg mb-4">
            Browse, query, and manage real estate data using the RESO Data Dictionary standard.
          </p>
          <ServerStatus />
        </div>

        {/* Navigation cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            title="Browse Data"
            description="Search, view, and manage records across all RESO resources with OData query support."
            to={`/${firstResource}`}
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>Browse Data</title>
                <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
              </svg>
            }
          />

          <Card
            title="Metadata Explorer"
            description="Inspect resource schemas, field definitions, lookups, and navigation properties."
            to="/metadata"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>Metadata</title>
                <path fillRule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            }
          />

          <Card
            title="Organizations"
            description="Browse the RESO member organizations directory with endorsements and certification status."
            to="/organizations"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>Organizations</title>
                <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" />
              </svg>
            }
          />

          <Card
            title="Certification"
            description="Run RESO certification tests against connected servers to validate compliance."
            to="/certification"
            disabled
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>Certification</title>
                <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            }
          />

          <Card
            title="Analytics"
            description="View data quality metrics, coverage reports, and resource statistics."
            to="/analytics"
            disabled
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>Analytics</title>
                <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
              </svg>
            }
          />

          <Card
            title="API Documentation"
            description="Interactive Swagger UI for exploring the OData REST API endpoints."
            href="/api-docs"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <title>API Docs</title>
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
              </svg>
            }
          />
        </div>
      </div>
    </div>
  );
};
