/**
 * Connection I/O — import/export for connections and cert profiles.
 *
 * Export format:
 *   { version: 1, connections?: [...], profiles?: [...] }
 *
 * Three independent toggles control what's included:
 *   - Connections
 *   - Cert Profiles
 *   - Include Credentials (only with Connections)
 *
 * On import, connections are matched by composite key (url + clientId
 * or url + originatingSystemName). Conflicts produce a diff for the
 * user to resolve. Cert profiles without matching connections prompt
 * the user to pick or create one.
 */

import {
  loadConnections,
  loadProfiles,
  getCredentials,
  findConnectionByKey,
  type SavedConnection,
  type CertProfile,
  type StoredCredentials,
} from './connection-manager';

// ── Export format ────────────────────────────────────────────────────

export interface ExportPayload {
  readonly version: 1;
  readonly connections?: ReadonlyArray<ExportedConnection>;
  readonly profiles?: ReadonlyArray<CertProfile>;
}

export interface ExportedConnection extends SavedConnection {
  readonly credentials?: StoredCredentials;
}

export interface ExportOptions {
  readonly includeConnections: boolean;
  readonly includeProfiles: boolean;
  readonly includeCredentials: boolean;
}

/** Build an export payload based on the selected toggles. */
export const buildExportPayload = async (options: ExportOptions): Promise<ExportPayload> => {
  const payload: { version: 1; connections?: ExportedConnection[]; profiles?: CertProfile[] } = { version: 1 };

  if (options.includeConnections) {
    const connections = await loadConnections();
    const exported: ExportedConnection[] = [];
    for (const conn of connections) {
      if (options.includeCredentials) {
        const creds = await getCredentials(conn.id);
        exported.push(creds ? { ...conn, credentials: creds } : conn);
      } else {
        exported.push(conn);
      }
    }
    payload.connections = exported;
  }

  if (options.includeProfiles) {
    payload.profiles = [...await loadProfiles()];
  }

  return payload;
};

/** Download an export payload as a JSON file. */
export const downloadExport = (payload: ExportPayload, filename = 'reso-connections'): void => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

// ── Import ───────────────────────────────────────────────────────────

/** A field-level diff for a connection conflict. */
export interface FieldDiff {
  readonly field: string;
  readonly existing: string | undefined;
  readonly incoming: string | undefined;
}

/** A connection conflict detected during import. */
export interface ImportConflict {
  readonly existing: SavedConnection;
  readonly incoming: ExportedConnection;
  readonly diffs: ReadonlyArray<FieldDiff>;
}

/** Result of analyzing an import payload before applying it. */
export interface ImportAnalysis {
  /** Connections that don't exist yet — will be added. */
  readonly newConnections: ReadonlyArray<ExportedConnection>;
  /** Connections that match an existing one with different values. */
  readonly conflicts: ReadonlyArray<ImportConflict>;
  /** Connections that match exactly — no action needed. */
  readonly unchanged: ReadonlyArray<ExportedConnection>;
  /** Profiles whose connectionId doesn't match any existing or imported connection. */
  readonly orphanedProfiles: ReadonlyArray<CertProfile>;
  /** Profiles that can be imported directly (connectionId matches or is null). */
  readonly validProfiles: ReadonlyArray<CertProfile>;
}

const DIFF_FIELDS: ReadonlyArray<keyof SavedConnection> = ['name', 'url', 'authMode', 'clientId', 'tokenUrl', 'scope', 'originatingSystemName', 'originatingSystemId'];

/** Compare two connections and return field-level diffs. */
const diffConnections = (existing: SavedConnection, incoming: ExportedConnection): ReadonlyArray<FieldDiff> =>
  DIFF_FIELDS
    .map(field => ({
      field,
      existing: String(existing[field] ?? ''),
      incoming: String(incoming[field] ?? ''),
    }))
    .filter(d => d.existing !== d.incoming);

/** Analyze an import payload against current state. */
export const analyzeImport = async (payload: ExportPayload): Promise<ImportAnalysis> => {
  const newConnections: ExportedConnection[] = [];
  const conflicts: ImportConflict[] = [];
  const unchanged: ExportedConnection[] = [];

  if (payload.connections) {
    for (const conn of payload.connections) {
      const match = await findConnectionByKey(
        conn.url,
        conn.authMode,
        conn.clientId,
        conn.originatingSystemName
      );
      if (!match) {
        newConnections.push(conn);
      } else {
        const diffs = diffConnections(match, conn);
        if (diffs.length > 0) {
          conflicts.push({ existing: match, incoming: conn, diffs });
        } else {
          unchanged.push(conn);
        }
      }
    }
  }

  // Check profiles against known connection IDs
  const existingConnections = await loadConnections();
  const allConnectionIds = new Set([
    ...existingConnections.map(c => c.id),
    ...newConnections.map(c => c.id),
  ]);

  const orphanedProfiles: CertProfile[] = [];
  const validProfiles: CertProfile[] = [];

  if (payload.profiles) {
    for (const profile of payload.profiles) {
      if (profile.connectionId === null || allConnectionIds.has(profile.connectionId)) {
        validProfiles.push(profile);
      } else {
        orphanedProfiles.push(profile);
      }
    }
  }

  return { newConnections, conflicts, unchanged, orphanedProfiles, validProfiles };
};

/** Read and parse a JSON file from the user's filesystem. */
export const readImportFile = (): Promise<ExportPayload | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as ExportPayload;
        if (parsed.version !== 1) { resolve(null); return; }
        resolve(parsed);
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
