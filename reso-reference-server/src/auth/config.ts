/**
 * Role-based authentication configuration for the reference server.
 *
 * Supports three roles with hierarchical permissions:
 * - admin: full access including admin endpoints
 * - write: read + create/update/delete
 * - read: query and read only
 *
 * Tokens are configured via environment variables. Defaults are for
 * development only — do not use in production.
 */

import { timingSafeEqual } from 'node:crypto';

/** Authentication roles in ascending order of privilege. */
export type AuthRole = 'read' | 'write' | 'admin';

/** Role hierarchy — higher index = more privilege. */
const ROLE_HIERARCHY: ReadonlyArray<AuthRole> = ['read', 'write', 'admin'];

/** Returns true if `role` has at least the privileges of `minimumRole`. */
export const hasRole = (role: AuthRole, minimumRole: AuthRole): boolean =>
  ROLE_HIERARCHY.indexOf(role) >= ROLE_HIERARCHY.indexOf(minimumRole);

/** Auth configuration derived from environment variables. */
export interface AuthTokenConfig {
  readonly adminToken: string;
  readonly writeToken: string;
  readonly readToken: string;
  readonly authRequired: boolean;
}

/** Entry stored alongside each dynamic token to track expiry. */
interface DynamicTokenEntry {
  readonly role: AuthRole;
  readonly expiresAt: number;
}

/** Default TTL for dynamic tokens: 1 hour (in milliseconds). */
const DYNAMIC_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Interval for periodic expired-token cleanup: 60 seconds. */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** In-memory map of dynamic tokens (from mock OAuth) to role + expiry. */
const dynamicTokens = new Map<string, DynamicTokenEntry>();

/** Removes all expired entries from the dynamic token map. */
const sweepExpiredTokens = (): void => {
  const now = Date.now();
  for (const [key, entry] of dynamicTokens) {
    if (entry.expiresAt <= now) {
      dynamicTokens.delete(key);
    }
  }
};

/** Periodic cleanup of expired dynamic tokens. */
const cleanupTimer = setInterval(sweepExpiredTokens, CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // allow the process to exit naturally

/** Registers a dynamic token with a given role (used by mock OAuth). */
export const registerDynamicToken = (token: string, role: AuthRole): void => {
  dynamicTokens.set(token, { role, expiresAt: Date.now() + DYNAMIC_TOKEN_TTL_MS });
};

/** Loads auth configuration from environment variables. */
export const loadAuthConfig = (): AuthTokenConfig => ({
  adminToken: process.env.ADMIN_TOKEN ?? 'admin-token',
  writeToken: process.env.WRITE_TOKEN ?? 'write-token',
  readToken: process.env.READ_TOKEN ?? 'read-token',
  authRequired: process.env.AUTH_REQUIRED === 'true'
});

/**
 * Constant-time comparison of two token strings.
 * Returns true only when both strings are the same length and have
 * identical content, using crypto.timingSafeEqual to prevent timing attacks.
 */
const safeTokenEquals = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Resolves a bearer token to an auth role.
 * Checks static tokens first (constant-time), then dynamic tokens from mock OAuth.
 * Returns null if the token is not recognized.
 */
export const resolveRole = (token: string, config: AuthTokenConfig): AuthRole | null => {
  if (safeTokenEquals(token, config.adminToken)) return 'admin';
  if (safeTokenEquals(token, config.writeToken)) return 'write';
  if (safeTokenEquals(token, config.readToken)) return 'read';

  // Check dynamic tokens (from mock OAuth)
  const entry = dynamicTokens.get(token);
  if (entry) {
    if (entry.expiresAt <= Date.now()) {
      dynamicTokens.delete(token);
      return null;
    }
    return entry.role;
  }

  return null;
};
