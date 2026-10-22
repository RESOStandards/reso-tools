import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnvFile, parseEnvFile } from '../../src/cli/env-file.js';
import { __clearSecretsForTest, maskSecrets } from '../../src/cli/secrets.js';

const inTempDir = (): string => {
  // Resolved, because macOS reports the temp directory through a symlink (/var -> /private/var)
  // and `process.cwd()` answers with the real path once chdir'd. Comparing the two unresolved
  // fails for a reason that has nothing to do with the code under test.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reso-env-')));
  process.chdir(dir);
  return dir;
};

describe('parseEnvFile', () => {
  it('reads pairs and ignores blanks and comments', () => {
    const parsed = parseEnvFile('# a comment\n\nCLIENT_ID=someone@reso.org\n');
    expect([...parsed]).toEqual([['CLIENT_ID', 'someone@reso.org']]);
  });

  it('splits on the first = only, so a base64 value survives its padding', () => {
    const parsed = parseEnvFile('CLIENT_SECRET=YWJjOmRlZg==\n');
    expect(parsed.get('CLIENT_SECRET')).toBe('YWJjOmRlZg==');
  });

  it('accepts an export prefix and strips wrapping quotes', () => {
    const parsed = parseEnvFile('export TOKEN_URI="https://example.org/token"\n');
    expect(parsed.get('TOKEN_URI')).toBe('https://example.org/token');
  });

  it('ignores a line that is not a valid assignment', () => {
    expect([...parseEnvFile('just some text\n=novalue\n9NOT_A_KEY=x\n')]).toEqual([]);
  });
});

describe('loadEnvFile', () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    __clearSecretsForTest();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
  });

  it('prefers credentials.env, the name the site downloads', () => {
    const dir = inTempDir();
    writeFileSync(join(dir, 'credentials.env'), 'CLIENT_ID=from-credentials\n');
    writeFileSync(join(dir, '.env'), 'CLIENT_ID=from-dotenv\n');
    // biome-ignore lint/performance/noDelete: unsetting the variable IS the condition under test
    delete process.env.CLIENT_ID;

    const loaded = loadEnvFile();

    expect(loaded.path).toBe(join(dir, 'credentials.env'));
    expect(process.env.CLIENT_ID).toBe('from-credentials');
  });

  it('never overwrites a variable the environment already carries', () => {
    const dir = inTempDir();
    writeFileSync(join(dir, 'credentials.env'), 'CLIENT_ID=from-file\n');
    process.env.CLIENT_ID = 'from-shell';

    const loaded = loadEnvFile();

    expect(process.env.CLIENT_ID).toBe('from-shell');
    expect(loaded.skipped).toContain('CLIENT_ID');
    expect(loaded.applied).not.toContain('CLIENT_ID');
  });

  it('masks a secret from the file, and leaves the token endpoint readable', () => {
    const dir = inTempDir();
    writeFileSync(join(dir, 'credentials.env'), 'CLIENT_SECRET=supersecretvaluethatislong\nTOKEN_URI=https://example.org/token\n');
    // biome-ignore lint/performance/noDelete: unsetting the variable IS the condition under test
    delete process.env.CLIENT_SECRET;
    // biome-ignore lint/performance/noDelete: unsetting the variable IS the condition under test
    delete process.env.TOKEN_URI;

    loadEnvFile();

    expect(maskSecrets('secret is supersecretvaluethatislong')).not.toContain('supersecretvaluethatislong');
    expect(maskSecrets('endpoint is https://example.org/token')).toContain('https://example.org/token');
  });

  it('throws when a named file does not exist, rather than running without it', () => {
    inTempDir();
    expect(() => loadEnvFile('nope.env')).toThrow(/does not exist/);
  });

  it('is content with no file at all', () => {
    inTempDir();
    expect(loadEnvFile()).toEqual({ path: null, applied: [], skipped: [] });
  });
});
