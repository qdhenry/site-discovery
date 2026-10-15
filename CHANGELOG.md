# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- Single URL, batch, same-origin crawl (1–3 hops) and sitemap capture through Cloudflare Browser Run, at desktop and mobile widths, up to 50 pages.
- Explicit, per-page Claude analysis through an authenticated Cloudflare AI Gateway, with schema-validated findings.
- Fail-closed per-run and monthly USD budgets with per-attempt reservations.
- Durable, restart-safe runs on Pi Durable and SQLite. Uncertain calls require an explicit retry.
- Reviewed, transactional saves to a project library, with CMS naming for AEM, Optimizely, Sitecore and generic CMSs, plus JSON export.
- An Agent settings editor for model, reasoning, caching, evidence and limits.
- Fixture mode for running the full workflow without provider accounts.
