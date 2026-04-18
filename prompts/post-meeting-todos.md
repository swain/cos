# Recurring task: post-meeting TODO extraction

**Cadence:** 1h. **Task id:** `rec-post-meeting-todos`.

## What this does

After a watched calendar event ends, locate an available transcript (Zoom summary email in Gmail, or a Google Doc linked in the event description), extract action items, and either enqueue them as COS work items or append them to the meeting's prep file as "Unclassified notes". Push a normal-urgency notification summarizing what was extracted.

This is the back half of the meeting flow. The meeting-prep flow (task `rec-meeting-prep`, when it exists) writes `~/.claude/cos/meetings/YYYY-MM-DD-<slug>.md` **before** the meeting. This task amends that same file **after** the meeting.

Idempotency marker: a `## Post-meeting` header (of any flavor) in the meeting file. A future run of this task that sees such a header treats the meeting as already processed and moves on.

## Steps

### 1. List candidate meeting files

```bash
ls ~/.claude/cos/meetings/ 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$' || true
```

Keep only files whose date prefix is today or yesterday (UTC is fine — Zoom emails usually land within the hour regardless). Ignore `SPEC.md` and any non-dated files.

If there are zero candidates: `cos recurring mark-ran rec-post-meeting-todos --status ok --notes "no candidate meetings"` and exit.

### 2. For each candidate file

Let `<path>` = `~/.claude/cos/meetings/<filename>`.

a. Read the file. If it already contains a line starting with `## Post-meeting` anywhere, skip — this meeting has been processed.

b. Parse the filename: `YYYY-MM-DD-<slug>.md`. The date and slug together identify the meeting.

c. Find the matching calendar event. Use `gws`:

```bash
gws calendar events list --params '{
  "calendarId": "primary",
  "timeMin": "YYYY-MM-DDT00:00:00Z",
  "timeMax": "YYYY-MM-DDT23:59:59Z",
  "singleEvents": true,
  "orderBy": "startTime"
}' --format json
```

Match by fuzzy similarity between the slug (`1-1-with-mike`) and the event title (`1:1 with Mike`). Spaces and punctuation are replaced by `-` in slugs; use that rule to reconstruct. If no event matches, skip this file.

d. Compute the end-time gate. Let `end` = event end time (ISO) and `now` = current time:

| Condition                 | Action                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `end > now`               | Meeting hasn't ended. Skip.                                                                                                                                              |
| `now - end < 15 min`      | Too early; transcripts usually aren't ready yet. Skip (next run will re-check).                                                                                          |
| `15 min ≤ now - end ≤ 2h` | Proceed to step 3.                                                                                                                                                       |
| `now - end > 2h`          | Append `## Post-meeting — no transcript located (within 2h)` with today's date and a `— Po` sign-off. This marks the file processed so we stop re-checking. Skip step 3. |

### 3. Find a transcript source

Try, in order:

**a. Zoom summary email via Gmail.** Zoom sends from `no-reply@zoom.us` with subjects like "Cloud Recording is now available" or "Zoom Meeting Summary". Search:

```bash
gws gmail users messages list --params '{
  "userId": "me",
  "q": "from:zoom.us (subject:\"Cloud Recording\" OR subject:\"Meeting Summary\" OR subject:\"AI Companion\") newer_than:2d"
}' --format json
```

For each match, fetch the message body:

```bash
gws gmail users messages get --params '{"userId":"me","id":"<msg-id>","format":"full"}' --format json
```

The body is base64url-encoded in `payload.body.data` (or inside `payload.parts[].body.data` for multipart). Decode and scan for the meeting title — match a message to this meeting by title substring or scheduled start time.

**b. Google Doc linked in event description.** Scan the event's `description` field (HTML or text) for URLs matching `docs.google.com/document/d/([A-Za-z0-9_-]+)`. For each doc id:

```bash
gws drive files export --params '{"fileId":"<doc-id>","mimeType":"text/plain"}'
```

**c. Neither.** Don't mark the file. The next run will retry. (Step 2d's 2h cap eventually closes the loop.)

### 4. Extract action items

Given the transcript/doc contents, identify action items with this bar:

- **Enqueue-worthy** — concrete task, verb phrasing, owner is the Boss (Swain) or unassigned, enough context to write a one-line acceptance criterion. Example: "Swain to draft the Q2 goals doc by Friday" → yes.
- **Unclassified** — everything else: someone else's task, informational, vague "we should think about X" items. These go to the meeting file.

**Never invent TODOs.** If the source is thin, it's fine to have zero enqueued items. The Boss can add items directly if needed.

**De-dup against the queue.** Before enqueuing, pull `cos fleet --format json` and look at `.queued[].title`. If a new TODO is >=80% semantically equivalent to a queued item, treat it as a dup and drop it (mention in the unclassified notes section so the Boss can see the overlap).

### 5. Enqueue clear items

For each enqueue-worthy item:

```bash
cos enqueue \
  --title "<task title>" \
  --description "From <meeting title> (YYYY-MM-DD): <one-line context from the transcript>" \
  --acceptance "<best-effort one-liner, e.g. 'Doc drafted and shared with Terry.'>" \
  --repos '[]' \
  --priority 3 \
  --source meeting
```

Capture the returned `wi-…` id from stdout. You'll list these in the post-meeting section.

### 6. Append the post-meeting sections

Open `<path>` and append (keep existing content intact):

```markdown
## Post-meeting TODOs extracted (YYYY-MM-DD HH:MM)

- Source: <Zoom summary email / Google Doc at <url>>
- Enqueued: <N> — <comma-separated wi-ids, or `none`>
- Unclassified notes: <M>

— Po
```

If M > 0, also append:

```markdown
## Unclassified notes

- <note 1>
- <note 2>
- …
```

Each note is one line. Paraphrase from the transcript — don't copy-paste paragraphs.

### 7. Notify

```bash
cos notify --urgency normal \
  --subject "Post-meeting extract: <meeting title>" \
  --body "Enqueued <N> TODOs, wrote <M> unclassified notes to ~/.claude/cos/meetings/<filename>."
```

If N == 0 and M == 0 (transcript existed but yielded nothing useful), still notify so the Boss knows the pass ran:

```bash
cos notify --urgency normal \
  --subject "Post-meeting extract: <meeting title> — nothing actionable" \
  --body "Transcript located via <source> but no TODOs extracted. Meeting file untouched."
```

### 8. Mark this task ran

After processing all candidates:

```bash
cos recurring mark-ran rec-post-meeting-todos --status ok \
  --notes "<one-liner: '3 meetings: 2 processed (4 TODOs, 1 unclassified), 1 awaiting transcript'>"
```

If `gws` errors out (auth expired, API quota, network), stop immediately:

```bash
cos recurring mark-ran rec-post-meeting-todos --status failed \
  --notes "<one-liner error, e.g. 'gws gmail list returned 401 — re-auth needed'>"
```

Don't raise a notification unless the same failure persists across 3+ consecutive runs (check `last_status` on previous runs via `cos recurring list`).

## Guardrails

- **Never commit `~/.claude/cos/meetings/` content to git.** That directory is local-only by design.
- **One `## Post-meeting` header per meeting.** Don't append a second one to a file that already has it — you missed the idempotency check.
- **Keep the queue clean.** If a transcript is noisy and you'd enqueue 8+ items, stop at 5 and put the rest in unclassified notes. The queue is not a dumping ground.
- **Acceptance criteria go in the enqueue call, not in the description.** Workers read `acceptance`; they skim `description`.
- **Source transparency.** Always record which source you used (Zoom email / Google Doc). If the Boss disputes an extracted TODO, they need to know where it came from.

## Acceptance this task satisfies

From work item `wi-01KPENK170PYSKX3R1A1FG67GM`:

1. When a watched meeting ends, COS detects a transcript within 1h — 1h cadence + 15-min-post-end gate means detection lands within one tick of transcript availability.
2. Action items get extracted and either enqueued or written to the meeting file.
3. Notification summarizes what was extracted.
