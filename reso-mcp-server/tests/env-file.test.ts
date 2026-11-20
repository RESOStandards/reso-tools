/**
 * `--credentials <path>`: credentials from a file the user keeps, for a server started with `npx`.
 *
 * Every test is named for what would go wrong without the behavior it checks. The loader takes the load function as
 * an argument, so the decisions are observable without touching the real environment, and one test uses Node's own
 * loader against a real file to prove the precedence the docs promise.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envFileFailureMessage, envFilePathFrom, loadEnvFileFrom } from '../src/env-file.js';

describe('envFilePathFrom', () => {
  it('reads the path after the flag, so a separate argument works', () => {
    expect(envFilePathFrom(['node', 'reso-mcp', '--credentials', '/home/me/.config/reso/mcp.env'])).toBe('/home/me/.config/reso/mcp.env');
  });

  it('reads the joined form, so --credentials=<path> works too', () => {
    expect(envFilePathFrom(['node', 'reso-mcp', '--credentials=/home/me/mcp.env'])).toBe('/home/me/mcp.env');
  });

  it('is undefined without the flag, so a server with no file starts as before', () => {
    expect(envFilePathFrom(['node', 'reso-mcp', '--scope', 'cert'])).toBeUndefined();
  });

  it('does not take the next flag as a path', () => {
    expect(envFilePathFrom(['node', 'reso-mcp', '--credentials', '--scope', 'cert'])).toBeUndefined();
  });
});

describe('loadEnvFileFrom', () => {
  it('does nothing without the flag', () => {
    const calls: string[] = [];
    expect(loadEnvFileFrom(['node', 'reso-mcp'], path => calls.push(path))).toEqual({ kind: 'none' });
    expect(calls).toEqual([]);
  });

  it('loads the named file', () => {
    const calls: string[] = [];
    expect(loadEnvFileFrom(['node', 'reso-mcp', '--credentials', '/tmp/x.env'], path => calls.push(path))).toEqual({
      kind: 'loaded',
      path: '/tmp/x.env'
    });
    expect(calls).toEqual(['/tmp/x.env']);
  });

  it('reports the flag with no path, rather than starting without the credentials the user meant to give', () => {
    const result = loadEnvFileFrom(['node', 'reso-mcp', '--credentials']);
    expect(result.kind).toBe('failed');
  });

  it("reports an unreadable file by its error code, never the loader's message, which can quote the file", () => {
    const result = loadEnvFileFrom(['node', 'reso-mcp', '--credentials', '/tmp/missing.env'], () => {
      throw Object.assign(new Error('RESO_CLIENT_SECRET=leaked-value'), { code: 'ENOENT' });
    });
    expect(result).toEqual({ kind: 'failed', path: '/tmp/missing.env', reason: 'ENOENT' });
    if (result.kind !== 'failed') throw new Error('expected a failure');
    const message = envFileFailureMessage(result);
    expect(message).toContain('/tmp/missing.env');
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('leaked-value');
  });
});

describe("Node's loader, against a real file", () => {
  const dirs: string[] = [];
  const keys = ['RESO_ENV_FILE_PROBE_A', 'RESO_ENV_FILE_PROBE_B'] as const;
  afterEach(() => {
    for (const key of keys) delete process.env[key];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fills in from the file and never overrides a variable already set, as the docs promise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reso-mcp-env-'));
    dirs.push(dir);
    const file = join(dir, 'mcp.env');
    writeFileSync(file, 'RESO_ENV_FILE_PROBE_A=from-file\nRESO_ENV_FILE_PROBE_B=from-file\n');
    process.env.RESO_ENV_FILE_PROBE_A = 'from-environment';
    expect(loadEnvFileFrom(['node', 'reso-mcp', '--credentials', file])).toEqual({ kind: 'loaded', path: file });
    expect(process.env.RESO_ENV_FILE_PROBE_A).toBe('from-environment');
    expect(process.env.RESO_ENV_FILE_PROBE_B).toBe('from-file');
  });
});
