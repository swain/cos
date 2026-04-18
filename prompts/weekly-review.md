# Recurring task: weekly review digest

**Cadence:** 168h (once per week). **Task id:** `rec-weekly-review`.

## What this does

Generates the weekly review markdown digest and queues a normal-urgency notification so the Boss sees it at the start of the weekend.

## Steps

1. Run the CLI:

   ```bash
   cos review-week
   ```

   This writes `~/.claude/cos/reviews/YYYY-WW.md` and inserts a queued notification (subject: "Weekly review ready — YYYY-WW"). Step 4 of the main cron tick will push the notification on this same tick.

2. That's it. The digest is self-contained; no further action on your part. If `cos review-week` exits non-zero, call `cos recurring mark-ran rec-weekly-review --status failed --notes "<stderr summary>"`; the regular tick flow handles `mark-ran ok` via step 8 of cron.md when this prompt completes successfully.
