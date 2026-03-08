import { useMemo } from 'react';
import { NavLink, useParams } from 'react-router';
import { useServer } from '../context/server-context';
import { READ_ONLY_RESOURCES, TARGET_RESOURCES } from '../types';

/** Sidebar navigation with resource links and CRUD sub-links. */
export const ResourceNav = () => {
  const { resource: activeResource } = useParams<{ resource: string }>();
  const { resources, isLocal, isLoadingResources } = useServer();

  // Use hardcoded TARGET_RESOURCES for local server, dynamic list for external
  const resourceNames = useMemo(
    () => (isLocal ? [...TARGET_RESOURCES] : (resources?.map(r => r.name) ?? [])),
    [isLocal, resources]
  );

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Resources</h2>

      {isLoadingResources && !isLocal && (
        <p className="text-xs text-gray-400 dark:text-gray-500 px-3 py-1">Loading resources...</p>
      )}

      <ul className="flex flex-row sm:flex-col gap-1 overflow-x-auto sm:overflow-visible">
        {resourceNames.map(resource => {
          const isActive = activeResource === resource;
          const isReadOnly = isLocal && READ_ONLY_RESOURCES.has(resource);
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
              {isActive && !isReadOnly && (
                <div className="hidden sm:flex flex-col ml-4 mt-1 gap-0.5">
                  <NavLink
                    to={`/${resource}/add`}
                    className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                    + Add
                  </NavLink>
                  <NavLink
                    to={`/${resource}/edit`}
                    className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                    Edit
                  </NavLink>
                  <NavLink
                    to={`/${resource}/delete`}
                    className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-0.5">
                    Delete
                  </NavLink>
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
