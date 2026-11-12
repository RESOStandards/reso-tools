# The RESO Desktop App – User Guide

The RESO desktop app brings RESO certification, the Data Dictionary and any RESO Web API server together in one
application for macOS, Windows and Linux. Anyone can browse RESO's organizations and certified endorsements in it.
RESO members can also run the official certification tests, explore their own servers and ask the RESO Assistant.

It carries its own copy of the **[RESO Reference Server](../reso-reference-server/)**, so there is a working RESO Web
API on your computer from the moment the app opens – no Docker, no Node.js and no database to install.

## Install

Download the latest release for your platform from the
**[RESO Tools releases page](https://github.com/RESOStandards/reso-tools/releases/latest)**:

* **macOS** – a signed and notarized `.dmg`. Open it and drag the app into Applications.
* **Windows** – a signed installer.
* **Linux** – an `.AppImage` or a `.deb` package. Mark an AppImage executable before its first run:
  `chmod +x RESO-*.AppImage`.

<!-- screenshot: dashboard-signed-out.png -->

The app checks for a new release each time it opens. **Help → Check for Updates…** looks right away, and
**Help → Receive Beta Updates** opts this computer in to beta releases as well.

## Signing In

Much of the app works without an account. Signing in adds the tools that come with RESO membership.

| Without signing in | Signed in as a RESO member |
|---|---|
| The dashboard, Organizations and Endorsements | Everything on the left, plus: |
| Each organization's summary and its certified reports | Browse Data, Metadata Explorer and API Documentation |
| A guide to each member feature | The Certification workspace: run tests, review results and submit them to RESO |
| | Systems and the Data Generator |
| | The RESO Assistant, while it is in a closed beta |

To sign in, choose **Sign in** at the top right and enter the email address on your RESO certification account.
RESO emails you a code; enter it to finish.

<!-- screenshot: sign-in.png -->

For questions or to join RESO, contact support+tools@reso.org.

## The Dashboard

The dashboard is the app's home page. Each card opens one part of the app: Browse Data, Metadata Explorer,
Organizations, Endorsements, Certification, the Assistant and API Documentation. Signed in, the Endorsements card also
counts the certified endorsements and how many of them are expiring soon.

<!-- screenshot: dashboard-signed-in.png -->

## Organizations

**Organizations** is RESO's directory of organizations: MLSs, technology providers and others. Search by
name, city or ID, and narrow the list by type, status and state or province. Each row shows the organization's type,
location, status and endorsements.

<!-- screenshot: organizations.png -->

Open an organization to see its summary: its endorsements, how its certified Data Dictionary results compare with the
industry, and its identifiers.

<!-- screenshot: organization-summary.png -->

## Endorsements

**Endorsements** lists RESO endorsements, grouped by the organization that received them. Anyone can open it:

* **Not signed in**, you see every certified endorsement, the same results the public RESO certification site shows.
* **A provider** also sees its own results that are still moving through certification.
* **RESO staff** see every result.

Search by organization, sort the list and filter it by endorsement and version, by date or to the endorsements whose
two years are nearly up (**Expiring Soon**). Signed in, you can also filter by status, and a provider can narrow the
list to its own results with **My Results**.

<!-- screenshot: endorsements.png -->

### A Report

Open an endorsement to read its report. Every report names the recipient, the provider and its system, the endorsement
and version, its status and links to the specification.

A Data Dictionary report has three views:

* **RESO Analytics** – the resources, fields and lookups the server offers, how much of it is standard and how much
  of each resource carries data, resource by resource, with industry comparisons.
* **Server Explorer** – every field and lookup value the server advertised, with how often each carries data. Filter
  by resource, by standard or local elements and by how much data they hold.
* **Performance** – how quickly the server answered during the test, compared with the industry.

<!-- screenshot: certification-2.png -->

Web API Core reports show the version tested, how the server was reached and the tests that ran. Other endorsements
show their version, status, report date and remarks.

The report's provider and RESO staff also see where the report stands in certification – Passed, Notified, Certified –
and whose move is next. When the move is theirs, the actions RESO's certification site offers are on the report too.

## The Certification Workspace

The Certification workspace is where RESO members run the same tests RESO uses to certify, see exactly where a system
meets the standard, and send passing results to RESO. Sign in to use it.

### What It Tests

* **Data Dictionary** – a server's metadata and data against a Data Dictionary version.
* **Web API Core** – the server's OData behavior: queries, paging, expansions and more.
* **Web API Add/Edit** – creating, updating and deleting records, for the actions and formats you support.
* **EntityEvent** – the server's change feed.
* **RESO Common Format** – files of records rather than a server: a `.json` file, a folder of them or a `.zip`,
  scored against a Data Dictionary version.

### Starting a Test Run

Choose **New Test Run** on the **Test Runs** page. Pick the provider and recipient from RESO's directory, enter the
server's address and how to sign in to it, and choose the endorsements to test. For RESO Common Format, drop or choose
the files instead of a server. A test run can cover several recipients at once.

<!-- screenshot: new-test-run.png -->

To try it without a server of your own, leave the address blank: the run tests the reference server inside the app.

Configurations are saved, so a run can be repeated later. They can also be exported and imported as JSON.

### Following a Run

The **Test Runs** page shows each run as it goes: every step, what it found and how long it took. Finished runs stay
on this computer between launches. Run one again, or delete those you no longer need.

<!-- screenshot: test-runs.png -->

Each finished run has its report:

* **A passed run** lists every step and, for Web API Core, Add/Edit and EntityEvent, every scenario it ran.
* **A failed run** shows what failed in the clearest form for that failure: Data Dictionary values the schema did not
  accept, grouped by message; suggested mappings for local names that look like standard ones; or the scenario that
  failed, with what was expected and what came back.

<!-- screenshot: run-report.png -->

Every report can be downloaded, and links to the specification it tested.

### Submitting to RESO

When a run passes on your computer, **Submit to RESO** starts the official run in RESO's cloud. The Test Runs page
lists your organization's cloud runs – scheduled, running and finished – whoever started them, and a finished run
opens its report.

### The Certification Dashboard

The dashboard summarizes your testing: how many runs, for how many recipients, what is running or queued, recent
passes and failures, and the endorsements that are expiring soon.

<!-- screenshot: certification-1.png -->

### Variations Review

A Data Dictionary run lists the local fields and values that look like standard ones. **Variations Review** is where a
provider goes through them one by one and sends its review to RESO.

### Notifications

The bell at the top of the window collects what has happened to your organization's runs, reports and reviews. Open a
notification to go straight to what it is about.

## Browsing and Searching

Signed in, **Browse Data** opens the records on the connected server, resource by resource: Property, Member, Office,
Media and the rest. Search on any field, combine conditions and page through the results. Each record opens to all
of its fields, grouped and labeled from the server's own metadata. Where the server allows it, you can add, edit and
delete records from the same pages.

<!-- screenshot: browse-data-1.png -->
<!-- screenshot: browse-data-2.png -->

The app shapes itself to whichever server it is connected to: the resources, fields, lookup values and forms all come
from that server's metadata.

## Metadata Explorer

**Metadata Explorer** lays out what a server advertises: each resource, its fields with their types, the lookups behind
its enumerations and how resources relate through expansions. Use it to check that a server offers the elements your
work needs, down to a single lookup value.

<!-- screenshot: metadata-explorer-1.png -->
<!-- screenshot: metadata-explorer-2.png -->

## API Documentation

**API Documentation** is the reference server's interactive API documentation. Every endpoint is listed with its
parameters, and you can send a request and read the response from the same page. It is available while the app is
connected to its own reference server.

<!-- screenshot: api-documentation-1.png -->
<!-- screenshot: api-documentation-2.png -->

## Connecting to Servers

The app starts connected to its own reference server. Signed in, the server switcher at the top of the window adds
other RESO servers and moves between them.

<!-- screenshot: connections.png -->

To add a server, give it a name and its address, then choose how to sign in to it:

* **Bearer Token** – paste a token, and the app sends it with every request.
* **OAuth2 Client Credentials** – give the client ID, client secret and token address. The app fetches a token when it
  needs one and renews it before it expires.

### How Credentials Are Kept

Tokens and secrets are written to disk only encrypted by the operating system: the login keychain on macOS, DPAPI on
Windows and the keyring on Linux. The first time you save one, the app explains what is about to happen. If the
operating system cannot encrypt it, the app keeps the credential for this session only and never writes it in plain
text.

## The Built-In Reference Server

The reference server inside the app starts when the app opens, on a free port of its own, with its own database. It
serves the RESO Data Dictionary 2.0 by default; **Server → Data Dictionary Version** switches it, and
**Server → Restart Server** restarts it.

Because it is a real RESO server at `http://localhost:<port>`, other tools can use it too: the
**[RESO Client SDK](../reso-client/)**, the **[RESO Certification](../reso-certification/)** command line, `curl`
or an AI agent through the **[RESO MCP Server](../reso-mcp-server/)**. **Connection Info** in the sidebar shows its
address.

Members can fill it with realistic records using the **Data Generator**, in the sidebar beside Connection Info: choose a
resource, how many records to create and which related records to create with them.

## The RESO Assistant

The RESO Assistant answers questions about RESO standards in plain language: the Data Dictionary, how fields and values
are used across the industry, certification, the Web API and what is up for a vote. Every answer lists its sources –
a ratified definition, a release note, a proposal or an adoption measurement – so you can read them yourself. Ask a
follow-up and the Assistant keeps the thread.

The Assistant is in a closed beta for RESO members. To ask for access, write to dev+assistant@reso.org.

<!-- screenshot: assistant-1.png -->
<!-- screenshot: assistant-2.png -->

### Questions to Try

**Getting started**
* What kinds of questions can you answer?

**The Data Dictionary**
* What changed in the Data Dictionary 2.1 release?
* Is StandardStatus open to local values?
* How should I send a lookup value that isn't in the Data Dictionary?
* I have a color I want to express for my house in my listing – how would I do that using the DD?

**How the industry uses it**
* Which InteriorFeatures values are most used, and how many organizations use each?

**The Web API**
* How do I filter a multi-select lookup like Appliances?
* Can I use $expand on Property to get Media in Web API Core?

**Certification**
* I want to get certified on RESO Common Format – what are the steps?
* Will our local fields and lookups count against us in certification?

**Workgroups**
* What is currently up for a vote at RESO?
* How do I propose a new field for the Data Dictionary?

**New conversation** starts over, and the download button saves the conversation as a Markdown file.

## Diagnostic Logging

The app writes a log for support and troubleshooting:

```
~/Library/Application Support/RESO/reso-desktop.log   (macOS)
%APPDATA%\RESO\reso-desktop.log                        (Windows)
~/.config/RESO/reso-desktop.log                        (Linux)
```

It records what the app does – the reference server starting, connections, sign-ins and test runs – but not the
contents of requests or responses, and never credentials. If you report a problem, it helps to attach it.

## Usage Data

**Help → Share Usage Data** is off until you turn it on. When it is on, the app tells RESO which screens you open and
which kind of test you start, with the app version and your operating system. RESO counts these with Google Analytics
to learn which parts of the app people use; Google Analytics also records a rough location, such as the country.

The app never sends your name, email address, organization, server addresses, saved configurations, credentials,
reports or results. Turning the setting off stops sending and deletes the random ID that groups this computer's visits.
**Help → About Usage Data…** shows this explanation in the app.

## Where to Next

* **[RESO Certification](../reso-certification/)** – the same tests as a command line and an SDK, for CI and scripts.
* **[RESO Reference Server](../reso-reference-server/)** – the server inside the app, to run on its own or in Docker.
* **[RESO Client SDK](../reso-client/)** – the OData client the app is built on.
* **[RESO MCP Server](../reso-mcp-server/)** – connect an AI agent to a RESO server.
* **Report an issue** – **Help → Report an Issue** in the app.
