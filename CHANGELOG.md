# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a calendar-flavored semantic versioning scheme
(`YYYY.M.D-betaN` through the pre-1.0 period, standard semver after).

## [Unreleased]

### Added

- Initial repository scaffold: package manifest, TypeScript config, lint,
  test, and format tooling.
- Plugin manifest (`openclaw.plugin.json`) declaring config schema and UI
  hints for core URL, token, presence, supplement, capture, and thoughts.
- Architecture documentation: overview, presence model, transport (HTTP +
  SSE), API consumer contract.
- Architecture Decision Records:
  - ADR-0001 Sidecar-with-authority memory integration.
  - ADR-0002 Server-Sent Events for thought delivery.
  - ADR-0003 Per-presence bearer tokens.
- Contributor documentation: `README.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- CI workflow, issue templates, PR template, CODEOWNERS.

[Unreleased]: https://github.com/ericmey/openclaw-musubi/commits/main
