/**
 * RequireAuth — route gate that redirects to /cert/login when the
 * user isn't authenticated. Preserves the originally-requested path
 * in router state so the login page can redirect the user back after
 * they sign in (deep-link survival).
 *
 * Auth state changes (sign-out from a protected page) trigger a
 * re-render here → redirect → previous page unmounts → all its
 * React state, hooks, and in-flight requests are torn down. That
 * also fixes the FBS→Grid data-leak class of bug: stale data from
 * the previous user can never render under the new user's session
 * because the components that hold it never existed in the new
 * session's React tree.
 */

import { useContext } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { AuthContext } from '../../context/auth-context';

export const RequireAuth = () => {
  const auth = useContext(AuthContext);
  const location = useLocation();
  const isAuthenticated = auth?.isAuthenticated ?? false;

  if (!isAuthenticated) {
    // Shape `from: { pathname }` matches the LocationState the login
    // page reads to restore the original path after sign-in.
    return (
      <Navigate
        to="/cert/login"
        replace
        state={{ from: { pathname: `${location.pathname}${location.search}${location.hash}` } }}
      />
    );
  }

  return <Outlet />;
};
