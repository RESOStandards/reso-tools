import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../hooks/use-auth';
import { useDarkMode } from '../../hooks/use-dark-mode';
import { secureGetJson } from '../../api/secure-storage';

const LOGO_LIGHT =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_Blue.png';
const LOGO_DARK =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_White.png';

interface LoginModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a successful sign-in (after the modal has closed). */
  readonly onSuccess?: () => void;
}

/**
 * In-app sign-in modal. Pops over whatever Cert view the user is on,
 * traps focus, dismissible by Escape or backdrop click. On success
 * the modal closes and the underlying view re-renders against the
 * new auth state — no navigation, no scroll loss, no filter loss.
 */
export const LoginModal = ({ open, onClose, onSuccess }: LoginModalProps) => {
  const { isDark } = useDarkMode();
  const { signIn, isSigningIn, error } = useAuth();
  const usernameRef = useRef<HTMLInputElement>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Pre-fill from persisted credentials when the modal opens
  useEffect(() => {
    if (!open) {
      setUsername('');
      setPassword('');
      return;
    }
    // Defer focus to next tick so the input is mounted
    const focusTimer = setTimeout(() => usernameRef.current?.focus(), 10);

    // Load saved credentials for autofill
    secureGetJson<{ username: string; password: string }>('reso-cert-credentials-v1')
      .then(creds => {
        if (creds?.username) setUsername(creds.username);
        if (creds?.password) setPassword(creds.password);
      })
      .catch(() => {});

    return () => clearTimeout(focusTimer);
  }, [open]);

  // Escape to dismiss + lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSigningIn) onClose();
    };
    document.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, isSigningIn, onClose]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username || !password || isSigningIn) return;
    try {
      await signIn(username, password);
      onClose();
      onSuccess?.();
    } catch {
      // Error surfaced via the auth context. User stays in the modal
      // to correct credentials and retry.
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 py-24 sm:py-32 backdrop-blur-sm bg-gray-900/40 dark:bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSigningIn) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      <div className="w-full max-w-sm">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-8 pt-8 pb-2 flex justify-center">
            <img
              src={isDark ? LOGO_DARK : LOGO_LIGHT}
              alt="RESO"
              className="h-9"
            />
          </div>

          <div className="px-8 pt-4 pb-8">
            <h2
              id="login-modal-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100 text-center mb-1"
            >
              Sign in to Certification
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-6">
              Use your RESO Cert credentials
            </p>

            <form onSubmit={handleSubmit} className="space-y-4" name="reso-cert-login" autoComplete="on">
              <div>
                <label
                  htmlFor="login-modal-username"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  Username
                </label>
                <input
                  ref={usernameRef}
                  id="login-modal-username"
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
                  htmlFor="login-modal-password"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  Password
                </label>
                <input
                  id="login-modal-password"
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

              <div className="pt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSigningIn}
                  className="flex-1 py-2.5 px-4 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 dark:focus:ring-offset-gray-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSigningIn || !username || !password}
                  className="flex-1 py-2.5 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 cursor-pointer disabled:cursor-not-allowed"
                >
                  {isSigningIn ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Signing in
                    </span>
                  ) : 'Sign in'}
                </button>
              </div>
            </form>
          </div>

          <div className="px-8 py-3 bg-gray-50 dark:bg-gray-900/40 border-t border-gray-100 dark:border-gray-700/50 text-center">
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              Connecting to <span className="font-mono">certqa.reso.org</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
