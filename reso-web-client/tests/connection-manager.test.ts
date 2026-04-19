/**
 * Connection Manager — unit tests for data model, CRUD, MRU, search, and dedup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electronStorage before importing the module
const mockStore = new Map<string, string>();
const mockStorage = {
  get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  remove: vi.fn(async (key: string) => { mockStore.delete(key); }),
};

vi.stubGlobal('electronStorage', mockStorage);

const {
  loadConnections,
  saveConnection,
  deleteConnection,
  findConnectionByKey,
  storeCredentials,
  getCredentials,
  removeCredentials,
  hasCredentials,
  loadProfiles,
  saveProfile,
  deleteProfile,
  profilesForConnection,
  orphanedProfiles,
  touchMRU,
  loadConnectionsMRU,
  searchConnections,
  maskSecret,
  connectionKey,
} = await import('../src/services/connection-manager');

beforeEach(() => {
  mockStore.clear();
  vi.clearAllMocks();
});

// ── Connection CRUD ──────────────────────────────────────────────────

describe('Connection CRUD', () => {
  it('starts with no connections', async () => {
    expect(await loadConnections()).toEqual([]);
  });

  it('saves a new connection with generated ID and timestamps', async () => {
    const conn = await saveConnection({ name: 'Test MLS', url: 'https://api.test.com', authMode: 'token' });
    expect(conn.id).toMatch(/^conn-/);
    expect(conn.name).toBe('Test MLS');
    expect(conn.url).toBe('https://api.test.com');
    expect(conn.createdAt).toBeTruthy();
    expect(conn.updatedAt).toBeTruthy();

    const all = await loadConnections();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(conn.id);
  });

  it('updates an existing connection by ID', async () => {
    const conn = await saveConnection({ name: 'Original', url: 'https://api.test.com', authMode: 'token' });
    const updated = await saveConnection({ id: conn.id, name: 'Updated', url: 'https://api.test.com', authMode: 'token' });
    expect(updated.id).toBe(conn.id);
    expect(updated.name).toBe('Updated');
    expect(updated.createdAt).toBe(conn.createdAt);

    const all = await loadConnections();
    expect(all).toHaveLength(1);
  });

  it('deletes a connection and removes its credentials', async () => {
    const conn = await saveConnection({ name: 'Doomed', url: 'https://api.test.com', authMode: 'token' });
    await storeCredentials(conn.id, { authToken: 'secret-token' });
    await deleteConnection(conn.id);

    expect(await loadConnections()).toHaveLength(0);
    expect(await getCredentials(conn.id)).toBeNull();
  });
});

// ── Composite key dedup ──────────────────────────────────────────────

describe('Connection dedup by composite key', () => {
  it('finds client_credentials connection by url + clientId', async () => {
    await saveConnection({ name: 'CC', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'abc123' });
    const found = await findConnectionByKey('https://api.test.com', 'client_credentials', 'abc123');
    expect(found).toBeDefined();
    expect(found!.clientId).toBe('abc123');
  });

  it('finds token connection by url + originatingSystemName', async () => {
    await saveConnection({ name: 'Token', url: 'https://api.test.com', authMode: 'token', originatingSystemName: 'MyMLS' });
    const found = await findConnectionByKey('https://api.test.com', 'token', undefined, 'MyMLS');
    expect(found).toBeDefined();
    expect(found!.originatingSystemName).toBe('MyMLS');
  });

  it('does not match different clientId on same URL', async () => {
    await saveConnection({ name: 'CC', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'abc123' });
    const found = await findConnectionByKey('https://api.test.com', 'client_credentials', 'xyz789');
    expect(found).toBeUndefined();
  });

  it('supports multiple connections on the same server', async () => {
    await saveConnection({ name: 'Prod', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'prod-id' });
    await saveConnection({ name: 'Test', url: 'https://api.test.com', authMode: 'client_credentials', clientId: 'test-id' });
    expect(await loadConnections()).toHaveLength(2);
  });
});

// ── Credentials ──────────────────────────────────────────────────────

describe('Credential storage', () => {
  it('stores and retrieves credentials', async () => {
    await storeCredentials('conn-1', { clientSecret: 'super-secret' });
    const creds = await getCredentials('conn-1');
    expect(creds?.clientSecret).toBe('super-secret');
  });

  it('returns null for missing credentials', async () => {
    expect(await getCredentials('nonexistent')).toBeNull();
  });

  it('clears credentials without deleting the connection', async () => {
    const conn = await saveConnection({ name: 'Test', url: 'https://api.test.com', authMode: 'token' });
    await storeCredentials(conn.id, { authToken: 'tok' });
    expect(await hasCredentials(conn.id)).toBe(true);

    await removeCredentials(conn.id);
    expect(await hasCredentials(conn.id)).toBe(false);

    // Connection itself still exists
    expect(await loadConnections()).toHaveLength(1);
  });
});

// ── Cert Profile CRUD ────────────────────────────────────────────────

describe('Cert Profile CRUD', () => {
  it('saves a profile linked to a connection', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    const profile = await saveProfile({
      name: 'DD 2.1 Test',
      connectionId: conn.id,
      providerUoi: 'P001',
      recipientUoi: 'R001',
      endorsements: ['dd'],
      ddVersion: '2.1',
    });
    expect(profile.id).toMatch(/^prof-/);
    expect(profile.connectionId).toBe(conn.id);
    expect(await loadProfiles()).toHaveLength(1);
  });

  it('saves a profile with no connection (local-only)', async () => {
    const profile = await saveProfile({
      name: 'RCF Local',
      connectionId: null,
      providerUoi: 'P001',
      recipientUoi: 'R001',
      endorsements: ['rcf'],
      localPath: '/path/to/data',
    });
    expect(profile.connectionId).toBeNull();
    expect(profile.localPath).toBe('/path/to/data');
  });

  it('deletes a profile', async () => {
    const profile = await saveProfile({
      name: 'Temp',
      connectionId: null,
      providerUoi: 'P001',
      recipientUoi: 'R001',
      endorsements: ['dd'],
    });
    await deleteProfile(profile.id);
    expect(await loadProfiles()).toHaveLength(0);
  });

  it('finds profiles for a connection', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    await saveProfile({ name: 'DD', connectionId: conn.id, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'] });
    await saveProfile({ name: 'Core', connectionId: conn.id, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['core'] });
    await saveProfile({ name: 'Other', connectionId: null, providerUoi: 'P2', recipientUoi: 'R2', endorsements: ['dd'] });

    const linked = await profilesForConnection(conn.id);
    expect(linked).toHaveLength(2);
  });
});

// ── Orphan handling ──────────────────────────────────────────────────

describe('Orphan handling on connection delete', () => {
  it('orphans profiles when their connection is deleted', async () => {
    const conn = await saveConnection({ name: 'MLS', url: 'https://api.test.com', authMode: 'token' });
    await saveProfile({ name: 'DD', connectionId: conn.id, providerUoi: 'P1', recipientUoi: 'R1', endorsements: ['dd'] });

    const orphanedIds = await deleteConnection(conn.id);
    expect(orphanedIds).toHaveLength(1);

    const orphans = await orphanedProfiles();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].connectionId).toBeNull();
    expect(orphans[0].name).toBe('DD');
  });
});

// ── MRU ──────────────────────────────────────────────────────────────

describe('MRU ordering', () => {
  it('orders connections by most recently used', async () => {
    const a = await saveConnection({ name: 'A', url: 'https://a.com', authMode: 'token' });
    const b = await saveConnection({ name: 'B', url: 'https://b.com', authMode: 'token' });
    const c = await saveConnection({ name: 'C', url: 'https://c.com', authMode: 'token' });

    await touchMRU(a.id);
    await touchMRU(b.id);
    await touchMRU(c.id);
    await touchMRU(a.id); // A moves to top

    const ordered = await loadConnectionsMRU();
    expect(ordered[0].name).toBe('A');
    expect(ordered[1].name).toBe('C');
    expect(ordered[2].name).toBe('B');
  });

  it('updates lastUsedAt when touching MRU', async () => {
    const conn = await saveConnection({ name: 'Test', url: 'https://test.com', authMode: 'token' });
    expect(conn.lastUsedAt).toBeUndefined();

    await touchMRU(conn.id);
    const all = await loadConnections();
    expect(all[0].lastUsedAt).toBeTruthy();
  });
});

// ── Search ───────────────────────────────────────────────────────────

describe('Connection search', () => {
  const connections = [
    { id: '1', name: 'Trestle Production', url: 'https://api.trestle.com', authMode: 'token' as const, originatingSystemName: 'TrestleMLS', createdAt: '', updatedAt: '' },
    { id: '2', name: 'Bridge Interactive', url: 'https://api.bridge.com', authMode: 'client_credentials' as const, clientId: 'bridge-id', createdAt: '', updatedAt: '' },
    { id: '3', name: 'Spark API', url: 'https://api.spark.com', authMode: 'token' as const, createdAt: '', updatedAt: '' },
  ];

  it('returns all connections for empty query', () => {
    expect(searchConnections(connections, '')).toHaveLength(3);
  });

  it('matches by name', () => {
    const results = searchConnections(connections, 'trestle');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Trestle Production');
  });

  it('matches by URL', () => {
    const results = searchConnections(connections, 'bridge.com');
    expect(results).toHaveLength(1);
  });

  it('matches by originatingSystemName', () => {
    const results = searchConnections(connections, 'TrestleMLS');
    expect(results).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    expect(searchConnections(connections, 'SPARK')).toHaveLength(1);
  });
});

// ── Utilities ────────────────────────────────────────────────────────

describe('Utilities', () => {
  it('masks secrets showing last 4 chars', () => {
    expect(maskSecret('abcdefghij')).toBe('••••••ghij');
    expect(maskSecret('ab')).toBe('••••');
  });

  it('generates composite keys', () => {
    expect(connectionKey({ url: 'https://api.com', authMode: 'client_credentials', clientId: 'abc' }))
      .toBe('https://api.com::abc');
    expect(connectionKey({ url: 'https://api.com', authMode: 'token', originatingSystemName: 'MLS' }))
      .toBe('https://api.com::MLS');
  });
});
