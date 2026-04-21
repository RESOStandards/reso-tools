# Connection Manager Plan

## Overview

Redesign how connections and credentials are stored and managed across the desktop client. Separates server connections (with credentials in safeStorage) from cert-specific configuration profiles. Provides a unified connection manager accessible to all users, with cert features layered on top.

---

## Architecture

### Data Model

**SavedConnection** — server identity + auth credentials
- Stored: credentials in safeStorage, metadata in plain storage
- Fields: id, serverUrl, authMode, clientId, clientSecret (secure), tokenUrl, scope, authToken (secure), displayName, originatingSystemName

**CertProfile** — endorsement-specific test configuration
- Stored: plain storage
- Fields: id, connectionId (FK → SavedConnection), endorsements, ddVersion, limit, strictMode, requestDelay, rateLimitWait, providerUoi, recipientUoi, providerUsi

---

## Open Questions

### 1. Connection Identity and Deduplication

> What uniquely identifies a connection — server URL alone, or server URL + auth identity (clientId or token)? Could someone legitimately have two different credential sets for the same server?

**Decision:** Server URL + auth identity. Multiple credential sets per server is common (test vs. production accounts, different providers on the same API gateway). For client_credentials, the composite key is serverUrl + clientId. For token-based, serverUrl + originatingSystemName.

### 2. Overlay vs. Page

> When a non-cert user opens the connection manager overlay from the server switcher (>5 connections), should they see cert profile columns/features, or a simplified view? Same component with cert columns hidden when no profiles exist?

**Decision:** Connection manager is purely about connections — server URL, credentials, display name. No cert-specific fields ever shown there. Cert profiles are created and managed only from the cert side: either the Saved Configs page or the new job flow (then saved). The connection manager is the same component for all users.

### 3. Import/Export Format

> Current configs page has an export. Now that connections and cert profiles are separate, should the export bundle both? Should credentials be excluded by default (user opts in or re-enters after import)?

**Decision:** Export dialog has three independent toggles: "Connections," "Cert Profiles," and "Include Credentials" (only relevant when Connections is on). All three combinations are valid — connections can export alone, cert profiles can export alone (some endorsements like RCF are local-only with no connection, just a file path), or both together. The connectionId FK from CertProfile → SavedConnection is optional. On import without credentials, empty credential fields trigger existing form validation so the user fills them in. On import of cert profiles without matching connections, match by connectionId to existing connections; if not found, prompt to pick or create one. Export files carry reference IDs so connections and profiles can be stitched together on import.

### 4. Credential Lifecycle — Deletion

> When a user deletes a connection that has cert profiles attached, cascade-delete the profiles? Or orphan them and prompt "this profile has no connection, pick one"?

**Decision:** Orphan them, but warn first. On delete, show a confirmation that lists the cert profiles that will lose their connection. Profiles keep their config but connectionId goes null. When the user next tries to run an orphaned profile, prompt to pick or create a connection.

### 5. Credential Lifecycle — Clearing

> Should there be a way to clear just the credentials from a connection without deleting the whole thing? Useful for sharing configs minus secrets.

**Decision:** Yes. Connection cards have a "Clear Credentials" action that wipes secrets from safeStorage but keeps the connection metadata (server URL, display name, auth mode, clientId, tokenUrl). Form validation catches the empty fields when the user next tries to connect or run a job.

### 6. Resource Browser Integration

> When a cert user clicks a connection in the manager, should it connect and navigate to the resource browser for that server? Or is that a separate explicit action?

**Decision:** Connection manager has a select/search action on each connection. Choosing one sets the active server context (same as the server switcher) and pushes it to the top of the MRU list. User then navigates to the resource or metadata browser on their own when ready. No automatic navigation on select. Always-visible search bar at the top of the connection manager — search-as-you-type filters on display name, server URL, and originatingSystemName. MRU ordering by default, search results keep MRU as a tiebreaker. Supports hundreds of connections.

### 7. Password Field Component

> The masked input with the eye toggle from the server connection modal — is that the component to reuse, or is there a different one?

**Decision:** Yes, reuse the existing masked input with eye toggle from the server connection modal on all connection cards for credential fields (clientSecret, authToken).

### 8. Auto-save Overwrite Behavior

> Credentials are auto-saved when a job starts. If the user later runs the same config with different credentials (rotated secret), silently overwrite or prompt?

**Decision:** Prompt. "Credentials have changed, update saved connection?" User can accept (overwrite) or decline (run with one-time credentials without updating the saved connection).

---

## User Flows

### Non-Cert User

1. Opens server switcher dropdown
2. Sees saved connections (up to 5 inline)
3. If >5, sees "Manage Connections" link
4. Link opens connection manager overlay (modal/drawer) over current page
5. Can add, edit, delete connections
6. Can edit credentials inline with masked password fields
7. Clicking a connection switches to that server

### Cert User — New Job with No Saved Credentials

1. Opens cert dashboard, starts new job
2. Enters credentials inline in config builder (no saved connection required)
3. Option to save credentials before running
4. On job start, credentials auto-saved to a SavedConnection
5. CertProfile created/updated linking to that connection

### Cert User — Editing After Failure

1. Job fails, user edits config (changes credentials or params)
2. On clicking "Run" with changed credentials, prompted: "Save updated credentials?"
3. If yes, SavedConnection updated before job starts
4. If no, job runs with one-time credentials (not persisted)

### Cert User — Importing Configs

1. User imports a config file (JSON) — may contain connections, cert profiles, or both
2. System matches connections by composite key (serverUrl + clientId for client_credentials, serverUrl + originatingSystemName for token-based)
3. If conflict found, shows diff view:
   - Left column: existing values
   - Right column: incoming values
   - Changed fields highlighted
4. User chooses: Keep Existing | Use Imported | Cancel
5. If credentials were excluded from the export, imported connections have empty credential fields — user fills them in via form validation
6. Cert profiles without matching connections prompt to pick or create one

---

## Removals

- [ ] Remove "Save Batch Config" from job step output
- [ ] Remove `saveConfigToStorage` call in `startBatch`
- [ ] Remove `saveJobConfigToStorage` per-job save
- [ ] Remove `CONFIG_STORAGE_KEY` and related load/save functions
- [ ] Remove static credential storage warning on the jobs page (the save confirmation prompt is sufficient)

---

## Components

- **ConnectionManagerOverlay** — modal/drawer wrapping the connection manager, launchable from server switcher
- **ConnectionCard** — editable card for a SavedConnection, with masked credential fields
- **CertProfileCard** — cert-specific config attached to a connection
- **ImportDiffView** — side-by-side diff for import conflicts
- **MaskedInput** — reuse existing password toggle component (Q7)
