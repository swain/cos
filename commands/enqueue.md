---
description: Add a work item to the COS queue. Grooms details inline before writing.
allowed-tools: Bash(cos:*), Read
---

## Current fleet (context)

!`cos fleet`

## Your task

The user wants to add this to the queue: **$ARGUMENTS**

If the request is underspecified, ask _brief_ grooming questions (one at a time, keep it short) to fill in what's missing:

- **Title** (<70 chars, imperative)
- **Description** (the "why" + enough context for a worker to start cold)
- **Acceptance criteria** (tight checklist)
- **Repos** (JSON array — from `~/.claude/cos/arch.md`: gp-api, gp-webapp, people-api, election-api, gp-ai-projects, ops, or "cos" for self-build)
- **Priority** (1 critical / 2 high / 3 normal / 4 low / 5 someday)

Defaults: if the user is confident and has given enough detail, don't grill them. Infer and confirm in one message.

Once fields are set, run:

```
cos enqueue --title "..." --description "..." --acceptance "..." --repos '["..."]' --priority N
```

Then print the returned work item id and ask if they want to dispatch immediately (`cos dispatch <id>`) or leave it queued.

Rules:

- `--repos` must be valid JSON.
- `--acceptance` must be non-empty (auto-dispatch refuses to run without it).
- Don't auto-dispatch if priority > 3 or if the user hasn't explicitly approved it.
