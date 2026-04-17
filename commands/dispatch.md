---
description: Dispatch a specific queued work item to a background worker
allowed-tools: Bash(cos:*)
---

## Current fleet

!`cos fleet`

## Your task

Dispatch work item(s) from the queue. `$ARGUMENTS` should be a work item id (e.g. `wi-01K...`) or a filter ("all P2", "everything queued for gp-api").

- For a single id: run `cos dispatch <id>`. If auto-dispatch refuses (priority too high, missing fields, dispatch paused), report the reason and ask before passing `--force`.
- For a filter: list the matching ids, confirm with the user, then dispatch each in turn. Don't exceed the daily cap in `~/.claude/cos/config.json`.

After each dispatch, print the session id from `cos fleet --format json | jq '.active_sessions[-1]'`.

If `dispatch_paused=true` in config and the user wants to override, ask once for confirmation, then pass `--force`.
