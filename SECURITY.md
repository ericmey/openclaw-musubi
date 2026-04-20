# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, email **eric.mey@salesai.com** with:

- A description of the issue.
- Steps to reproduce, including plugin version, OpenClaw version, and Musubi
  core version.
- Any proof-of-concept or exploit details.

You will receive an acknowledgement within 72 hours. A fix timeline depends on
severity and scope; we aim to ship a patched release within 14 days for
high-severity issues.

## Scope

In scope:

- The `openclaw-musubi` plugin code in this repository.
- Its configuration schema and any secrets it handles (tokens, namespaces).
- The SSE consumer and HTTP client behavior against a Musubi core.

Out of scope (report upstream):

- Vulnerabilities in [Musubi](https://github.com/ericmey/musubi) core — report
  to that project.
- Vulnerabilities in [OpenClaw](https://github.com/openclaw/openclaw) itself —
  report to that project.
- Issues in third-party dependencies — report to the dependency, then open a
  PR here once a fix is available.

## Handling secrets

This plugin handles **bearer tokens** with namespace scope. A leaked token
grants read/write access to the presence it was issued for.

- Tokens are stored via OpenClaw's config system; we do not persist them in
  plaintext on disk beyond what OpenClaw already does.
- Tokens are never logged, even at debug level. A violation of this rule is a
  security bug and in-scope for this policy.
- `${ENV_VAR}` substitution is supported so tokens can live in a secret
  manager rather than `openclaw.json`.

## Disclosure

Once a fix ships, we will:

1. Publish a GitHub Security Advisory on this repository.
2. Credit the reporter unless they prefer to remain anonymous.
3. Note the fix in `CHANGELOG.md` with a `SECURITY:` prefix.
