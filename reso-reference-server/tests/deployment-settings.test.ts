/**
 * RESOURCES, READ_ONLY and PRODUCTION_INSTANCE: what a production instance behind a gateway turns on, and that the
 * defaults leave every existing deployment as it was. Each case starts a real app on SQLite in a temporary folder.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import { TARGET_RESOURCES, createApp, loadConfig } from '../src/index.js';

const METADATA = resolve(import.meta.dirname, '../server-metadata.json');

interface Running {
  readonly base: string;
  readonly close: () => Promise<void>;
}

const running: Running[] = [];

const serve = async (overrides: Partial<ServerConfig>, sqliteDbPath?: string): Promise<Running> => {
  const dir = await mkdtemp(join(tmpdir(), 'ref-server-settings-'));
  const config = loadConfig({
    dbBackend: 'sqlite',
    sqliteDbPath: sqliteDbPath ?? join(dir, 'test.db'),
    metadataPath: METADATA,
    ...overrides
  });
  const instance = await createApp({ config });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', () => done()));
  const { port } = server.address() as AddressInfo;
  const handle: Running = {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      instance.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  };
  running.push(handle);
  return handle;
};

afterEach(async () => {
  await Promise.all(running.splice(0).map(handle => handle.close()));
});

const json = { Accept: 'application/json' };

describe('reading the settings', () => {
  const withEnv = <T>(env: Record<string, string | undefined>, read: () => T): T => {
    const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return read();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('defaults to the self-contained reference server: the usual resources, writable, every route, its own database setup', () => {
    const config = withEnv({ RESOURCES: undefined, READ_ONLY: undefined, PRODUCTION_INSTANCE: undefined }, () => loadConfig());
    expect(config.resources).toEqual(TARGET_RESOURCES);
    expect(config.readOnly).toBe(false);
    expect(config.productionInstance).toBe(false);
  });

  it('reads PRODUCTION_INSTANCE=true', () => {
    expect(withEnv({ PRODUCTION_INSTANCE: 'true' }, () => loadConfig()).productionInstance).toBe(true);
  });

  it('reads RESOURCES as a trimmed list without repeats', () => {
    const config = withEnv({ RESOURCES: ' OUID , ,System,OUID', READ_ONLY: 'true', PRODUCTION_INSTANCE: 'true' }, () => loadConfig());
    expect(config.resources).toEqual(['OUID', 'System']);
    expect(config.readOnly).toBe(true);
    expect(config.productionInstance).toBe(true);
  });

  it('refuses a RESOURCES that names nothing, rather than serving nothing', () => {
    expect(() => withEnv({ RESOURCES: ' , ' }, () => loadConfig())).toThrow(/names no resources/);
  });
});

describe('a production instance behind a gateway', () => {
  it('serves only the listed resources, with no write routes and none of the development routes', async () => {
    // A production instance leaves the database as it finds it, so set one up first, as a separate setup step would.
    const dir = await mkdtemp(join(tmpdir(), 'ref-server-production-'));
    const path = join(dir, 'production.db');
    await serve({ resources: ['OUID'] }, path);
    await Promise.all(running.splice(0).map(handle => handle.close()));
    const { base } = await serve({ resources: ['OUID'], readOnly: true, productionInstance: true }, path);
    running.push({ base: '', close: () => rm(dir, { recursive: true, force: true }) });

    const service = (await (await fetch(`${base}/`, { headers: json })).json()) as { value: ReadonlyArray<{ name: string }> };
    const names = service.value.map(entry => entry.name);
    expect(names).toContain('OUID');
    expect(names).not.toContain('Property');

    expect((await fetch(`${base}/OUID`, { headers: json })).status).toBe(200);
    expect((await fetch(`${base}/Property`, { headers: json })).status).toBe(404);
    const metadata = await (await fetch(`${base}/$metadata`)).text();
    expect(metadata).toContain('EntitySet Name="OUID"');
    expect(metadata).not.toContain('EntitySet Name="Property"');
    expect((await fetch(`${base}/health`)).status).toBe(200);

    const writes = [
      fetch(`${base}/OUID`, { method: 'POST', headers: { ...json, 'Content-Type': 'application/json' }, body: '{}' }),
      fetch(`${base}/OUID('X')`, { method: 'PATCH', headers: { ...json, 'Content-Type': 'application/json' }, body: '{}' }),
      fetch(`${base}/OUID('X')`, { method: 'DELETE', headers: json })
    ];
    for (const response of await Promise.all(writes)) expect(response.status).toBe(404);

    const tooling = [
      fetch(`${base}/api/proxy?url=${encodeURIComponent('http://127.0.0.1:1/')}`, { headers: json }),
      fetch(`${base}/admin/data-generator/reset`, { method: 'DELETE', headers: json }),
      fetch(`${base}/admin/seed`, { method: 'POST', headers: json }),
      fetch(`${base}/oauth/token`, { method: 'POST', headers: json }),
      fetch(`${base}/api/metadata/fields?resource=OUID`, { headers: json }),
      fetch(`${base}/ui-config`, { headers: json }),
      fetch(`${base}/api-docs/`, { headers: { Accept: 'text/html' } })
    ];
    for (const response of await Promise.all(tooling)) expect(response.status).toBe(404);
  });

  it('lists only the resources it actually serves', async () => {
    const { base } = await serve({ resources: ['OUID', 'NoSuchResource'] });
    const service = (await (await fetch(`${base}/`, { headers: json })).json()) as { value: ReadonlyArray<{ name: string }> };
    expect(service.value.map(entry => entry.name)).not.toContain('NoSuchResource');
    expect((await fetch(`${base}/NoSuchResource`, { headers: json })).status).toBe(404);
  });

  it('serves Lookup once, whether or not RESOURCES names it', async () => {
    const { base } = await serve({ resources: ['OUID', 'Lookup'] });
    const metadata = await (await fetch(`${base}/$metadata`)).text();
    expect(metadata.match(/EntitySet Name="Lookup"/g)).toHaveLength(1);
    const service = (await (await fetch(`${base}/`, { headers: json })).json()) as { value: ReadonlyArray<{ name: string }> };
    expect(service.value.filter(entry => entry.name === 'Lookup')).toHaveLength(1);
  });

  it('leaves writes and the development routes on when the settings are not given', async () => {
    const { base } = await serve({ resources: ['OUID'] });
    expect((await fetch(`${base}/api/metadata/fields?resource=OUID`, { headers: json })).status).toBe(200);
    expect((await fetch(`${base}/ui-config`, { headers: json })).status).toBe(200);
    const created = await fetch(`${base}/OUID`, {
      method: 'POST',
      headers: { ...json, 'Content-Type': 'application/json' },
      body: JSON.stringify({ OrganizationUniqueIdKey: 'M00000000', OrganizationUniqueId: 'M00000000' })
    });
    expect(created.status).not.toBe(404);
  });
});

describe('a production instance, whose database is set up separately', () => {
  const tablesIn = (path: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('creates nothing at start, and serves from a database set up by another process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ref-server-db-setup-'));
    const path = join(dir, 'shared.db');
    try {
      const untouched = await serve({ resources: ['OUID'], productionInstance: true }, path);
      expect(tablesIn(path)).toBe(0);
      expect((await fetch(`${untouched.base}/OUID`, { headers: json })).status).not.toBe(200);
      await Promise.all(running.splice(0).map(handle => handle.close()));

      await serve({ resources: ['OUID'] }, path);
      await Promise.all(running.splice(0).map(handle => handle.close()));
      expect(tablesIn(path)).toBeGreaterThan(0);

      const reader = await serve({ resources: ['OUID'], productionInstance: true, readOnly: true }, path);
      expect((await fetch(`${reader.base}/OUID`, { headers: json })).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
