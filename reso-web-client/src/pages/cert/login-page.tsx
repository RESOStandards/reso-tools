import { useState, useEffect, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/use-auth';
import { useDarkMode } from '../../hooks/use-dark-mode';

// ── Credential persistence via Electron safeStorage ──────────────────

const CERT_LOGIN_KEY = 'cert-login-credentials';

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
}

const getStorage = (): ElectronStorage | null =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | null;

const saveLoginCredentials = async (username: string, password: string): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.set(CERT_LOGIN_KEY, JSON.stringify({ username, password }));
};

const loadLoginCredentials = async (): Promise<{ username: string; password: string } | null> => {
  const storage = getStorage();
  if (!storage) return null;
  const raw = await storage.get(CERT_LOGIN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as { username: string; password: string }; }
  catch { return null; }
};

const LOGO_LIGHT =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_Blue.png';
const LOGO_DARK =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_White.png';

interface LocationState {
  from?: { pathname: string };
}

/**
 * Sign-in screen for the Cert workspace.
 *
 * Centered card on a soft neutral background. Two inputs, one button, an
 * error region. Calls the cert API login + OAuth2 token endpoints via the
 * auth context, then redirects to the destination the user was originally
 * trying to reach (or /cert if they came here directly).
 */
export const LoginPage = () => {
  const { isDark } = useDarkMode();
  const { signIn, isSigningIn, error } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Pre-fill from safeStorage on mount
  useEffect(() => {
    loadLoginCredentials().then(creds => {
      if (creds) {
        setUsername(creds.username);
        setPassword(creds.password);
      }
    });
  }, []);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username || !password || isSigningIn) return;
    try {
      await signIn(username, password);
      // Save credentials on successful login
      await saveLoginCredentials(username, password);
      const state = location.state as LocationState | null;
      const target = state?.from?.pathname ?? '/cert';
      navigate(target, { replace: true });
    } catch {
      // Error is surfaced via the auth context's `error` state — no
      // additional handling needed here. Keeping the user on the page
      // lets them correct credentials and retry.
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4 py-12 transition-colors">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <img
            src={isDark ? LOGO_DARK : LOGO_LIGHT}
            alt="RESO"
            className="h-12"
          />
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 text-center mb-1">
            Sign in to Certification
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-7">
            Use your RESO Cert credentials
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isSigningIn}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60 transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSigningIn}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60 transition-colors"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-lg px-3 py-2"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSigningIn || !username || !password}
              className="w-full py-2.5 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
            >
              {isSigningIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-xs text-gray-400 dark:text-gray-500">
          Connecting to{' '}
          <span className="font-mono">certqa.reso.org</span>
        </p>
      </div>
    </div>
  );
};
