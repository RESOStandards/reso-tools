import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from '../context/auth-context';

/**
 * Access the cert auth context. Throws if used outside an AuthProvider so
 * accidental misuse fails loudly instead of silently returning undefined.
 */
export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return ctx;
};
