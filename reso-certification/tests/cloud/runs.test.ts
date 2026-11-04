import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_ENDORSEMENT,
  configProviderUoi,
  listCloudRunStatus,
  requestUploadSlot,
  reserveCloudRun,
  submitCloudRun,
  uploadToSlot
} from '../../src/cloud/runs.js';

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

describe('reserveCloudRun', () => {
  const targets = [{ recipientUoi: 'M00000000', providerUsi: '99999', serviceRootUri: 'https://api.example.com/odata' }];
  const reservation = {
    certificationRequestId: 'test-T00000000-1700000000000',
    providerUoi: 'T00000000',
    reservedAt: '2026-10-29T20:00:00.000Z',
    expiresAt: '2026-10-30T20:00:00.000Z',
    recipients: [{ recipientUoi: 'M00000000', providerUsi: '99999' }]
  };
  const reserve = () =>
    reserveCloudRun({
      bearerToken: TOKEN,
      endorsementName: CLOUD_ENDORSEMENT.webApiCore,
      endorsementVersion: '2.1.0',
      providerUoi: 'T00000000',
      targets
    });

  it('posts the targets only, no credential, to the reservation route, and returns the reservation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(201, reservation));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reserve()).resolves.toEqual({
      certificationRequestId: reservation.certificationRequestId,
      expiresAt: reservation.expiresAt,
      recipients: reservation.recipients
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVICES}/v2/certification/reservations/web-api-core/2.1.0/T00000000`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ providerUoi: 'T00000000', configs: targets });
  });

  it("gives the service's reason when it refuses, and refuses an answer without an ID and a window", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { message: 'Entry 1 has no providerUsi.' })));
    await expect(reserve()).rejects.toThrow('Reserving the web-api-core 2.1.0 run was refused: Entry 1 has no providerUsi.');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(201, { certificationRequestId: 'x' })));
    await expect(reserve()).rejects.toThrow('without a request ID and its window');
  });
});

describe('requestUploadSlot', () => {
  const slotBody = {
    uploadId: 'up-0001',
    url: 'https://uploads.example.org/bucket',
    fields: { key: 'test/T00000000/up-0001.zip', policy: 'p', 'x-amz-signature': 's' },
    expiresAt: '2026-11-03T23:15:00Z',
    maxBytes: 1234
  };
  const ask = () =>
    requestUploadSlot({
      bearerToken: TOKEN,
      certificationRequestId: 'test-T00000000-1700000000000',
      endorsementName: CLOUD_ENDORSEMENT.resoCommonFormat,
      endorsementVersion: '2.1',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      fingerprint: 'a'.repeat(64),
      bytes: 1234
    });

  it('asks the uploads route for a slot for the reservation, with the bearer, and returns it', async () => {
    const fetch = vi.fn(async () => reply(200, slotBody));
    vi.stubGlobal('fetch', fetch);
    expect(await ask()).toEqual(slotBody);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SERVICES}/v2/certification/uploads`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      certificationRequestId: 'test-T00000000-1700000000000',
      endorsementName: 'reso-common-format',
      endorsementVersion: '2.1',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      fingerprint: 'a'.repeat(64),
      bytes: 1234
    });
  });

  it("gives the service's reason for a refusal, and refuses an answer that is not a slot", async () => {
    vi.stubGlobal('fetch', async () => reply(400, { message: 'The reservation has expired' }));
    await expect(ask()).rejects.toThrow(/refused: The reservation has expired/);
    vi.stubGlobal('fetch', async () => reply(200, { uploadId: 'up-0001' }));
    await expect(ask()).rejects.toThrow(/without an upload slot/);
  });
});

describe('uploadToSlot', () => {
  it("posts the slot's fields and the file, streamed, with no RESO credential", async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const zipPath = join(await mkdtemp(join(tmpdir(), 'upload-test-')), 'upload.zip');
    const bytes = Buffer.from(`PK-test-${'z'.repeat(5000)}`);
    await writeFile(zipPath, bytes);
    const received: { body: Buffer; headers: Record<string, string | string[] | undefined> }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ body: Buffer.concat(chunks), headers: request.headers });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      const slot = {
        uploadId: 'up-0001',
        url: `http://127.0.0.1:${port}/bucket`,
        fields: { key: 'k/up-0001.zip', policy: 'p' },
        expiresAt: 'x',
        maxBytes: 10_000
      };
      await uploadToSlot(slot, zipPath);
      const [{ body, headers }] = received;
      expect(headers.authorization).toBeUndefined();
      expect(String(headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
      const text = body.toString('latin1');
      expect(text).toContain('name="key"\r\n\r\nk/up-0001.zip');
      expect(text).toContain('name="policy"\r\n\r\np');
      expect(text.indexOf('name="policy"')).toBeLessThan(text.indexOf('name="file"'));
      expect(body.includes(bytes)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('refuses an address that is not https, before anything is sent', async () => {
    const sent = vi.fn();
    vi.stubGlobal('fetch', sent);
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const zipPath = join(await mkdtemp(join(tmpdir(), 'upload-test-')), 'upload.zip');
    await writeFile(zipPath, 'PK');
    const slot = (url: string) => ({ uploadId: 'u', url, fields: {}, expiresAt: 'x', maxBytes: 1 });
    await expect(uploadToSlot(slot('http://uploads.example.org/b'), zipPath)).rejects.toThrow(
      'Uploading the files was refused: the upload address http://uploads.example.org is not https.'
    );
    await expect(uploadToSlot(slot('ftp://uploads.example.org/b'), zipPath)).rejects.toThrow('is not https');
    await expect(uploadToSlot(slot('not an address'), zipPath)).rejects.toThrow('no usable upload address');
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses a redirect, and never posts the data on to where it points', async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const zipPath = join(await mkdtemp(join(tmpdir(), 'upload-test-')), 'upload.zip');
    await writeFile(zipPath, 'PK-redirected');
    const reachedElsewhere: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url === '/elsewhere') {
          reachedElsewhere.push(request.method ?? '');
          response.statusCode = 204;
        } else {
          response.statusCode = 307;
          response.setHeader('location', '/elsewhere');
        }
        response.end();
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      const slot = { uploadId: 'u', url: `http://127.0.0.1:${port}/bucket`, fields: {}, expiresAt: 'x', maxBytes: 100 };
      await expect(uploadToSlot(slot, zipPath)).rejects.toThrow('answered 307, a redirect, which is never followed');
      expect(reachedElsewhere).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("says why storage refused an upload, in the storage service's words", async () => {
    vi.stubGlobal('fetch', async () =>
      reply(
        400,
        '<?xml version="1.0"?><Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>',
        'Bad Request'
      )
    );
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const zipPath = join(await mkdtemp(join(tmpdir(), 'upload-test-')), 'upload.zip');
    await writeFile(zipPath, 'PK');
    await expect(
      uploadToSlot({ uploadId: 'u', url: 'https://uploads.example.org/b', fields: {}, expiresAt: 'x', maxBytes: 1 }, zipPath)
    ).rejects.toThrow(
      /Uploading the files failed: 400 Bad Request – EntityTooLarge: Your proposed upload exceeds the maximum allowed size/
    );
  });
});
