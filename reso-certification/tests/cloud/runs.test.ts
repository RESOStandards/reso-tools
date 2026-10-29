import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_ENDORSEMENT, configProviderUoi, listCloudRunStatus, submitCloudRun } from '../../src/cloud/runs.js';

/**
 * Starting a run in RESO's cloud and reading where it stands, against a stubbed service.
 *
 * Identities here are synthetic.
 */

const SERVICES = 'https://services.example.org';
const TOKEN = 'session-token-for-tests';

const reply = (status: number, body: unknown, statusText = '') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const config = {
  providerUoi: 'T00000000',
  configs: [
    { serviceRootUri: 'https://api.example.com/odata', recipientUoi: 'M00000000', providerUsi: '99999', token: 'server-token-for-tests' },
    { serviceRootUri: 'https://api.example.com/odata', recipientUoi: 'M00000001', providerUsi: '99999', token: 'server-token-for-tests' }
  ]
};

const accepted = {
  certificationRequestId: 'test-T00000000-1700000000000',
  providerUoi: 'T00000000',
  endorsementName: CLOUD_ENDORSEMENT.webApiCore,
  endorsementVersion: '2.1.0',
  recipients: [
    { recipientUoi: 'M00000000', providerUsi: '99999' },
    { recipientUoi: 'M00000001', providerUsi: '99999' }
  ]
};

const submit = (over: Partial<Parameters<typeof submitCloudRun>[0]> = {}) =>
  submitCloudRun({ bearerToken: TOKEN, endorsementName: CLOUD_ENDORSEMENT.webApiCore, endorsementVersion: '2.1.0', config, ...over });

const unset = (name: string): void => {
  // `process.env.X = undefined` stores the string "undefined". Only `delete` unsets.
  delete process.env[name];
};

beforeEach(() => {
  process.env.RESO_SERVICES_URL = SERVICES;
  for (const name of ['CERT_AUTH_API_BASE_URL', 'CERT_AUTH_API_USERNAME', 'CERTIFICATION_API_KEY']) unset(name);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unset('RESO_SERVICES_URL');
});

describe('submitCloudRun', () => {
  it('posts the configuration as it is to the request route, with the bearer, and returns the recorded run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(202, accepted));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submit()).resolves.toEqual(accepted);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVICES}/v2/certification/requests/web-api-core/2.1.0/T00000000`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual(config);
  });

  it('encodes each part of the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(202, { ...accepted, providerUoi: 'T 0/1' }));
    vi.stubGlobal('fetch', fetchMock);

    await submit({ config: { ...config, providerUoi: 'T 0/1' } });

    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVICES}/v2/certification/requests/web-api-core/2.1.0/T%200%2F1`);
  });

  it('refuses a configuration with no providerUoi before calling the service, rather than inventing one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(submit({ config: { configs: config.configs } })).rejects.toThrow('no "providerUoi"');
    await expect(submit({ config: { ...config, providerUoi: ' ' } })).rejects.toThrow('no "providerUoi"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the service's reason when it refuses the request", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(400, { message: 'web-api-core version "2.1" is not supported. Supported: 2.0.0, 2.1.0.' }))
    );
    await expect(submit({ endorsementVersion: '2.1' })).rejects.toThrow(
      'Starting the web-api-core 2.1 run was refused: web-api-core version "2.1" is not supported. Supported: 2.0.0, 2.1.0.'
    );
  });

  it('says so when the service cannot start runs yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(503, { message: 'Certification runs cannot be started here yet.' })));
    await expect(submit()).rejects.toThrow('was refused: Certification runs cannot be started here yet.');
  });

  it('shows the route’s 403, which names the organization, and calls the gateway’s 403 a rejected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(403, { message: 'The configuration names an organization you may not act for.' }))
    );
    await expect(submit()).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
      message: expect.stringContaining('The configuration names an organization you may not act for.')
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { message: 'Forbidden' })));
    await expect(submit()).rejects.toMatchObject({ code: 'AUTH_REJECTED' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { message: 'Unauthorized' })));
    await expect(submit()).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
  });

  it('does not repeat the body of a server fault', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(500, { message: 'internal detail that is not for the caller' }, 'Internal Server Error'))
    );
    const error = await submit().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SERVICE_ERROR', message: expect.stringContaining('500 Internal Server Error') });
    expect(String((error as Error).message)).not.toContain('internal detail');
  });

  it('refuses an accepted answer without a request id and its recipients', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(202, { providerUoi: 'T00000000' })));
    await expect(submit()).rejects.toThrow('without a request id and its recipients');
  });

  it('needs a token, and asks for one without calling the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(submit({ bearerToken: undefined, fromCli: true })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names itself when RESO_SERVICES_URL is not set', async () => {
    unset('RESO_SERVICES_URL');
    await expect(submit()).rejects.toThrow('Cloud runs: RESO_SERVICES_URL is not set.');
  });
});

describe('configProviderUoi', () => {
  it('reads the organization the file names', () => {
    expect(configProviderUoi(config)).toBe('T00000000');
  });

  it('refuses anything else', () => {
    for (const bad of [undefined, null, 'T00000000', [], {}, { providerUoi: 7 }, { providerUoi: '' }]) {
      expect(() => configProviderUoi(bad)).toThrow('no "providerUoi"');
    }
  });
});

describe('listCloudRunStatus', () => {
  const page = {
    results: [
      {
        certificationRequestId: 'test-T00000000-1700000000000',
        recipientConfigId: 'M00000000-99999',
        status: 'running',
        statusTimestamp: '2026-10-29T12:00:00.000Z'
      }
    ],
    hasMore: false
  };

  it('reads the status route with the bearer and returns the page as served', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, page));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCloudRunStatus({ bearerToken: TOKEN })).resolves.toEqual(page);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVICES}/v2/certification/requests/status`);
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  it('passes each filter the way the route names it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, page));
    vi.stubGlobal('fetch', fetchMock);

    await listCloudRunStatus({ bearerToken: TOKEN, since: '2026-10-29T00:00:00Z', statuses: ['running', 'failed'], limit: 20 });
    await listCloudRunStatus({ bearerToken: TOKEN, inProgressOnly: true });

    const first = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(first.searchParams)).toEqual({ since: '2026-10-29T00:00:00Z', statuses: 'running,failed', limit: '20' });
    expect(new URL(fetchMock.mock.calls[1][0]).search).toBe('?inProgressOnly=true');
  });

  it("gives the service's reason for a filter it refuses", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { message: 'Pass inProgressOnly or statuses, not both.' })));
    await expect(listCloudRunStatus({ bearerToken: TOKEN, inProgressOnly: true, statuses: ['running'] })).rejects.toThrow(
      'Reading cloud run status was refused: Pass inProgressOnly or statuses, not both.'
    );
  });

  it('refuses an answer that is not a list of runs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { results: 'none' })));
    await expect(listCloudRunStatus({ bearerToken: TOKEN })).rejects.toThrow('without a list of runs');
  });
});
