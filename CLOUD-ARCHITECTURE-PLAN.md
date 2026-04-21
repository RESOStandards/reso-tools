# Cloud Architecture Plan

## Concerns

### 1. Job Lifecycle
How does a certification test go from "user clicks run" to "results available"? What are the states, who transitions them, and where does each state live?

### 2. Long-Running Processes
Some certification runs take hours or weeks (large sequential batches). What infrastructure supports that without timeout limits, and how does the user stay informed of progress?

### 3. Results Delivery
When a test completes, where do the raw results go, who gets notified, and how do results get back to the user and into the Cert API?

### 4. Job Coordination
When multiple jobs run concurrently for different providers, how do they avoid stepping on each other? How is parallelism managed?

### 5. Credential Isolation
Each job runs with a provider's credentials. How are credentials delivered to the job runner without exposing them to other jobs or persisting them?

### 6. Progress Visibility
During a running job, how does the user see what's happening? Polling? WebSocket? What granularity — step-level, record-level?

### 7. Local/Cloud Parity
The same certification SDK runs locally on a desktop and in the cloud. How do we ensure the same code produces the same results in both environments? What differs between local and cloud?

### 8. Failure Recovery
If a job fails mid-run (infrastructure issue, not a test failure), what happens? Can it resume, or does it start over? Who gets notified?

### 9. Access Control
Which roles can submit jobs, view results, cancel jobs? How does the provider's identity flow from the API Gateway through to the job runner?

### 10. Variations Integration
After a DD test produces variations, how do those feed into the variations review service? Is that automatic or user-initiated? How does a retest interact with an in-progress review?

---

## Workflow (from discussion 2026-04-20)

### Job Submission
- Provider can only start jobs for their own account. Admin can start for any provider/system/recipient.
- User may choose parallelism level at job start — relevant when a config has multiple recipients.
- Jobs can start from desktop client, CLI, or cloud submission.

### Job State (DynamoDB)
- DynamoDB is the global state store for all job/endorsement status. 100% schema control.
- Needs: durable store of endorsements/jobs with statuses, and the ability to notify users.
- Status updates pushed to DynamoDB at every step transition — works the same whether running locally (admin machine) or in the cloud. Normal CLI/desktop users cannot push to AWS; they can only submit jobs, poll, and review.

### Notification Delivery
- **Option A**: Poll DynamoDB for status changes
- **Option B**: Poll individual SQS queues (better separation, especially with multiple notification types)
- **Requirements**:
  - Show failures immediately
  - Daily digest summaries (passed, failed, running)
  - Pass notifications may be too noisy — make it a preference?

### Artifacts (S3)
- Each job gets a unique S3 folder for all testing artifacts
- S3 is environment-aware (qa/staging/prod)
- Currently versioned AWS buckets — could switch to current/archived structure
- When a cloud job starts, old results need rotation. *Come back to this — Josh has ideas.*
- **Requirement**: all testing artifacts in a unique bucket/prefix for that job

### Step Progress
- Each DD step (auth, service check, metadata, variations, replication, schema validation, data availability) updates DynamoDB on pass/fail
- Same code path for local and cloud runs
- Cloud runs additionally push status to AWS endpoints (via env-driven callbacks)

### Job Completion
When finished, all of these must be true:
1. All output in S3
2. DynamoDB has accurate job state (with some historical info — *scope TBD*)
3. Results posted to Cert API (passed or failed) — need care with new success/failure report formats
4. User notified

### Notification Architecture — Future Direction
- **Current**: Cert API handles notifications (customer approval emails)
- **Option A**: Keep in Cert API, add a flag when pushing results to trigger notification
- **Option B**: Manage in SES after Cert API push (know results are available before notifying)
- **Long-term**: Move everything to SES, move endorsements list from Cert API/ES to DynamoDB, keep ES for analytics only
- **Question**: Is the indirection of DynamoDB → ES → endorsements worth it, or just keep storing endorsements in ES and query directly?

---

## Open Decision Points

### D1. DynamoDB Schema for Jobs
We have 100% schema control. What does the job record look like? Partition key, sort key, GSIs? How much history to keep vs. archive?

**Decision:** New table `jobs` with flat fields, no packed keys.
- PK: `providerUoi`, SK: `jobId` (timestamp-first, sortable)
- Fields: recipientUoi, providerUsi, endorsement, version, environment, status, statusTimestamp, submittedAt, startedAt, completedAt, submittedBy, reportUrl, s3Prefix, failedStep, localPassTimestamp
- GSI 1: `environment#status` + `statusTimestamp` (all running jobs)
- GSI 2: `recipientUoi` + `jobId` (jobs by recipient)

### D2. Notification Channel
DynamoDB polling vs. SQS per-user queues vs. hybrid? SQS gives better isolation for different notification types.

**Decision:** Unified notification system with WebSocket as primary in-app delivery.
- One `notifications` table for all event types (jobs, variations, endorsements, future). PK: `recipientUoi`, SK: `notificationId` (timestamp-first). Fields: eventType, status (unread/read/dismissed), summary, sourceId, sourceType, priority (immediate/digest/silent), emailSent, etc.
- GSI: `recipientUoi#status` + `createdAt` for fast unread queries.
- WebSocket for real-time push to connected clients (~100 users max). Existing WS API Gateway at `/ws` with connect/disconnect/default Lambdas (need cleanup).
- Notifications table as durable fallback for offline catch-up on reconnect.
- SES for email: immediate on failures, daily digest scheduled Lambda, pass notifications opt-in via user prefs.
- Event flow: DynamoDB Streams / Lambda → write to notifications table + push to WebSocket + queue SES based on priority.
- Heartbeat: 30-second server ping to keep connections alive and clean up stale sessions.

### D3. S3 Artifact Rotation
Current/archived pattern vs. S3 versioning? When a new job starts, how are old results handled?

**Decision:** All timestamped in S3, no rotation needed — each job gets a unique prefix via `s3Prefix` in the jobs table. Keep all raw results indefinitely (any could become a certification candidate). Store compressed (gzip) to stay under Lambda limits if files need to be served. Locally, keep the `current` symlink pointing to the latest timestamped folder — people depend on it for scripts and batch workflows.

### D4. DynamoDB History Depth
How much historical info stays in DynamoDB vs. gets archived? Full step-by-step history, or just latest status + summary?

**Decision:** Keep everything in DynamoDB for now. At current volume, cost is negligible. Natural archive boundary is major DD versions — when 3.0 ships, archive 2.0 job records to S3 and prune. Can add TTL or backup-to-S3 pattern later.

### D5. Endorsements Storage
Keep in Elasticsearch (current) or move to DynamoDB? ES for analytics only?

**Decision:** Future migration, not blocking cloud jobs. Plan: DynamoDB as source of truth for endorsements (global state with history, easy S3 backup), ES for analytics/search only. Public feed stays as a static S3 file — scheduled Lambda dumps from DynamoDB, replaces the current scraper. Migration path: keep Cert API/ES for now → dual-write → cut over to DynamoDB as primary.

### D6. Notification Preferences
Immediate failures + daily digest is the baseline. Should pass notifications be opt-in? Per-endorsement prefs?

**Decision:** New `userPrefs` table in DynamoDB. PK: `providerUoi`. Default prefs: emailOnFailure=true, emailDigest=true, emailOnPass=false. Extensible for future prefs. In-app (WebSocket) notifications always on — lightweight, dismissible. Email controlled by prefs. Notification Lambda checks prefs before sending SES.

### D7. Cert API Push Timing
Push results to Cert API before or after notification? If before, notification can include a link to the results. If after, risk of "click and nothing's there."

**Decision:** Push to Cert API first, then notify. Results must be ingested before the user sees the notification — the link needs to resolve immediately. This applies to both success and failure paths.

### D8. Local vs. Cloud Divergence
What specifically differs between local and cloud runs? Just the callbacks (status push to DynamoDB, results to S3/Cert API), or anything else?

**Decision:** Same SDK everywhere. Divergence is only in what the environment can reach:
- **Cloud mode** (env var + IAM credentials): direct AWS SDK calls for DynamoDB status, S3 artifacts, Cert API push, SQS/SES notifications. Both success and error paths push results and notify.
- **Local mode**: results stay local, `current` symlink updated, no AWS access.
- **Admin local**: can run cloud mode from their machine with IAM credentials — indistinguishable from Batch.
- **Provider local**: test only, no AWS callbacks. Must pass locally before cloud submission via API Gateway.
