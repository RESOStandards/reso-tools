/**
 * Connection I/O — tests for export payload building and import analysis.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electronStorage
const mockStore = new Map<string, string>();
const mockStorage = {
  get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  remove: vi.fn(async (key: string) => { mockStore.delete(key); }),
};
vi.stubGlobal('electronStorage', mockStorage);

const { saveConnection, storeCredentials, saveProfile } = await import('../src/services/connection-manager');
const { buildExportPayload, analyzeImport } = await import('../src/services/connection-io');
type ExportPayload = import('../src/services/connection-io').ExportPayload;

beforeEach(() => {
  mockStore.clear();
  vi.clearAllMocks();
});

// ── Export ────────────────────────────────────────────────────────────

describe('Export', () => {
  it('exports connections without credentials', async () => {
    await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    await storeCredentials((await import('../src/services/connection-manager')).loadConnections().then(c => c[0].id) as unknown as string, { authToken: 'secret' });

    // Re-read ID
    const conns = await (await import('../src/services/connection-manager')).loadConnections();
    await storeCredentials(conns[0].id, { authToken: 'secret' });

    const payload = await buildExportPayload({ includeConnections: true, includeProfiles: false, includeCredentials: false });
    expect(payload.version).toBe(1);
    expect(payload.connections).toHaveLength(1);
    expect(payload.connections![0].credentials).toBeUndefined();
    expect(payload.profiles).toBeUndefined();
  });

  it('exports connections with credentials', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'abc' });
    await storeCredentials(conn.id, { clientSecret: 'top-secret' });

    const payload = await buildExportPayload({ includeConnections: true, includeProfiles: false, includeCredentials: true });
    expect(payload.connections![0].credentials?.clientSecret).toBe('top-secret');
  });

  it('exports profiles only', async () => {
    await saveProfile({ name: 'DD Test', credentialsId: null, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'] });

    const payload = await buildExportPayload({ includeConnections: false, includeProfiles: true, includeCredentials: false });
    expect(payload.connections).toBeUndefined();
    expect(payload.profiles).toHaveLength(1);
  });

  it('exports both connections and profiles', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    await saveProfile({ name: 'DD', credentialsId: conn.id, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'] });

    const payload = await buildExportPayload({ includeConnections: true, includeProfiles: true, includeCredentials: false });
    expect(payload.connections).toHaveLength(1);
    expect(payload.profiles).toHaveLength(1);
  });
});

// ── Import analysis ──────────────────────────────────────────────────

describe('Import analysis', () => {
  it('detects new connections', async () => {
    const payload: ExportPayload = {
      version: 1,
      connections: [{ id: 'x', name: 'New', url: 'https://new.com', authMode: 'token', createdAt: '', updatedAt: '' }],
    };
    const result = await analyzeImport(payload);
    expect(result.newConnections).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it('detects conflicts by composite key', async () => {
    await saveConnection({ name: 'Existing', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'abc' });

    const payload: ExportPayload = {
      version: 1,
      connections: [{ id: 'x', name: 'Updated Name', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'abc', createdAt: '', updatedAt: '' }],
    };
    const result = await analyzeImport(payload);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].diffs.some(d => d.field === 'name')).toBe(true);
    expect(result.newConnections).toHaveLength(0);
  });

  it('detects unchanged connections', async () => {
    const conn = await saveConnection({ name: 'Same', url: 'https://api.test.com', authMode: 'token', originatingSystemName: 'MLS' });

    const payload: ExportPayload = {
      version: 1,
      connections: [{ ...conn }],
    };
    const result = await analyzeImport(payload);
    expect(result.unchanged).toHaveLength(1);
    expect(result.newConnections).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('identifies orphaned profiles', async () => {
    const payload: ExportPayload = {
      version: 1,
      profiles: [
        { id: 'p1', name: 'Orphan', credentialsId: 'nonexistent', providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'], createdAt: '', updatedAt: '' },
        { id: 'p2', name: 'Local', credentialsId: null, providerUoi: 'P2', recipientUoi: 'R2', endorsements: ['rcf'], createdAt: '', updatedAt: '' },
      ],
    };
    const result = await analyzeImport(payload);
    expect(result.orphanedProfiles).toHaveLength(1);
    expect(result.orphanedProfiles[0].name).toBe('Orphan');
    expect(result.validProfiles).toHaveLength(1);
    expect(result.validProfiles[0].name).toBe('Local');
  });

  it('treats profiles with matching connection as valid', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    const payload: ExportPayload = {
      version: 1,
      profiles: [
        { id: 'p1', name: 'Linked', credentialsId: conn.id, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'], createdAt: '', updatedAt: '' },
      ],
    };
    const result = await analyzeImport(payload);
    expect(result.validProfiles).toHaveLength(1);
    expect(result.orphanedProfiles).toHaveLength(0);
  });
});
