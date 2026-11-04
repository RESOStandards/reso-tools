/**
 * `reso-cert archive-report`: the site's archive, from the command line, against a stubbed Cert API.
 *
 * Every request is asserted, because the command's whole contract is which requests it makes and when:
 * two reads and the warning without `--confirm`, the reads and exactly one archive POST with it, and no
 * request at all before a refusal. Identities and credentials here are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArchiveReportResult,
  archiveExitCode,
  archiveWarning,
  certApiOriginFromTokenUri,
  resolveCertApiOrigin,
  runArchiveReport
} from '../../src/cli/archive-report-command.js';
import { resolveCertApiCredential } from '../../src/cli/cert-api-credential.js';
import { __clearSecretsForTest, maskSecrets } from '../../src/cli/secrets.js';

const ORIGIN = 'https://cert-api.example.org';
const CREDENTIAL = 'SENTINEL-credential-for-tests';
const REPORT_ID = 'AbC123_-xyz';
const PROVIDER = 'T00000001';
const RECIPIENT = 'M00000002';

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  TOKEN_URI: `${ORIGIN}/api/v1/oauth/token`,
  CLIENT_SECRET: CREDENTIAL,
  ...overrides
});

const ddReport = {
  id: REPORT_ID,
  type: 'data_dictionary',
  description: 'Data Dictionary Metadata',
  version: '2.0',
  providerUoi: PROVIDER,
  recipientUoi: RECIPIENT
};

const coreReport = {
  ...ddReport,
  type: 'web_api_server_core',
  description: 'Web API Core',
  version: '2.1.0'
};

const organization = { uoi: PROVIDER, name: 'Example MLS' };

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const HTML = '<!doctype html><html><body>app shell</body></html>';

/**
 * A Cert API that answers the three routes the command uses, with overrides per route. `reread` is
 * the answer to a second read of the report, the one the command makes after an archive answer that
 * was not `201 success`; it defaults to the first read's answer, the report still listed.
 */
const certApi = (
  answers: { readonly report?: unknown; readonly organization?: unknown; readonly archive?: unknown; readonly reread?: unknown } = {}
) => {
  let reads = 0;
  return vi.fn(async (url: string) => {
    if (url.includes('/certification_reports/filter/list')) {
      reads += 1;
      const first = answers.report ?? reply(200, [ddReport]);
      return reads === 1 ? first : (answers.reread ?? first);
    }
    if (url.includes('/organization?')) return answers.organization ?? reply(200, organization);
    if (url.includes('/certification_reports/archive/')) return answers.archive ?? reply(201, 'success');
    throw new Error(`unexpected request ${url}`);
  });
};

const run = async (
  fetchMock: ReturnType<typeof vi.fn>,
  options: { readonly confirm?: boolean; readonly url?: string; readonly env?: NodeJS.ProcessEnv; readonly reportId?: string } = {}
): Promise<{ readonly result: ArchiveReportResult; readonly lines: ReadonlyArray<string> }> => {
  vi.stubGlobal('fetch', fetchMock);
  const lines: string[] = [];
  const result = await runArchiveReport(
    {
      reportId: options.reportId ?? REPORT_ID,
      confirm: options.confirm ?? false,
      ...(options.url === undefined ? {} : { url: options.url }),
      env: options.env ?? env()
    },
    line => lines.push(line)
  );
  return { result, lines };
};

const calledUrls = (fetchMock: ReturnType<typeof vi.fn>): ReadonlyArray<string> => fetchMock.mock.calls.map(call => String(call[0]));

beforeEach(() => __clearSecretsForTest());
afterEach(() => vi.unstubAllGlobals());

describe('the Cert API origin', () => {
  it('is taken from TOKEN_URI when its path is the token endpoint', () => {
    expect(certApiOriginFromTokenUri(`${ORIGIN}/api/v1/oauth/token`)).toBe(ORIGIN);
  });

  it('accepts the legacy oauth2 prefix', () => {
    expect(certApiOriginFromTokenUri(`${ORIGIN}/api/v1/oauth2/token`)).toBe(ORIGIN);
  });

  it('refuses any other path, because the file may have been built from the site host', () => {
    expect(certApiOriginFromTokenUri(`${ORIGIN}/oauth/token`)).toBeUndefined();
    expect(certApiOriginFromTokenUri(`${ORIGIN}/api/v1/oauth/token/extra`)).toBeUndefined();
    expect(certApiOriginFromTokenUri('not a url')).toBeUndefined();
    expect(() => resolveCertApiOrigin({ env: env({ TOKEN_URI: `${ORIGIN}/oauth/token` }) })).toThrow(/--url/);
  });

  it('refuses a host that cannot be an API host, such as the "undefined" older credentials files carried', () => {
    expect(certApiOriginFromTokenUri('https://undefined/api/v1/oauth/token')).toBeUndefined();
    expect(() => resolveCertApiOrigin({ env: env({ TOKEN_URI: 'undefined/api/v1/oauth/token' }) })).toThrow(/host.*--url/s);
    expect(() => resolveCertApiOrigin({ env: env({ TOKEN_URI: 'undefined/api/v1/oauth2/token' }) })).toThrow(/host.*--url/s);
    expect(() => resolveCertApiOrigin({ url: 'undefined', env: env() })).toThrow(/host/);
    expect(() => resolveCertApiOrigin({ url: 'https://cert-api', env: env() })).toThrow(/host/);
  });

  it('still accepts a loopback host, where a local Cert API runs', () => {
    expect(resolveCertApiOrigin({ env: env({ TOKEN_URI: 'http://localhost:3000/api/v1/oauth/token' }) })).toBe('http://localhost:3000');
    expect(resolveCertApiOrigin({ url: 'http://127.0.0.1:3000', env: env() })).toBe('http://127.0.0.1:3000');
  });

  it('refuses when TOKEN_URI is absent and no --url is given', () => {
    expect(() => resolveCertApiOrigin({ env: { CLIENT_SECRET: CREDENTIAL } })).toThrow(/--url/);
  });

  it('prefers --url over TOKEN_URI', () => {
    expect(resolveCertApiOrigin({ url: 'https://other.example.org', env: env() })).toBe('https://other.example.org');
  });

  it('upgrades http to https either way', () => {
    expect(resolveCertApiOrigin({ url: 'http://other.example.org', env: env() })).toBe('https://other.example.org');
    expect(resolveCertApiOrigin({ env: env({ TOKEN_URI: 'http://cert-api.example.org/api/v1/oauth/token' }) })).toBe(ORIGIN);
  });

  it('refuses a --url that carries a path, rather than trimming it', () => {
    expect(() => resolveCertApiOrigin({ url: `${ORIGIN}/api/v1`, env: env() })).toThrow(/without a path/);
  });
});

describe('the credential', () => {
  it('is CLIENT_SECRET first, then CERTIFICATION_API_KEY, as restore resolves it', () => {
    expect(resolveCertApiCredential({ CLIENT_SECRET: 'from-file', CERTIFICATION_API_KEY: 'older' })).toBe('from-file');
    expect(resolveCertApiCredential({ CERTIFICATION_API_KEY: 'older' })).toBe('older');
    expect(resolveCertApiCredential({})).toBeUndefined();
  });

  it('treats an empty or blank value as absent, so it never becomes a bare Bearer and never shadows the other variable', () => {
    expect(resolveCertApiCredential({ CLIENT_SECRET: '', CERTIFICATION_API_KEY: 'older' })).toBe('older');
    expect(resolveCertApiCredential({ CLIENT_SECRET: '   ' })).toBeUndefined();
    expect(resolveCertApiCredential({ CERTIFICATION_API_KEY: '' })).toBeUndefined();
    expect(resolveCertApiCredential({ CLIENT_SECRET: ' from-file\n' })).toBe('from-file');
  });
});

describe('the warning', () => {
  it('names a Data Dictionary report by the dictionary, with the provider', () => {
    expect(archiveWarning(ddReport, 'Example MLS')).toBe(
      'Archive Endorsement?\n\n' +
        'By proceeding, the Data Dictionary 2.0 Endorsement for Example MLS will no longer be available in the RESO Certification System.\n' +
        "You will receive a notification it's been archived."
    );
  });

  it('names any other report by its description', () => {
    expect(archiveWarning(coreReport, 'Example MLS')).toContain('the Web API Core 2.1.0 Endorsement for Example MLS will');
  });

  it('leaves the provider out when the provider and recipient are the same organization', () => {
    expect(archiveWarning({ ...ddReport, recipientUoi: PROVIDER }, undefined)).toContain(
      'the Data Dictionary 2.0 Endorsement will no longer be available'
    );
  });
});

describe('without --confirm', () => {
  it('reads the report and the provider organization, prints the warning and archives nothing', async () => {
    const api = certApi();
    const { result, lines } = await run(api);

    expect(calledUrls(api)).toEqual([
      `${ORIGIN}/api/v1/certification_reports/filter/list`,
      `${ORIGIN}/api/v1/organization?uoi=${PROVIDER}`
    ]);
    const [, readInit] = api.mock.calls[0];
    expect(readInit.method).toBe('POST');
    expect(readInit.body).toBe(JSON.stringify({ ids: [REPORT_ID] }));
    expect(readInit.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);

    expect(result.confirmed).toBe(false);
    expect(result.archived).toBe(false);
    expect(result.warning).toContain('for Example MLS will no longer be available');
    expect(result.report).toMatchObject({ id: REPORT_ID, providerUoi: PROVIDER, providerName: 'Example MLS' });
    expect(result.message).toMatch(/Nothing was archived.*--confirm/);
    expect(lines.join('\n')).toContain('Archive Endorsement?');
    expect(archiveExitCode(result)).toBe(0);
  });

  it('skips the organization read when the provider and recipient are the same', async () => {
    const api = certApi({ report: reply(200, [{ ...ddReport, recipientUoi: PROVIDER }]) });
    const { result } = await run(api);
    expect(calledUrls(api)).toEqual([`${ORIGIN}/api/v1/certification_reports/filter/list`]);
    expect(result.warning).toContain('Endorsement will no longer');
  });
});

describe('with --confirm', () => {
  it('reads, prints the warning, then makes exactly one archive POST with no query string and no body', async () => {
    const api = certApi();
    const { result, lines } = await run(api, { confirm: true });

    expect(calledUrls(api)).toEqual([
      `${ORIGIN}/api/v1/certification_reports/filter/list`,
      `${ORIGIN}/api/v1/organization?uoi=${PROVIDER}`,
      `${ORIGIN}/api/v1/certification_reports/archive/${REPORT_ID}`
    ]);
    const [url, init] = api.mock.calls[2];
    expect(url).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });

    expect(result).toMatchObject({ confirmed: true, archived: true, status: 201, message: 'success' });
    expect(lines.join('\n')).toContain('Archive Endorsement?');
    expect(archiveExitCode(result)).toBe(0);
  });

  it('refuses an id that would need escaping in the path, before any request', async () => {
    const api = certApi();
    await expect(run(api, { confirm: true, reportId: 'a/b' })).rejects.toThrow(/report id/);
    expect(api).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'Report not found'],
    [401, { message: 'Unauthorized' }],
    [500, { message: 'archiveReport Controller API: boom' }]
  ])('fails with the status and the server message on %s', async (status, body) => {
    const api = certApi({ archive: reply(status, body) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(4);
    expect(result.archived).toBe(false);
    expect(result.status).toBe(status);
    expect(result.message).toBe(typeof body === 'string' ? body : body.message);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('treats a 200 with HTML as a failure, not a success', async () => {
    const api = certApi({ archive: reply(200, HTML) });
    const { result } = await run(api, { confirm: true });
    expect(result.archived).toBe(false);
    expect(result.status).toBe(200);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('counts a 201 "success" with trailing whitespace as archived, since whitespace carries nothing', async () => {
    const api = certApi({ archive: reply(201, 'success\n') });
    const { result } = await run(api, { confirm: true });
    expect(result.archived).toBe(true);
    expect(archiveExitCode(result)).toBe(0);
  });

  it('treats a 201 whose body is not "success" as a failure', async () => {
    const api = certApi({ archive: reply(201, HTML) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(4);
    expect(result.archived).toBe(false);
    expect(result.status).toBe(201);
    expect(archiveExitCode(result)).toBe(1);
  });
});

describe('every request', () => {
  it('never follows a redirect, so an archive POST is not replayed to a host the operator did not name', async () => {
    const api = certApi();
    await run(api, { confirm: true });
    expect(api.mock.calls.map(call => call[1].redirect)).toEqual(['manual', 'manual', 'manual']);
  });

  it('reports a redirect of the archive POST as a failure with its status, and follows nothing', async () => {
    const api = certApi({ archive: reply(307, '') });
    const { result, lines } = await run(api, { confirm: true });
    // The origin compared exactly: a prefix would also accept https://cert-api.example.org.elsewhere.example.
    expect(calledUrls(api).every(url => new URL(url).origin === ORIGIN)).toBe(true);
    expect(result.archived).toBe(false);
    expect(result.status).toBe(307);
    expect(lines.join('\n')).toContain('307');
    expect(archiveExitCode(result)).toBe(1);
  });

  it('names the cause when the request itself fails, not only "fetch failed"', async () => {
    const api = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND cert-api.example.org') });
    });
    const { result } = await run(api, { confirm: true });
    expect(result.status).toBe(0);
    expect(result.message).toContain('fetch failed');
    expect(result.message).toContain('ENOTFOUND');
    expect(archiveExitCode(result)).toBe(1);
  });
});

describe('after an archive answer that is not 201 success', () => {
  const LIST = `${ORIGIN}/api/v1/certification_reports/filter/list`;
  const ORGANIZATION = `${ORIGIN}/api/v1/organization?uoi=${PROVIDER}`;
  const ARCHIVE = `${ORIGIN}/api/v1/certification_reports/archive/${REPORT_ID}`;

  it('reads the report again and, when it is gone, says the server removed it without confirming, exit 1', async () => {
    const api = certApi({ archive: reply(404, { message: 'archiveReport Controller API: Invalid UOI' }), reread: reply(200, []) });
    const { result, lines } = await run(api, { confirm: true });
    expect(calledUrls(api)).toEqual([LIST, ORGANIZATION, ARCHIVE, LIST]);
    expect(result).toMatchObject({ archived: false, status: 404, reread: 'gone', message: 'archiveReport Controller API: Invalid UOI' });
    const text = lines.join('\n');
    expect(text).toContain('did not confirm the archive');
    expect(text).toContain('no longer listed');
    expect(text).not.toContain('did not archive');
    expect(archiveExitCode(result)).toBe(1);
  });

  it('reads the report again and, when it is still listed, says it was not archived', async () => {
    const api = certApi({ archive: reply(401, { message: 'Unauthorized' }) });
    const { result, lines } = await run(api, { confirm: true });
    expect(calledUrls(api)).toEqual([LIST, ORGANIZATION, ARCHIVE, LIST]);
    expect(result).toMatchObject({ archived: false, status: 401, reread: 'listed', message: 'Unauthorized' });
    expect(lines.join('\n')).toContain('still listed');
    expect(archiveExitCode(result)).toBe(1);
  });

  it('says so when the second read fails, and claims nothing about what the server holds', async () => {
    const api = certApi({ archive: reply(500, { message: 'boom' }), reread: reply(503, { message: 'down' }) });
    const { result, lines } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ archived: false, status: 500, reread: 'unreadable', message: 'boom' });
    expect(lines.join('\n')).toMatch(/not known/);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('does not count a second read that answers something other than a list as the report being gone', async () => {
    const api = certApi({ archive: reply(502, 'Bad Gateway'), reread: reply(200, HTML) });
    const { result } = await run(api, { confirm: true });
    expect(result.reread).toBe('unreadable');
    expect(archiveExitCode(result)).toBe(1);
  });

  it('reads nothing again after 201 success', async () => {
    const api = certApi();
    const { result } = await run(api, { confirm: true });
    expect(calledUrls(api)).toEqual([LIST, ORGANIZATION, ARCHIVE]);
    expect(result.reread).toBeUndefined();
  });
});

describe('when the report cannot be read', () => {
  it('archives nothing on a failed read', async () => {
    const api = certApi({ report: reply(500, { message: 'getReportsById Controller API: boom' }) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(false);
    expect(result.report).toBeUndefined();
    expect(result.message).toContain('boom');
    expect(archiveExitCode(result)).toBe(1);
  });

  it('archives nothing when no report has that id', async () => {
    const api = certApi({ report: reply(200, []) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(false);
    expect(result.message).toContain(REPORT_ID);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('archives nothing when the read answers HTML, which is what the site host does', async () => {
    const api = certApi({ report: reply(200, HTML) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(false);
    expect(result.message).toMatch(/not JSON/);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('archives nothing when the read answers JSON that is not a list, and says so rather than "not JSON"', async () => {
    const api = certApi({ report: reply(200, { message: 'not a list' }) });
    const { result } = await run(api, { confirm: true });
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(false);
    expect(result.message).toMatch(/not a list of reports/);
    expect(result.message).not.toMatch(/not JSON/);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('exits 1 without --confirm too, since no warning could be shown', async () => {
    const api = certApi({ report: reply(401, { message: 'Unauthorized' }) });
    const { result } = await run(api);
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(401);
    expect(result.message).toContain('Unauthorized');
    expect(archiveExitCode(result)).toBe(1);
  });
});

describe('when only the organization name cannot be read', () => {
  it('shows the provider UOI in its place, says so, and still archives', async () => {
    const api = certApi({ organization: reply(404, { message: 'Invalid UOI' }) });
    const { result, lines } = await run(api, { confirm: true });
    expect(result.warning).toContain(`Endorsement for ${PROVIDER} will`);
    expect(result.report?.providerName).toBeUndefined();
    expect(result.report?.providerNameUnavailable).toContain('Invalid UOI');
    expect(lines.join('\n')).toContain(PROVIDER);
    expect(lines.join('\n')).toMatch(/could not be read/);
    expect(result.archived).toBe(true);
  });

  it('shows the UOI when the organization answer has no name', async () => {
    const api = certApi({ organization: reply(200, { uoi: PROVIDER }) });
    const { result } = await run(api);
    expect(result.warning).toContain(`Endorsement for ${PROVIDER} will`);
  });
});

describe('refusals before any request', () => {
  it('refuses without a credential', async () => {
    const api = certApi();
    await expect(run(api, { env: { TOKEN_URI: `${ORIGIN}/api/v1/oauth/token` } })).rejects.toThrow(/CLIENT_SECRET/);
    expect(api).not.toHaveBeenCalled();
  });

  it('refuses an empty credential the same way, rather than presenting a bare Bearer', async () => {
    const api = certApi();
    await expect(run(api, { env: env({ CLIENT_SECRET: '' }) })).rejects.toThrow(/CLIENT_SECRET/);
    expect(api).not.toHaveBeenCalled();
  });

  it('never echoes a malformed id, and has registered the credential before refusing one', async () => {
    const api = certApi();
    const secretAsId = `${CREDENTIAL}==`;
    const error: unknown = await run(api, { reportId: secretAsId }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/report id/);
    expect(message).not.toContain(CREDENTIAL);
    expect(maskSecrets(CREDENTIAL)).not.toBe(CREDENTIAL);
    expect(api).not.toHaveBeenCalled();
  });

  it('refuses without an origin', async () => {
    const api = certApi();
    await expect(run(api, { env: { CLIENT_SECRET: CREDENTIAL } })).rejects.toThrow(/--url/);
    expect(api).not.toHaveBeenCalled();
  });

  it('refuses the TOKEN_URI older credentials files carried, so the credential never goes to a host named undefined', async () => {
    const api = certApi();
    await expect(run(api, { env: env({ TOKEN_URI: 'undefined/api/v1/oauth/token' }) })).rejects.toThrow(/--url/);
    expect(api).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'a b', 'a?b', 'a#b'])('refuses the report id %j', async reportId => {
    const api = certApi();
    await expect(run(api, { reportId })).rejects.toThrow(/report id/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('the credential', () => {
  it('never appears in the result, the lines or a quoted error', async () => {
    const api = vi.fn(async () => {
      throw new Error(`connect failed sending Bearer ${CREDENTIAL}`);
    });
    const { result, lines } = await run(api, { confirm: true });
    const everything = maskSecrets(JSON.stringify({ result, lines }));
    expect(everything).not.toContain(CREDENTIAL);
    expect(everything).toContain('connect failed');
    expect(result.archived).toBe(false);
    expect(archiveExitCode(result)).toBe(1);
  });

  it('is not in the result or the lines of a successful run', async () => {
    const { result, lines } = await run(certApi(), { confirm: true });
    expect(result.archived).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify({ result, lines })).not.toContain(CREDENTIAL);
  });
});
