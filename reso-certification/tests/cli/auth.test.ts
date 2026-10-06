import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv, resolveCliAuth } from '../../src/cli/auth.js';

describe('resolveCliAuth', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  describe('Level 1: CLI flags', () => {
    it('resolves bearer token from --auth-token', () => {
      const result = resolveCliAuth({ authToken: 'my-token' });
      expect(result).toEqual({ mode: 'token', authToken: 'my-token' });
    });

    it('resolves client credentials from flags', () => {
      const result = resolveCliAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token'
      });
      expect(result).toEqual({
        mode: 'client_credentials',
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token'
      });
    });

    it('throws when --auth-token and --client-id are both provided', () => {
      expect(() => resolveCliAuth({ authToken: 'token', clientId: 'id' })).toThrow('Cannot use --auth-token together with');
    });

    it('throws when client credentials are incomplete', () => {
      expect(() => resolveCliAuth({ clientId: 'id', clientSecret: 'secret' })).toThrow('--client-id, --client-secret, and --token-url');
    });

    it('flags take priority over config auth', () => {
      const configAuth = { mode: 'token' as const, authToken: 'config-token' };
      const result = resolveCliAuth({ authToken: 'flag-token' }, configAuth);
      expect(result).toEqual({ mode: 'token', authToken: 'flag-token' });
    });

    it('flags take priority over env vars', () => {
      process.env.RESO_AUTH_TOKEN = 'env-token';
      const result = resolveCliAuth({ authToken: 'flag-token' });
      expect(result).toEqual({ mode: 'token', authToken: 'flag-token' });
    });
  });

  describe('Level 2: Config entry auth', () => {
    it('uses config auth when no flags provided', () => {
      const configAuth = { mode: 'token' as const, authToken: 'config-token' };
      const result = resolveCliAuth({}, configAuth);
      expect(result).toEqual({ mode: 'token', authToken: 'config-token' });
    });

    it('uses config client credentials when no flags', () => {
      const configAuth = {
        mode: 'client_credentials' as const,
        clientId: 'cfg-id',
        clientSecret: 'cfg-secret',
        tokenUrl: 'https://cfg.example.com/token'
      };
      const result = resolveCliAuth({}, configAuth);
      expect(result).toEqual(configAuth);
    });

    it('config auth takes priority over env vars', () => {
      process.env.RESO_AUTH_TOKEN = 'env-token';
      const configAuth = { mode: 'token' as const, authToken: 'config-token' };
      const result = resolveCliAuth({}, configAuth);
      expect(result).toEqual({ mode: 'token', authToken: 'config-token' });
    });
  });

  describe('Level 3: Environment variables', () => {
    it('falls back to RESO_AUTH_TOKEN env var', () => {
      process.env.RESO_AUTH_TOKEN = 'env-token';
      const result = resolveCliAuth({});
      expect(result).toEqual({ mode: 'token', authToken: 'env-token' });
    });

    it('falls back to RESO_CLIENT_ID/SECRET/TOKEN_URI env vars', () => {
      process.env.RESO_CLIENT_ID = 'env-id';
      process.env.RESO_CLIENT_SECRET = 'env-secret';
      process.env.RESO_TOKEN_URI = 'https://env.example.com/token';
      const result = resolveCliAuth({});
      expect(result).toEqual({
        mode: 'client_credentials',
        clientId: 'env-id',
        clientSecret: 'env-secret',
        tokenUrl: 'https://env.example.com/token'
      });
    });

    it('throws clear error when nothing configured', () => {
      // Ensure no RESO_ env vars are set
      // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
      // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
      // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
      delete process.env.RESO_AUTH_TOKEN;
      // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
      // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
      // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
      delete process.env.RESO_CLIENT_ID;
      // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
      // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
      // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
      delete process.env.RESO_CLIENT_SECRET;
      // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
      // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
      // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
      delete process.env.RESO_TOKEN_URI;

      expect(() => resolveCliAuth({})).toThrow('No authentication configured');
    });
  });
});

describe('loadDotEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('does not throw when .env file does not exist', () => {
    // An array, not a bare string. `loadDotEnv` takes ReadonlyArray<string> and does
    // `for (const dir of paths)` — handed a string that iterates its CHARACTERS, so this
    // previously exercised 17 single-character directories rather than one missing path.
    expect(() => loadDotEnv(['/nonexistent/path'])).not.toThrow();
  });

  it('does not overwrite existing env vars', () => {
    process.env.RESO_AUTH_TOKEN = 'existing-value';
    // Even if a .env file had RESO_AUTH_TOKEN, it should not overwrite
    loadDotEnv(['/nonexistent/path']);
    expect(process.env.RESO_AUTH_TOKEN).toBe('existing-value');
  });
});
