import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapEnv, defaultEnvFiles, firstExisting, loadEnvFile } from '../../src/cli/env-file.js';
import { __clearSecretsForTest, maskSecrets } from '../../src/cli/secrets.js';

/** Variables these tests set, cleared around each one so a test never sees another's. */
const KEYS = ['CLIENT_ID', 'CLIENT_SECRET', 'TOKEN_URI', 'RESO_SERVICES_URL', 'FROM_FILE', 'FROM_ROOT'];

// Resolved, because macOS reports the temp directory through a symlink (/var -> /private/var).
const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'reso-env-')));

const write = (dir: string, name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  __clearSecretsForTest();
});
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('loadEnvFile', () => {
  it('reads pairs with Node’s own parser: comments, an export prefix, quotes and base64 padding', () => {
    const dir = tempDir();
    const path = write(dir, 'credentials.env', '# a comment\n\nexport CLIENT_ID="someone@reso.org"\nCLIENT_SECRET=YWJjOmRlZg==\n');

    expect(loadEnvFile(path)).toEqual({ path, applied: ['CLIENT_ID', 'CLIENT_SECRET'], skipped: [] });
    expect(process.env.CLIENT_ID).toBe('someone@reso.org');
    expect(process.env.CLIENT_SECRET).toBe('YWJjOmRlZg==');
  });

  it('never overwrites a variable the environment already carries', () => {
    process.env.TOKEN_URI = 'https://from-the-shell.example/token';
    const path = write(tempDir(), '.env', 'TOKEN_URI=https://from-the-file.example/token\nFROM_FILE=1\n');

    expect(loadEnvFile(path)).toMatchObject({ applied: ['FROM_FILE'], skipped: ['TOKEN_URI'] });
    expect(process.env.TOKEN_URI).toBe('https://from-the-shell.example/token');
  });

  it('masks a secret from the file, and leaves the token endpoint readable', () => {
    const path = write(tempDir(), 'credentials.env', 'CLIENT_SECRET=sentinel-secret-b71c\nTOKEN_URI=https://auth.example/token\n');

    loadEnvFile(path);

    expect(maskSecrets('secret sentinel-secret-b71c at https://auth.example/token')).not.toContain('sentinel-secret-b71c');
    expect(maskSecrets('https://auth.example/token')).toBe('https://auth.example/token');
  });
});

describe('where the CLI looks', () => {
  it('prefers credentials.env, the name the site downloads, over .env in the working directory', () => {
    const cwd = tempDir();
    write(cwd, '.env', 'FROM_FILE=dotenv\n');
    write(cwd, 'credentials.env', 'FROM_FILE=credentials\n');

    expect(firstExisting(defaultEnvFiles({ cwd, roots: [] }))).toBe(join(cwd, 'credentials.env'));
  });

  it('looks in the working directory before its own package and repository, and reads only .env there', () => {
    const cwd = tempDir();
    const root = tempDir();
    write(root, '.env', 'FROM_ROOT=1\n');
    write(root, 'credentials.env', 'FROM_ROOT=2\n');

    expect(defaultEnvFiles({ cwd, roots: [root] })).toEqual([join(cwd, 'credentials.env'), join(cwd, '.env'), join(root, '.env')]);
    expect(firstExisting(defaultEnvFiles({ cwd, roots: [root] }))).toBe(join(root, '.env'));
  });
});

describe('bootstrapEnv', () => {
  it('reads the first default that exists, and is content with none', () => {
    const cwd = tempDir();
    expect(bootstrapEnv({ cwd, roots: [] })).toEqual({});

    write(cwd, '.env', 'FROM_FILE=1\n');
    expect(bootstrapEnv({ cwd, roots: [] }).load?.path).toBe(join(cwd, '.env'));
    expect(process.env.FROM_FILE).toBe('1');
  });

  it('returns a file it cannot read as an error rather than skipping it, or throwing while the CLI loads', () => {
    // A credentials file the CLI silently skipped would leave the run authenticating as whatever came next.
    const cwd = tempDir();
    mkdirSync(join(cwd, 'credentials.env'));
    write(cwd, '.env', 'FROM_FILE=1\n');

    const result = bootstrapEnv({ cwd, roots: [] });

    expect(result.error).toContain(`Could not read ${join(cwd, 'credentials.env')}`);
    expect(result.load).toBeUndefined();
    expect(process.env.FROM_FILE).toBeUndefined();
  });
});

describe('the CLI reads its file before anything else loads', () => {
  it('imports env-bootstrap first, so modules that read variables as they load see the file', () => {
    // Legacy modules destructure variables such as RESO_SERVICES_URL at module load. A file read any later,
    // in a hook before the action for instance, reaches the commands that mint a token but not those modules.
    const source = readFileSync(join(import.meta.dirname, '../../src/cli/index.ts'), 'utf8');
    const firstImport = source.split('\n').find(line => /^import\s/.test(line));
    expect(firstImport).toBe("import { ENV_BOOTSTRAP } from './env-bootstrap.js';");
  });
});
