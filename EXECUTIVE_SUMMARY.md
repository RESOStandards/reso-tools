# RESO Tools — What We've Built

**RESO Tools** is an open-source toolkit that makes it easier for the real estate industry to adopt, test, and work with RESO data standards. Everything lives in one place — one repository, one install, one set of docs.

## The Reference Server

We built a fully working OData server that implements the RESO Web API specification out of the box. It reads the RESO Data Dictionary and automatically creates everything a vendor would need — database tables, API endpoints, documentation. It supports three database engines (PostgreSQL, MongoDB, SQLite) and covers Property, Member, Office, Media, OpenHouse, Showing, Teams, and more.

It comes with a modern web UI for browsing and editing records — complete with search, field groups, media display, and a metadata explorer. There's also a landing page, mobile-responsive layout, and support for connecting to external OData servers (not just the built-in one).

## The Desktop Client (New in v0.2)

We wrapped the reference server into a native desktop application using Electron. It runs on macOS, Windows, and Linux with native menus, keyboard shortcuts, trackpad navigation gestures, and RESO-branded icons. No terminal, no Docker — just launch and go.

## Certification & Compliance Testing

We built tools to verify that servers comply with RESO standards:

- **Add/Edit Certification** — Tests OData CRUD operations against 8 certification scenarios
- **EntityEvent Compliance** — Tests RCP-027 change tracking with 11 scenarios and generates detailed reports
- **DD 2.0 Validation** — Ensures metadata and payloads conform to the Data Dictionary

## Data Dictionary Documentation

We replaced the aging ddwiki with a searchable documentation site covering DD versions 1.7, 2.0, and 2.1 — over 27,000 pages of fields, lookups, and definitions with real-world usage stats. It's hosted on GitHub Pages with full-text search.

## Developer Libraries

Three reusable libraries that power the tools above and are available to any developer:

- **OData Client SDK** — A TypeScript client for building OData applications
- **OData Expression Parser** — Parses filter queries into structured data
- **Validation Library** — Field validation that works in any JavaScript environment

## Test Data Generator

An interactive tool that creates realistic RESO test data — property listings, members, offices, media — so developers and vendors don't have to hand-craft sample payloads.

## Security

We conducted a security audit and addressed all findings: token expiry, timing-safe authentication, input escaping, and HTTP security headers.

## The Big Picture

This gives RESO a complete, modern, open-source ecosystem: standards documentation, a working reference implementation, certification testing tools, client libraries, and a desktop app — all maintained in one place and ready for the industry to use.
