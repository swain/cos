---
description: Triage the ideas backlog — promote, defer, or kill each one interactively
allowed-tools: Bash(cos:*), Read
---

## Ideas backlog

!`cos ideas --status new`

## Your task

Walk the ideas backlog above. For each one, present a compact one-liner and ask me to **promote / defer / kill** (or `skip` to move on without changing it).

If I say **promote**:

- Ask for any missing details: priority (1–5), repos (JSON array), tight acceptance criteria.
- Run `cos idea-promote <idea-id> --priority N --repos '["..."]' --acceptance "..."`.
- If I didn't give new title/description, they carry over from the idea.

If I say **defer**:

- Run: `cos` SQL via stdin… actually just: don't have a CLI yet for defer. Instead, print what we'd do and ask if you should update the DB via a one-off SQL (tell me).

If I say **kill**:

- Same as defer — no CLI command yet; report it and we'll add the command later.

Go one at a time. Batch-asking produces bad triage.

If `$ARGUMENTS` specifies a filter (e.g. "only gp-api ideas"), apply it.
