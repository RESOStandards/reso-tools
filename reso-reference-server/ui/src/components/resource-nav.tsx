import { useMemo } from 'react';
import { NavLink, useParams } from 'react-router';
import { useServer } from '../context/server-context';
import { READ_ONLY_RESOURCES } from '../types';

/** Sidebar navigation with resource links and CRUD sub-links. */
export const ResourceNav = () => {
  const { resource: activeResource } = useParams<{ resource: string }>();
  const { resources, isLocal, isLoadingResources, permissions } = useServer();

  const resourceNames = useMemo(
    () => resources?.map(r => r.name) ?? [],
    [resources]
  );

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Resources</h2>

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

      <ul className="flex flex-row sm:flex-col gap-1 overflow-x-auto sm:overflow-visible">
        {resourceNames.map(resource => {
          const isActive = activeResource === resource;
          const isReadOnly = READ_ONLY_RESOURCES.has(resource);
          return (
            <li key={resource}>
              <NavLink
                to={`/${resource}`}
                className={`block px-3 py-1.5 rounded text-sm whitespace-nowrap ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
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
