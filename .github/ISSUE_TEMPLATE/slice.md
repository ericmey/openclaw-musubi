---
name: Slice
about: A parallel-safe unit of work with explicit scope. The way real work gets done here.
title: "Slice: <short name>"
labels: ["slice"]
assignees: []
---

## Summary

One paragraph describing what this slice delivers and why it matters now.

## Owned paths

Files this slice may write. Be specific.

- `src/...`
- `tests/...`
- `docs/...`

## Forbidden paths

Files owned by other slices that this work must not touch.

- `src/...`

## Depends on

List slice issues (or upstream Musubi work) that must merge before this can.

- #N — short description
- Upstream: `ericmey/musubi#NNN`

## Test contract

The set of tests that prove the slice is done. Write these names first; the
implementation follows.

- [ ] `test_<thing>_<expected_behavior>`
- [ ] `test_<thing>_<edge_case>`
- [ ] `integration: <end-to-end scenario>`

## Definition of done

- [ ] All listed tests pass.
- [ ] Lint and typecheck clean.
- [ ] Docs updated where the slice changes the contract (`docs/api-contract.md`,
      relevant ADR, `CHANGELOG.md` `## [Unreleased]`).
- [ ] PR description references this issue (`Closes #N`).
- [ ] No file outside "Owned paths" modified, unless explicitly justified in
      the PR description.
