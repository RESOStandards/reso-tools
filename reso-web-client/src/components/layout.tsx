import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { clearConfigCache } from '../api/config';
import { setApiConfig } from '../api/client';
import { clearMetadataCache } from '../api/metadata';
import { useServer } from '../context/server-context';
import { useDarkMode } from '../hooks/use-dark-mode';
import { ResourceNav } from './resource-nav';
import { ServerSwitcher } from './server-switcher';

const LOGO_LIGHT = 'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_Blue.png';
const LOGO_DARK = 'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_White.png';

/** Derives the current page indicator from the URL path. */
const getPageIndicator = (pathname: string, resource?: string): string | null => {
  if (pathname === '/') return 'Home';
  if (!resource) return null;
  if (pathname.includes('/add')) return 'Add';
  if (pathname.includes('/edit')) return 'Edit';
  if (pathname.includes('/delete')) return 'Delete';
  // Check if it's a detail page (/:resource/:key but not /add, /edit, /delete)
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === resource && !['add', 'edit', 'delete'].includes(parts[1])) return 'Detail';
  return 'Search';
};

/** App shell with responsive sidebar nav, RESO branding, dark mode toggle, and main content. */
export const Layout = () => {
  const { isDark, toggle } = useDarkMode();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { resource } = useParams<{ resource: string }>();
  const location = useLocation();
  const pageIndicator = getPageIndicator(location.pathname, resource);
  const navigate = useNavigate();
  const { activeServer, resources } = useServer();
  const prevServerIdRef = useRef(activeServer.id);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Sync API client config and clear caches when server changes
  useEffect(() => {
    setApiConfig(activeServer.baseUrl, activeServer.token);
    clearMetadataCache();
    clearConfigCache();
  }, [activeServer.id]);

  // Guard: when server changes and new resources load, validate the current route
  useEffect(() => {
    if (!resources || resources.length === 0) return;

    // Only redirect on actual server switches, not initial load
    if (prevServerIdRef.current === activeServer.id) {
      prevServerIdRef.current = activeServer.id;
      return;
    }
    prevServerIdRef.current = activeServer.id;

    const resourceExists = resource && resources.some(r => r.name === resource);

    if (resource && !resourceExists) {
      // Current resource doesn't exist on the new server — go to first available
      navigate(`/${resources[0].name}`, { replace: true });
    } else if (resource && resourceExists && location.pathname !== `/${resource}`) {
      // Resource exists but we're on a detail/add/edit/delete page — go to search
      // (the specific record or context won't carry over between servers)
      navigate(`/${resource}`, { replace: true });
    }
  }, [resources, activeServer.id, resource, location.pathname, navigate]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900 transition-colors">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Hamburger menu — mobile only */}
            <button
              type="button"
              onClick={() => setSidebarOpen(o => !o)}
              className="sm:hidden p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
              aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}>
              {sidebarOpen ? (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                  <title>Close menu</title>
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                  <title>Open menu</title>
                  <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                </svg>
              )}
            </button>
            {/* RESO Logo — links to home */}
            <NavLink to="/" className="shrink-0">
              <img src={isDark ? LOGO_DARK : LOGO_LIGHT} alt="RESO" className="h-8 sm:h-10" />
            </NavLink>
            {/* Server switcher replaces static title */}
            <ServerSwitcher />
            {pageIndicator && <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline">/ {pageIndicator}</span>}
          </div>

          <div className="flex items-center gap-3">
          {/* Dark mode toggle */}
          <button
            type="button"
            onClick={toggle}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
            {isDark ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
                role="img"
                aria-hidden="true">
                <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zM10 7a3 3 0 100 6 3 3 0 000-6zM15.657 5.404a.75.75 0 10-1.06-1.06l-1.061 1.06a.75.75 0 001.06 1.06l1.06-1.06zM6.464 14.596a.75.75 0 10-1.06-1.06l-1.06 1.06a.75.75 0 001.06 1.06l1.06-1.06zM18 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-1.06-1.061a.75.75 0 10-1.06 1.06l1.06 1.06zM5.404 6.464a.75.75 0 001.06-1.06l-1.06-1.06a.75.75 0 10-1.06 1.06l1.06 1.06z" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
                role="img"
                aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="sm:hidden fixed inset-0 z-30 bg-black/30"
            onClick={() => setSidebarOpen(false)}
            onKeyDown={e => e.key === 'Escape' && setSidebarOpen(false)}
            role="button"
            tabIndex={-1}
            aria-label="Close sidebar"
          />
        )}

        {/* Sidebar — slide-over on mobile, fixed on desktop */}
        <nav className={`
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          sm:translate-x-0
          fixed sm:static z-40 sm:z-auto
          w-64 sm:w-56 h-full
          shrink-0 bg-white dark:bg-gray-800
          border-r border-gray-200 dark:border-gray-700
          p-4 overflow-y-auto
          transition-transform duration-200 ease-in-out
        `}>
          <ResourceNav />
        </nav>

        {/* Main content — each page manages its own scrolling */}
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
