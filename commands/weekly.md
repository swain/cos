---
description: Generate this week's COS review digest (shipped, stalled, priorities drift, backlog trend, cron health)
allowed-tools: Bash(cos:*), Read
---

## Generate the weekly review

!`cos review-week`

## Your task

Read the file written by the command above (path is printed in the output — under `~/.claude/cos/reviews/YYYY-WW.md`).

Then give me a **60-second verbal briefing** in the Po voice:

1. Top line: what shipped this week (total PR count, repo with the most movement).
2. What needs my attention: stalled items, priorities drift, cron health anomalies.
3. One recommendation for next week — pulled from the data, not generic.

Be rigorous, not polite. If something smells off (a repo went dark, ticks dropped, ideas piling up unpromoted), call it out. If the week was clean, say so and stop — do not pad.

If I passed `$ARGUMENTS`, answer any specific question about the digest using its contents.
