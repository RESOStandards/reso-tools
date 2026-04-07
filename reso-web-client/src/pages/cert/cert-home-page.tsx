import { Navigate } from 'react-router';
import { useAuth } from '../../hooks/use-auth';

/**
 * Minimal landing page for the Cert workspace. Used during Phase A as the
 * destination after a successful sign-in until the proper Cert layout
 * (sidebar nav, Endorsements list, etc.) lands in the next slice.
 */
export const CertHomePage = () => {
  const { user, isAuthenticated, signOut } = useAuth();

  if (!isAuthenticated || !user) {
    return <Navigate to="/cert/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 px-4 py-12 transition-colors">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                Welcome, {user.fullName}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {user.email}
                {user.isAdmin && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    Admin
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              Sign out
            </button>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              You&apos;re signed in to the Cert workspace. The Endorsements
              list, Dashboard, and Variations Review screens land in the next
              slice of v0.8 work.
            </p>
            <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
              Cert API key: <span className="font-mono">{user.token.slice(0, 8)}…</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
