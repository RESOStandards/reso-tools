import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialsIn, formatAcceptedRun, formatRunStatusTable, readCloudConfig } from '../../src/cli/cloud-command.js';
import { __clearSecretsForTest, maskSecrets } from '../../src/cli/secrets.js';

/**
 * The CLI side of a cloud run: reading the configuration file without leaking what it holds, and the
 * lines it prints.
 *
 * Identities and credentials here are synthetic.
 */

const BEARER = 'server-bearer-for-tests';
const SECRET = 'client-secret-for-tests';
const NESTED_BEARER = 'desktop-bearer-for-tests';
const NESTED_SECRET = 'desktop-secret-for-tests';

describe('credentialsIn', () => {
  it('finds every credential, in the CLI shape and in the desktop export', () => {
    const cliShape = {
      providerUoi: 'T00000000',
      configs: [
        { token: BEARER },
        { clientCredentials: { clientId: 'client', clientSecret: SECRET, tokenUri: 'https://auth.example.com' } }
      ]
    };
    const desktopShape = {
      providerUoi: 'T00000000',
      recipients: [
        { auth: { mode: 'token', authToken: NESTED_BEARER } },
        { auth: { mode: 'client_credentials', clientSecret: NESTED_SECRET } }
      ]
    };
    expect(credentialsIn(cliShape)).toEqual([BEARER, SECRET]);
    expect(credentialsIn(desktopShape)).toEqual([NESTED_BEARER, NESTED_SECRET]);
  });

  it('ignores what is not a credential', () => {
    expect(credentialsIn(undefined)).toEqual([]);
    expect(credentialsIn({ configs: [null, 'text', { token: 7 }, { token: '' }, { auth: 'none' }] })).toEqual([]);
  });
});

describe('readCloudConfig', () => {
  const dir = { path: '' };

  beforeEach(async () => {
    dir.path = await mkdtemp(join(tmpdir(), 'reso-cert-cloud-'));
    __clearSecretsForTest();
  });

  afterEach(async () => {
    __clearSecretsForTest();
    await rm(dir.path, { recursive: true, force: true });
  });

  it('returns the file as written and masks its credentials from then on', async () => {
    const config = { providerUoi: 'T00000000', configs: [{ recipientUoi: 'M00000000', token: BEARER }] };
    const path = join(dir.path, 'config.json');
    await writeFile(path, JSON.stringify(config));

    await expect(readCloudConfig(path)).resolves.toEqual(config);
    expect(maskSecrets(`refused ${BEARER}`)).not.toContain(BEARER);
  });

  it('refuses a file that is not JSON without quoting it', async () => {
    // An unquoted value: the parser's own message would quote the text from here, the credential's start.
    const path = join(dir.path, 'broken.json');
    await writeFile(path, `{"token": ${BEARER}}`);

    const error = await readCloudConfig(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`The configuration file ${path} is not valid JSON.`);
    expect((error as Error).message).not.toContain(BEARER.slice(0, 8));
  });
});

describe('formatAcceptedRun', () => {
  it('names the run, its recipients and how to follow it', () => {
    const text = formatAcceptedRun(
      {
        certificationRequestId: 'test-T00000000-1700000000000',
        providerUoi: 'T00000000',
        endorsementName: 'web-api-core',
        endorsementVersion: '2.1.0',
        recipients: [
          { recipientUoi: 'M00000000', providerUsi: '99999' },
          { recipientUoi: 'M00000001', providerUsi: '' }
        ]
      },
      'Web API Core'
    );
    expect(text.split('\n')).toEqual([
      "Started Web API Core 2.1.0 in RESO's cloud for T00000000.",
      'Request: test-T00000000-1700000000000',
      'Recipients (2):',
      '  M00000000, system 99999',
      '  M00000001, system -',
      'Follow it with: reso-cert cloud status --in-progress'
    ]);
  });
});

describe('formatRunStatusTable', () => {
  const row = {
    certificationRequestId: 'test-T00000000-1700000000000',
    recipientConfigId: 'M00000000-99999',
    endorsementName: 'web-api-core',
    endorsementVersion: '2.1.0',
    statusTimestamp: '2026-10-29T12:00:00.123Z'
  };

  it('says so when there are no runs', () => {
    expect(formatRunStatusTable({ results: [], hasMore: false })).toBe('No cloud runs.');
  });

  it('shows one line per recipient, with the error first, then the step message, then the step', () => {
    const lines = formatRunStatusTable({
      results: [
        { ...row, status: 'error', error: 'Something went wrong with this run.', stepMessage: 'not shown', step: 'not shown' },
        { ...row, status: 'running', stepMessage: 'Checking paging', step: 'paging' },
        { ...row, status: 'running', step: 'metadata' },
        { ...row, status: 'passed', reportId: 'report-0001' }
      ],
      hasMore: false
    }).split('\n');

    expect(lines[0].split(/\s{2,}/)).toEqual(['request', 'recipient', 'endorsement', 'version', 'status', 'updated', 'report', 'detail']);
    expect(lines.slice(2).map(l => l.split(/\s{2,}/).slice(4))).toEqual([
      ['error', '2026-10-29T12:00:00', '-', 'Something went wrong with this run.'],
      ['running', '2026-10-29T12:00:00', '-', 'Checking paging'],
      ['running', '2026-10-29T12:00:00', '-', 'metadata'],
      ['passed', '2026-10-29T12:00:00', 'report-0001', '-']
    ]);
  });

  it('says when more runs match than are shown', () => {
    expect(formatRunStatusTable({ results: [{ ...row, status: 'running' }], hasMore: true })).toMatch(
      /\nMore runs match than are shown\. Narrow with --since\.$/
    );
  });
});
