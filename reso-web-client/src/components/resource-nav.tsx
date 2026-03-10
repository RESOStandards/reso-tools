import { useMemo } from 'react';
import { NavLink, useLocation, useParams } from 'react-router';
import { useServer } from '../context/server-context';
import { READ_ONLY_RESOURCES } from '../types';

/** Chevron icon that rotates when open. */
const Chevron = ({ open }: { readonly open: boolean }) => (
  <svg
    className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
    viewBox="0 0 20 20"
    fill="currentColor">
    <title>{open ? 'Collapse' : 'Expand'}</title>
    <path
      fillRule="evenodd"
      d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
      clipRule="evenodd"
    />
  </svg>
);

type Section = 'home' | 'resources' | 'metadata';

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
    : location.pathname.startsWith('/metadata') ? 'metadata'
    : 'resources';

  const sectionHeaderClass = (section: Section) =>
    `flex items-center gap-1.5 w-full text-xs font-semibold uppercase tracking-wider mb-2 cursor-pointer select-none ${
      activeSection === section
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
    }`;

  return (
    <div>
      {/* Home link */}
      <NavLink to="/" className={sectionHeaderClass('home')}>
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <title>Home</title>
          <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
        </svg>
        Home
      </NavLink>
      {/* Resources section */}
      <NavLink to={activeSection === 'resources' ? '/metadata' : `/${resourceNames[0] ?? 'Property'}`} className={sectionHeaderClass('resources')}>
        <Chevron open={activeSection === 'resources'} />
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

      {/* Metadata Explorer section */}
      <div className={`${activeSection === 'resources' ? 'mt-6 pt-4 border-t border-gray-200 dark:border-gray-700' : 'mt-4'}`}>
        <NavLink to={activeSection === 'metadata' ? `/${resourceNames[0] ?? 'Property'}` : '/metadata'} className={sectionHeaderClass('metadata')}>
          <Chevron open={activeSection === 'metadata'} />
          Metadata Explorer
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
        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Admin</h2>
          <NavLink
            to="/admin/data-generator"
            className={({ isActive }) =>
              `block px-3 py-1.5 rounded text-sm whitespace-nowrap ${
                isActive
                  ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`
            }>
            Data Generator
          </NavLink>
        </div>
      )}
    </div>
  );
};
