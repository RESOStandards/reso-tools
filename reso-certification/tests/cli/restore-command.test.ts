import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { deriveReportType, findBackupReports, readBackupReport, resolveRestoreCredential } from '../../src/cli/restore-command.js';

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

describe('resolveRestoreCredential', () => {
  it('prefers the value the downloaded credentials file carries', () => {
    expect(resolveRestoreCredential({ CLIENT_SECRET: 'from-file', CERTIFICATION_API_KEY: 'older' })).toBe('from-file');
  });

  it('falls back to the older variable, and is undefined with neither', () => {
    expect(resolveRestoreCredential({ CERTIFICATION_API_KEY: 'older' })).toBe('older');
    expect(resolveRestoreCredential({})).toBeUndefined();
  });
});
