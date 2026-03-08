# RESO Tools — Announcements

---

## v0.1 — 2026-03-06

### The "Everything Under One Roof" Release

We consolidated RESO's testing and validation tools into a single open-source monorepo. One install, one place to look, one less thing to bookmark.

**The Data Dictionary has a new home.** We replaced the aging ddwiki with a searchable documentation site covering DD versions 1.7, 2.0, and 2.1 — all 27,000+ pages of fields, lookups, and definitions, complete with real-world usage stats. Check it out at [tools.reso.org/dd/](https://tools.reso.org/dd/DD2.0/).

**The reference server got a glow-up.** Sticky action buttons, better layouts, zebra-striped tables — small touches that make a big difference when you're clicking through hundreds of fields. Developers also get Docker hot-reload now, so no more rebuilding containers every time you change a line of CSS.

**EntityEvent compliance testing is live.** If your server implements RCP-027 change tracking, there's now a tool to verify it works correctly — two testing modes, eleven scenarios, and a detailed compliance report at the end. See [PR #25](https://github.com/RESOStandards/reso-tools/pull/25) for the full rundown.

**Three backends, zero schema errors.** PostgreSQL, MongoDB, and SQLite all pass DD 2.0 compliance cleanly. Details in the [technical release notes](RELEASES.md).
