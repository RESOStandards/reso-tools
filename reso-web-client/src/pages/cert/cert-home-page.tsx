import { NavLink } from 'react-router';
import { AuthPill } from '../../components/cert/auth-pill';
import { EndorsementList } from '../../components/cert/endorsement-list';
import { useDarkMode } from '../../hooks/use-dark-mode';

const LOGO_LIGHT =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_Blue.png';
const LOGO_DARK =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_White.png';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

/**
 * Public Cert workspace landing page.
 *
 * The page chrome is intentionally split:
 *
 * - The top section header (logo, theme, auth pill) sits at the top
 *   and stays put.
 * - The Endorsements list owns its own sticky sub-chrome (title row,
 *   search/sort/filters, drawer, active pills) so the controls stay
 *   visible while the list scrolls underneath.
 *
 * Public-by-default — every Cert section page renders for everyone.
 * Sign-in is opt-in via the auth pill in the upper right and unlocks
 * additional capabilities (status mutation, My Results filter,
 * variations review with edit).
 */
export const CertHomePage = () => {
  const { isDark, toggle } = useDarkMode();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-gray-800/95 backdrop-blur border-b border-gray-200 dark:border-gray-700">
        <div className={`${PAGE_CONTAINER} py-3 flex items-center justify-between`}>
          <div className="flex items-center gap-4">
            <NavLink to="/" className="shrink-0" aria-label="Back to RESO Tools">
              <img
                src={isDark ? LOGO_DARK : LOGO_LIGHT}
                alt="RESO"
                className="h-8"
              />
            </NavLink>
            <div className="hidden sm:block w-px h-7 bg-gray-200 dark:bg-gray-700" />
            <span className="hidden sm:block text-sm font-medium text-gray-700 dark:text-gray-200">
              Certification
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggle}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
            >
              {isDark ? (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zM10 7a3 3 0 100 6 3 3 0 000-6zM15.657 5.404a.75.75 0 10-1.06-1.06l-1.061 1.06a.75.75 0 001.06 1.06l1.06-1.06zM6.464 14.596a.75.75 0 10-1.06-1.06l-1.06 1.06a.75.75 0 001.06 1.06l1.06-1.06zM18 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-1.06-1.061a.75.75 0 10-1.06 1.06l1.06 1.06zM5.404 6.464a.75.75 0 001.06-1.06l-1.06-1.06a.75.75 0 10-1.06 1.06l1.06 1.06z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
            <AuthPill />
          </div>
        </div>
      </header>

      <main>
        <EndorsementList containerClassName={PAGE_CONTAINER} />
      </main>
    </div>
  );
};
