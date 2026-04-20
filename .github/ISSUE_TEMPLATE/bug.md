---
name: Bug report
about: Something is broken or behaves contrary to documentation.
title: "Bug: <short description>"
labels: ["bug"]
assignees: []
---

## Versions

- `openclaw-musubi`:
- OpenClaw:
- Musubi core:
- Node:
- OS:

## What I expected

What should have happened, ideally with a citation to the relevant doc or
ADR.

## What happened

What actually happened. Include exact error messages.

## Steps to reproduce

1.
2.
3.

## Config (redacted)

```json
{
  "core": { "baseUrl": "<redacted>", "token": "<redacted>" },
  "presence": { "defaultId": "..." }
}
```

## Logs

Output of `openclaw plugins logs musubi` around the failure. Redact tokens
and any sensitive content.

```
<paste here>
```

## Anything else

Workarounds tried, suspected root cause, related issues.
