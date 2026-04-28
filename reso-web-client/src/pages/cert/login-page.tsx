import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/use-auth';
import { useDarkMode } from '../../hooks/use-dark-mode';

// ── Credential persistence via Electron safeStorage ──────────────────

interface SavedCredential {
  readonly username: string;
  readonly password: string;
}

/** New multi-credential key. Stores an array so users can switch logins. */
const CERT_LOGIN_LIST_KEY = 'cert-login-credentials-v2';
/** Legacy single-credential key — read once on first mount, then dropped. */
const CERT_LOGIN_LEGACY_KEY = 'cert-login-credentials';

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

const getStorage = (): ElectronStorage | null =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | null;

const loadAllCredentials = async (): Promise<ReadonlyArray<SavedCredential>> => {
  const storage = getStorage();
  if (!storage) return [];
  const raw = await storage.get(CERT_LOGIN_LIST_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(
        (c): c is SavedCredential =>
          c && typeof c.username === 'string' && typeof c.password === 'string',
      );
    } catch { /* fall through to legacy migration */ }
  }
  // One-time migration from the single-credential key.
  const legacyRaw = await storage.get(CERT_LOGIN_LEGACY_KEY);
  if (!legacyRaw) return [];
  try {
    const legacy = JSON.parse(legacyRaw) as SavedCredential;
    if (legacy?.username && legacy?.password) {
      const list = [legacy];
      await storage.set(CERT_LOGIN_LIST_KEY, JSON.stringify(list));
      await storage.remove(CERT_LOGIN_LEGACY_KEY);
      return list;
    }
  } catch { /* nothing to migrate */ }
  return [];
};

const upsertCredential = async (cred: SavedCredential): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  const existing = await loadAllCredentials();
  const others = existing.filter(c => c.username !== cred.username);
  const list = [cred, ...others]; // most-recently-used first
  await storage.set(CERT_LOGIN_LIST_KEY, JSON.stringify(list));
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
  const [savedCredentials, setSavedCredentials] = useState<ReadonlyArray<SavedCredential>>([]);
  const [showCredentials, setShowCredentials] = useState(false);
  const formRef = useRef<HTMLDivElement | null>(null);

  // Load all saved credentials on mount; pre-fill the most-recent one.
  useEffect(() => {
    loadAllCredentials().then(list => {
      setSavedCredentials(list);
      const mostRecent = list[0];
      if (mostRecent) {
        setUsername(mostRecent.username);
        setPassword(mostRecent.password);
      }
    });
  }, []);

  // Close the credentials dropdown on outside click.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setShowCredentials(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Filter saved credentials by what's typed in the username field.
  const filteredCredentials = savedCredentials.filter(c =>
    c.username.toLowerCase().includes(username.toLowerCase()),
  );

  const pickCredential = (cred: SavedCredential): void => {
    setUsername(cred.username);
    setPassword(cred.password);
    setShowCredentials(false);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username || !password || isSigningIn) return;
    try {
      await signIn(username, password);
      // Append (or move-to-front) on successful login so the dropdown
      // stays current and the most-recent user pre-fills next time.
      await upsertCredential({ username, password });
      setSavedCredentials(prev => [
        { username, password },
        ...prev.filter(c => c.username !== username),
      ]);
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
            <div ref={formRef} className="relative space-y-4">
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
                  onFocus={() => setShowCredentials(true)}
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
                  onFocus={() => setShowCredentials(true)}
                  disabled={isSigningIn}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60 transition-colors"
                />
              </div>

              {showCredentials && filteredCredentials.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Saved logins"
                  className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
                >
                  {filteredCredentials.map((c) => (
                    <li key={c.username}>
                      <button
                        type="button"
                        onClick={() => pickCredential(c)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:bg-gray-100 dark:focus:bg-gray-700"
                      >
                        <span className="font-medium">{c.username}</span>
                        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                          {'•'.repeat(Math.min(c.password.length, 8))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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
