import { useMemo } from 'react';
import { NavLink, useLocation, useParams } from 'react-router';
import { useServer } from '../context/server-context';
import { READ_ONLY_RESOURCES } from '../types';

type Section = 'home' | 'organizations' | 'resources' | 'metadata';

/** Sidebar navigation with Home link and collapsible Resources and Metadata Explorer sections. */
export const ResourceNav = () => {
  const { resource: activeResource } = useParams<{ resource: string }>();
  const location = useLocation();
  const { resources, isLocal, isLoadingResources, permissions } = useServer();

  const resourceNames = useMemo(
    () => resources?.map(r => r.name) ?? [],
    [resources]
  );

  // Derive which section is active from the current URL
  const activeSection: Section =
    location.pathname === '/' ? 'home'
    : location.pathname.startsWith('/organizations') ? 'organizations'
    : location.pathname.startsWith('/metadata') ? 'metadata'
    : 'resources';

  const sectionHeaderClass = (section: Section, extra = '') =>
    `flex items-center gap-1.5 w-full text-xs font-semibold uppercase tracking-wider cursor-pointer select-none ${extra} ${
      activeSection === section
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
    }`;

  return (
    <div className="space-y-4">
      {/* Home link */}
      <NavLink to="/" className={sectionHeaderClass('home')}>
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <title>Home</title>
          <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
        </svg>
        Home
      </NavLink>

      {/* Organizations link */}
      <NavLink to="/organizations" className={sectionHeaderClass('organizations')}>
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <title>Organizations</title>
          <path d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a1 1 0 110 2H4a1 1 0 110-2V4zm3 1h2v2H7V5zm2 4H7v2h2V9zm2-4h2v2h-2V5zm2 4h-2v2h2V9z" />
        </svg>
        Organizations
      </NavLink>

      {/* Resources section */}
      <div>
        <NavLink to={activeSection === 'resources' ? '/metadata' : `/${resourceNames[0] ?? 'Property'}`} className={sectionHeaderClass('resources', 'mb-2')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <title>Resources</title>
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          Resources
        </NavLink>

      {activeSection === 'resources' && (
        <>
          {isLoadingResources && (
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-gray-400 dark:text-gray-500">
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <title>Loading</title>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading...
            </div>
          )}

          <ul className="flex flex-wrap sm:flex-col gap-1.5 sm:gap-1">
            {resourceNames.map(resource => {
              const isActive = activeResource === resource;
              const isReadOnly = READ_ONLY_RESOURCES.has(resource);
              return (
                <li key={resource}>
                  <NavLink
                    to={`/${resource}`}
                    className={`block px-3 py-1.5 rounded sm:rounded text-sm whitespace-nowrap ${
                      isActive
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium border border-blue-200 dark:border-blue-800 sm:border-0'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 sm:bg-transparent sm:dark:bg-transparent hover:bg-gray-200 dark:hover:bg-gray-600 sm:hover:bg-gray-100 sm:dark:hover:bg-gray-700'
                    }`}>
                    {resource}
                  </NavLink>
                  {isActive && !isReadOnly && (permissions.canAdd || permissions.canEdit || permissions.canDelete) && (
                    <div className="hidden sm:flex flex-col ml-4 mt-1 gap-0.5">
                      {permissions.canAdd && (
                        <NavLink
                          to={`/${resource}/add`}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                          + Add
                        </NavLink>
                      )}
                      {permissions.canEdit && (
                        <NavLink
                          to={`/${resource}/edit`}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                          Edit
                        </NavLink>
                      )}
                      {permissions.canDelete && (
                        <NavLink
                          to={`/${resource}/delete`}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                          Delete
                        </NavLink>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      </div>

      {/* Metadata section */}
      <div>
        <NavLink to={activeSection === 'metadata' ? `/${resourceNames[0] ?? 'Property'}` : '/metadata'} className={sectionHeaderClass('metadata', 'mb-2')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <title>Metadata</title>
            <path fillRule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          Metadata
        </NavLink>

        {activeSection === 'metadata' && (
          <>
            {isLoadingResources && (
              <div className="flex items-center gap-2 px-3 py-1 text-xs text-gray-400 dark:text-gray-500">
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <title>Loading</title>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading...
              </div>
            )}

            <ul className="flex flex-wrap sm:flex-col gap-1.5 sm:gap-1">
              {resourceNames.map(resource => {
                const isActive = location.pathname === `/metadata/${resource}`;
                return (
                  <li key={resource}>
                    <NavLink
                      to={`/metadata/${resource}`}
                      className={`block px-3 py-1.5 rounded text-sm whitespace-nowrap ${
                        isActive
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium border border-blue-200 dark:border-blue-800 sm:border-0'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 sm:bg-transparent sm:dark:bg-transparent hover:bg-gray-200 dark:hover:bg-gray-600 sm:hover:bg-gray-100 sm:dark:hover:bg-gray-700'
                      }`}>
                      {resource}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Admin section — only show for local server */}
      {isLocal && (
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <title>Admin</title>
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
            Admin
          </h2>
          <NavLink
            to="/admin/data-generator"
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm whitespace-nowrap ${
                isActive
                  ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`
            }>
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <title>Data Generator</title>
              <path fillRule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11.707 4.707a1 1 0 00-1.414-1.414L10 9.586 8.707 8.293a1 1 0 00-1.414 0l-2 2a1 1 0 101.414 1.414L8 10.414l1.293 1.293a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Data Generator
          </NavLink>
        </div>
      )}
    </div>
  );
};
