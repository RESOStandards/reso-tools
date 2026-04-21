# Variations Report Plan

## Overview

Port the variations review workflow from the legacy reso-certification React app to reso-tools. The user tests locally, gets variations blended with the services.reso.org suggestions service, reviews them in a collaborative UI with locking, comments and Fast Track/Ignore actions, and saves changes back to S3 via the services API.

No Cert API placeholder is needed — the variations review is a self-contained module that communicates only with services.reso.org.

---

## Data Flow

```
1. User runs DD cert test locally (already works)
2. SDK produces variations via computeVariations() (already in src/legacy/lib/variations/)
3. UI fetches suggestions from services.reso.org/certification/variations/search
   (requires auth — provider token from login)
4. Machine results + service suggestions blended in the UI
5. User reviews: Fast Track, Ignore, or Comment on each item
6. User saves → POST to services.reso.org variations-reports endpoint
7. SQS notification fires → admin polls and sees update
8. Admin reviews, responds → provider polls and sees response
9. Repeat until resolved
```

---

## Open Questions

### 1. Auth Flow for Variations Service

> The user needs to log in to get a provider token. The legacy app uses OAuth2 with the provider token from `requestProviderToken()`. We already have this in `auth-context.tsx` and `cert-client.ts`. Is that the same token, or does the variations service need a separate auth scope?

**Decision:** Authenticate with Cert QA API (staging/prod) first — it proxies to services.reso.org and returns a provider token with a timestamp. That provider token is then used as a Bearer token directly on all services.reso.org endpoints (variations, locks, notifications). Token can be refreshed via a PATCH endpoint (TBD). The existing `requestProviderToken()` flow handles step 1.

### 2. Where Does the Variations UI Live?

> Options:
> - **A)** A new top-level page under `/cert/variations` (standalone review experience)
> - **B)** Embedded in the failure report modal (current error-reports.tsx already has a VariationsReportView)
> - **C)** Both — the existing renderer shows read-only results, a separate page handles the full review workflow with locking/comments/save

**Decision:** Option C. Read-only summary in the failure report, full collaborative review on a dedicated page. Card-per-variation layout (not a dense table): red header with the non-standard item, correction sub-row with match-type labels (Exact Match, Edit Distance, Fast Track). Actions per card. Comments expand inline, not in popovers. CSV export with quoted identifiers for tabular view, CSV import in the common format for bulk resolution. Keep it human-friendly — labels and tooltips explain match types, no need for colored badges.

### 3. Local State vs. Service State

> The legacy app stores pending actions (ignore, fast track, comments) in localStorage until the user clicks Save. This prevents accidental data loss but means unsaved work is device-specific. Should we keep this pattern or use a different approach (e.g., auto-save drafts to Electron storage)?

**Decision:** localStorage. Durable across refresh/restart, works in both desktop and web, no Electron dependency. Device-specificity is fine since the lock is also device-specific. Consolidated from legacy's three channels into one keyed store: `variations-draft:{reportId}` holding ignore flags, fast track flags, selected suggestions, and comments together. Cleared on successful save.

### 4. Lock Scope

> The legacy app locks by `{version}/{providerUoi}/{providerUsi}/{recipientUoi}/{certificationRequestId}`. Since we're not creating cert requests, what's the lock resource ID? Just `{version}/{providerUoi}/{providerUsi}/{recipientUoi}`?

**Decision:** Generate a deterministic `certificationRequestId` from a hash of `version+providerUoi+providerUsi+recipientUoi`. Same test params always map to the same conversation thread. The full history (original report + changes + conversations) lives in the S3 document, so no database FK is needed. The backend `createLock` doesn't validate the `resourceId` format — it's just a required string stored as a DynamoDB sort key. Lock `resourceId` uses a descriptive path format: `variations/{version}/{providerUoi}/{providerUsi}/{recipientUoi}` (readable in DynamoDB). No IP in the key — IP is already in the session.

### 5. Fuzziness Control

> The legacy app has a fuzziness slider (0–50, step 5, default 25%). Should we keep that slider or simplify to a fixed default? Most users probably never touch it.

**Decision:** Keep fuzziness control, default 25%. Display as inline value with pencil icon to edit (saves space vs. a slider). Labeled "Match Sensitivity: 25%". Note: "RESO uses 25% for certification. Higher values find more potential matches but may include false positives." If user changes from 25%, show a subtle indicator they're off the cert default.

### 6. CSV Export

> The legacy app supports CSV export of variations. Keep it?

**Decision:** Yes. Export as RFC 4180 CSV — only quote fields that contain commas, newlines, or double quotes. On import, accept both quoted and unquoted (standard CSV parsers handle mixed quoting). Common format matches the legacy JSON→CSV shape from the existing code.

### 7. Backend Work Needed

> Looking at the services.reso.org endpoints, is anything missing or needing updates for the new workflow? The current endpoints seem complete (variations search, save report, locks, notifications). Any changes needed?

**Decision:** Backend endpoints are ready for the provider-side workflow. The remaining backend work is setting up the SQS service notifications to get picked up and saved to the actual variations service — that's for when reports are "resolved" by admin. We'll discuss that when we get to the admin resolution flow.

---

## Architecture

### Services Layer (new file: `services/variations-service.ts`)

Client for services.reso.org variations endpoints:

- `searchVariations(metadataReport, token)` → POST `/certification/variations/search`
- `getVariationsReport(version, providerUoi, providerUsi, recipientUoi, certRequestId, token)` → GET `/certification/variations-reports/...`
- `saveVariationsReport(payload, token)` → POST `/certification/variations-reports/...`
- `searchLocks(resourceId, token)` → POST `/locks/search`
- `createLock(payload, token)` → POST `/locks`
- `deleteLock(resourceId, providerUoi, token)` → DELETE `/locks`
- `searchNotifications(params, token)` → POST `/notifications/search`
- `markAsRead(notificationId, token)` → PATCH `/notifications/mark-as-read`

### Variations Blender (new file: `services/variations-blender.ts`)

Merges local `computeVariations()` output with service suggestions:

- Takes local variations + service suggestions map
- For each item: if service has suggestions (including ignored/fast-tracked), use those; otherwise fall back to machine suggestions
- Returns unified variations report ready for UI display

### UI Components

**VariationsReviewPage** — full review experience

- Search bar with filter tabs (Fields / Lookups / Resources) and counts
- Variations table with:
  - Resource, field, lookup value columns
  - Suggestion column (clickable to accept)
  - Actions: Fast Track (rocket), Ignore (X), Comment (chat)
  - Status indicators (pending, accepted, ignored, fast-tracked)
- Lock indicator (UserInfoPopover) showing who has the lock
- Save/Cancel buttons (disabled in read-only mode)
- Unsaved changes warning on navigation
- Notification alert when the other party saves changes

**CommentsPopover** — per-item comment thread

- Growing textarea, link/attachment support
- Shows conversation history with timestamps
- "From" is provider, "To" is RESO Admin (or vice versa)

**LockBanner** — top banner showing lock status

- Green: "You have the lock" with expiry countdown
- Red: "Locked by {name}" with email link
- Reissue button when lock is expiring

### State Management

- Pending actions stored in localStorage (same pattern as legacy)
- Keys: `variations:ignore:{reportId}`, `variations:fasttrack:{reportId}`, `variations:comments:{reportId}`
- Cleared on successful save
- `useBlocker` prevents navigation with unsaved changes

### Notification Polling

- Poll `searchNotifications` on interval when variations page is open
- Show alert modal when the other party saves
- "Refresh" button reloads the report with latest data

---

## Implementation Order

1. **Services layer** — API client for services.reso.org endpoints
2. **Variations blender** — merge local + service suggestions
3. **Variations review page** — main UI with table, filters, actions
4. **Comments popover** — per-item conversation thread
5. **Lock management** — create/delete/reissue with UI indicators
6. **Save flow** — build payload, POST to service, clear local state
7. **Notification polling** — detect updates, alert, refresh
8. **Wire into job flow** — after DD test, "Review Variations" button opens the page

---

## What Already Exists in reso-tools

- `src/legacy/lib/variations/` — `computeVariations()`, `findVariations()`, matching strategies
- `error-reports.tsx` — `VariationsReportView` component (read-only display with Fast Track/Ignore buttons, but no save/lock/comments/notifications)
- `auth-context.tsx` / `cert-client.ts` — provider token auth
- `useJobs` hook — job state management (can attach variations to completed jobs)

## What Exists in Legacy App (to port)

- `client/components/VariationsReport/` — full review UI (index.js, Actions.js, Comments.js, Table.js, SubHeader.js, UserInfoPopover.js, utils.js, constants.js)
- `client/apis/reports/variations.js` — API client for services.reso.org
- `client/contexts/notifications.js` — notification polling context

## Backend Endpoints (services.reso.org — already deployed)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/certification/variations/search` | POST | Get suggestions for a metadata report |
| `/certification/variations-reports/{ver}/{pUoi}/{pUsi}/{rUoi}/{certReqId}` | GET/POST | Get/save variations report |
| `/locks` | POST/DELETE | Create/delete lock |
| `/locks/search` | POST | Check existing locks |
| `/notifications/search` | POST | Poll for updates |
| `/notifications/mark-as-read` | PATCH | Mark notification read |
