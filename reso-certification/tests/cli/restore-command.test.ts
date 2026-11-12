import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveReportType, findBackupReports, readBackupReport, runRestore } from '../../src/cli/restore-command.js';

const backupFixture = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reso-backup-')));
  const live = join(root, 'data_dictionary-2.0', 'T00000012-50022', 'M00000071');
  const archived = join(root, 'archived', 'data_dictionary-1.7', 'T00000012-50022', 'M00000071');
  mkdirSync(live, { recursive: true });
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(live, 'metadata-report.json.gz'), gzipSync(JSON.stringify({ type: 'data_dictionary', version: '2.0' })));
  writeFileSync(join(archived, 'metadata-report-abc.json.gz'), gzipSync(JSON.stringify({ version: '1.7' })));
  return root;
};

describe('findBackupReports', () => {
  it('finds gzipped reports and reads the endorsement from the path', () => {
    const found = findBackupReports(backupFixture());
    expect(found).toHaveLength(2);
    const live = found.find(report => !report.archived);
    expect(live?.endorsement).toBe('data_dictionary-2.0');
  });

  it('takes archived-ness from the directory, and the type dir from one level deeper', () => {
    const found = findBackupReports(backupFixture());
    const archived = found.find(report => report.archived);
    expect(archived).toBeDefined();
    expect(archived?.endorsement).toBe('data_dictionary-1.7');
  });
});

describe('readBackupReport', () => {
  it('gunzips what the backup actually contains', () => {
    const root = backupFixture();
    const [first] = findBackupReports(root);
    expect(readBackupReport(first.path)).toMatchObject({ version: expect.any(String) });
  });
});

describe('deriveReportType', () => {
  it('derives a type only when the directory and the document agree', () => {
    expect(deriveReportType('data_dictionary-1.7', '1.7')).toBe('data_dictionary');
    expect(deriveReportType('web_api_server_core-2.0.0', '2.0.0')).toBe('web_api_server_core');
  });

  it('refuses when they disagree, because one source alone is a guess', () => {
    expect(deriveReportType('data_dictionary-1.7', '2.0')).toBeUndefined();
    expect(deriveReportType('data_dictionary-1.7', undefined)).toBeUndefined();
  });

  it('refuses a directory that names no endorsement, such as an archived record', () => {
    expect(deriveReportType('archived-1.7', '1.7')).toBeUndefined();
    expect(deriveReportType('nodashes', '1.7')).toBeUndefined();
  });
});

describe('runRestore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Restore the fixture backup against a stubbed server, returning the requests, the summary and the ledger. */
  const restoreWith = async (answer: () => Response) => {
    const api = vi.fn(async (_url: string, _init: RequestInit) => answer());
    vi.stubGlobal('fetch', api);
    const ledgerPath = join(realpathSync(mkdtempSync(join(tmpdir(), 'reso-ledger-'))), 'restored.txt');
    const summary = await runRestore(
      {
        path: backupFixture(),
        url: 'https://cert-api.example.org',
        execute: true,
        concurrency: 1,
        ledgerPath,
        deriveMissingType: false,
        authorize: async () => 'Bearer minted-token'
      },
      () => undefined
    );
    return { api, summary, ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '' };
  };

  it('never follows a redirect: every post says so', async () => {
    const { api, summary } = await restoreWith(() => new Response('{}', { status: 200 }));
    expect(summary.succeeded).toBe(2);
    expect(api.mock.calls.map(call => call[1].redirect)).toEqual(['manual', 'manual']);
  });

  it('counts a redirected post as a failure and records nothing in the ledger', async () => {
    const { summary, ledger } = await restoreWith(() => new Response('', { status: 307 }));
    expect(summary.succeeded).toBe(0);
    expect(summary.failures.map(failure => failure.status)).toEqual([307, 307]);
    expect(ledger).toBe('');
  });
});
