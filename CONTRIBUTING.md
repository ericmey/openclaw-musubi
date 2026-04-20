# Contributing to openclaw-musubi

Thanks for considering a contribution. This project is built in public and
treats external contributors with the same respect as internal ones.

## Ground rules

- **Be kind.** See the [Code of Conduct](./CODE_OF_CONDUCT.md).
- **One concern per PR.** Small, focused changes merge fast. Large drive-by
  refactors do not.
- **Tests before behavior.** If a PR changes runtime behavior without a
  matching test, expect a nudge to add one.
- **Docs live with code.** Changes to the plugin contract update
  [`docs/api-contract.md`](./docs/api-contract.md) in the same PR.
- **No breaking config changes without a deprecation notice** in
  [`CHANGELOG.md`](./CHANGELOG.md).

## Development setup

```bash
git clone git@github.com:ericmey/openclaw-musubi.git
cd openclaw-musubi
pnpm install
pnpm typecheck
pnpm test
```

You'll need a reachable Musubi core for anything beyond unit tests. See the
[Musubi v2 README](https://github.com/ericmey/musubi) for local setup.

## Slice-based workflow

Work is carved into **slices** — small, parallel-safe units of work with a
clear scope. Each slice becomes a GitHub issue labeled `slice` and names:

- **Owned paths** — the files this slice may write.
- **Forbidden paths** — files other slices own.
- **Depends on** — other slices that must merge first.
- **Test contract** — the tests that prove the slice is done.

To claim a slice, comment on the issue and open a draft PR with the matching
branch name. When the PR goes green and the test contract passes, request
review.

This discipline is borrowed from the upstream [Musubi project](https://github.com/ericmey/musubi)
and scales cleanly from one contributor to many.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(transport): implement SSE reconnect with Last-Event-ID
fix(capture): stop double-posting episodic memories on retry
docs(adr): ADR-0004 how presence tokens are rotated
chore(ci): bump Node matrix to 22 + 24
```

Scopes in use: `transport`, `capture`, `supplement`, `thoughts`, `config`,
`presence`, `docs`, `ci`, `chore`.

## Pull requests

- Link the slice issue: `Closes #N` or `Part of #N`.
- Keep the PR description focused on **why**; the diff shows **what**.
- Include a "Test plan" section — what you ran, what should pass.
- If you changed the plugin contract, update `docs/api-contract.md` and say so
  in the PR description.

## Releases

Releases are cut from `main` on a schedule or when a slice of real user value
lands. Versions follow calendar-ish semver matching the OpenClaw compat range
(`YYYY.M.D-betaN` for pre-1.0, standard semver after).

The `CHANGELOG.md` uses [Keep a Changelog](https://keepachangelog.com/) format.
Every PR that changes user-visible behavior updates the `## [Unreleased]`
section.

## Reporting bugs

Open an issue using the bug template. Include:

- Plugin version, OpenClaw version, Musubi core version.
- Relevant config excerpt (redact tokens).
- What you expected, what happened, logs from `openclaw plugins logs musubi`.

## Questions

Open a GitHub Discussion. Don't be shy — the goal is to make OpenClaw's
memory work for more people, and most design questions are worth writing
down in public.
