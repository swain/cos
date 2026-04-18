# Using COS

**How to get the most value out of your Chief of Staff system.**

COS is a persistent agent (runs on launchd every 15 min) + a persona + a work queue. This doc tells you how to talk to it and what to do with it day-to-day.

## The one thing to remember

**English is the interface.** You don't run `cos enqueue --title ...`. You type "add: fix the null check in auth.service" and COS grooms + enqueues inline. You don't run `cos fleet`. You type "what's going on?" or "status?". Slash commands exist as power-user shortcuts but the contract is plain conversation with COS via `~/.claude/CLAUDE.md`.

If you ever catch yourself forming a CLI command in your head, you're working too hard. Just say what you want.

## What it is

```
┌─────────────────────┐
│  ~/.claude/cos/     │  persona + durable context
│  system.md          │
│  team.md            │
│  arch.md            │
│  priorities.md      │
│  ai-native.md       │
│  decisions.log      │  (append-only cron history)
│  status.md          │  (regenerated every tick)
└─────────┬───────────┘
          │ loaded into every COS interaction
          ▼
┌─────────────────────┐
│  fleet.db (SQLite)  │
│  work_items         │  the queue — the spine
│  ideas              │  ungroomed proposals
│  signals            │  inbound events (GH, etc)
│  sessions           │  active workers
│  notifications      │  outbound pushes
│  followups          │  dialog-mode topics to raise
│  cos_log            │  tick summary rows
└─────────┬───────────┘
          │
  ┌───────┴────────┬──────────────┬──────────────┐
  ▼                ▼              ▼              ▼
  launchd cron     /cos           /fleet         workers
  every 15 min     strategic      status         (tmux +
  - collect GH+    dialogue       digest         claude -p)
    Sentry
  - triage         (full persona                 per work item
  - dispatch        + context)
  - notify you
  - render
    status.md
```

## Review policy per repo

COS treats repos in two buckets:

- **`cos` (this repo) — no human review.** Workers self-merge their own PR once CI is green, a quick smoke test passes, and the diff looks in-scope. The cron tick also sweeps open `swain/cos` PRs each 15 min and merges any that are green + non-anomalous. Anomaly = touches auth/secrets/launchd/hooks, or blows past the work item's declared scope; those get an urgent push to you instead of a merge.
- **`thegoodparty/*` (product repos) — you review every PR.** Workers open PRs, never self-approve, never merge. This is shared team code; standard review discipline applies.

If COS is ever unsure which bucket a PR falls in, it defaults to the stricter rule (treats it like `thegoodparty/*`).

**Toggle.** `config.cos_auto_merge` (default `true`) turns the cos self-merge + sweep on and off. Set it to `false` and every cos PR goes back to the normal "notify urgent for review" path — useful if trust erodes, or if you're about to land something structural and want to eyeball each PR:

```bash
jq '.cos_auto_merge=false' ~/.claude/cos/config.json > /tmp/c && mv /tmp/c ~/.claude/cos/config.json
```

**What this means in practice:**

- A cos worker that finishes with green CI will squash-merge itself and delete its branch before you ever see a notification. You'll notice it as a merged commit on `main` and a `pr-merged` notification in the digest.
- You can still push back: just leave a review with `CHANGES_REQUESTED` on a cos PR before CI finishes and the sweep will skip it. A comment (without requesting changes) is also respected — the triage routes any `pr-comments-on-mine` signal on a cos PR to an urgent notify instead of letting the sweep merge past you.
- Non-cos PRs are untouched by any of this. Workers on gp-api / gp-webapp / etc. still open PRs and wait.

## The queue model (signals → ideas → work items → sessions → PRs → done)

Nothing bypasses the queue:

- **Signals** — raw inbound events (GH PR needs your review, CI failed, etc.). Not actionable yet.
- **Ideas** — proposals that _could_ become work. Ungroomed. Come from signal triage, the idea generator (self-build), or you.
- **Work items** — committed, groomed work with scope + repos + priority + acceptance criteria.
- **Sessions** — execution instances of a work item. One session = one worker = one tmux window = one `claude -p` process.
- **PRs** — outputs of sessions. Gated by CI + your review + merge.

## Signal sources

Signals land in `fleet.db` from collectors that run at the top of every `cos tick`. Each collector is a small TS module under `cli/src/collectors/` and is idempotent — if the source hasn't changed, no new rows appear.

### GitHub (`cli/src/collectors/github.ts`)

Driven by `~/.claude/cos/watched-repos.json`. Emits `pr-needs-my-review`, `pr-ci-failed`, `pr-comments-on-mine`, `pr-merge-conflict`. Requires `gh` CLI auth.

### Sentry (`cli/src/collectors/sentry.ts`)

Driven by `~/.claude/cos/watched-services.json` (seeded at install with `goodparty` + `gp-api`, `gp-webapp`, `people-api`, `election-api`). Emits two signal kinds:

- `sentry-new-error` — any new unresolved issue first-seen since the last tick. KV key `sentry:last-check:<org>/<project>` is the watermark. Dedup is by `permalink` so subsequent occurrences of the same issue don't re-fire.
- `sentry-error-spike` — any unresolved issue with `>= spike_threshold_events` events in `spike_window` (default 50 in 15m). Dedup key folds in the window, so the same issue can spike again later.

Requires `SENTRY_AUTH_TOKEN` in the environment that runs `cos tick` (the launchd plist; set it and re-bootstrap). Without the token, the collector logs a skip and emits nothing — the tick still runs.

To tune: edit `~/.claude/cos/watched-services.json`. Each service entry can be a bare project slug (`"gp-api"`) or an object to override the org on a per-service basis (`{ "project": "foo", "org": "other-org" }`). Top-level knobs: `new_errors_window` (default `1h`), `spike_window` (default `15m`), `spike_threshold_events` (default `50`), `region_url` (default `https://us.sentry.io`).

Smoke-test the collector without writing state: `cos collect-sentry --dry-run`. Real run: `cos collect-sentry`.

## Daily rhythm

### Morning

- Open a terminal in any repo.
- Say to Claude: **"status?"** or **"what's going on?"**. COS reads state, gives you a 3-line digest:
  > 2 PRs need your review (gp-api #1185, people-api #187). 1 ci-failed (gp-webapp #1649). 4 queued. No workers running. Ideas backlog: 7.
- Address the first thing that matters: review a PR, or enqueue a fix for the CI failure, or say **"dispatch the gp-api one"** to let a worker handle it.

### Across the day

- Push notifications arrive on your phone/desktop. Urgent ones usually mean "a PR needs you" or "a session is stuck." Reply in English to the ensuing Claude session: "handle it," "wait," "show me."
- When you have an idea for something the team should improve: **"idea: split the queueConsumer service per QueueType"**. COS writes it to the ideas table. You don't groom it now; do it at the end of the day.
- When you want something done now: **"add to the queue: fix the auth null check, priority 2, gp-api"**. COS grooms acceptance criteria with you in 1–2 messages, enqueues, and offers to dispatch.

### End of day

- **"triage ideas"** or `/groom` — walks the ideas backlog one at a time. Promote the good ones, defer or kill the rest. COS does this with you in a conversation.
- Optionally: **"weekly review"** on Fridays (self-build item #8) — digest of what shipped, what stalled, where priorities drifted.

## The inbox (TUI + web)

Two surfaces, same data: a synthesized dashboard of what actually needs your attention.

```bash
cos inbox          # TUI (ink + React) — keyboard driven
cos inbox-serve    # local HTTP at http://127.0.0.1:4411 — opens in any browser
```

Both pull from `cli/src/inbox/data.ts::collectDashboard()` and render seven sections in priority order:

| Section            | What's in it                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NEEDS DECISION** | blocked items, urgent unacked notifications, signals, PRs awaiting your review (`thegoodparty/*` only — cos PRs auto-merge), and queued items flagged `needs_approval` |
| **ACTIVE**         | workers currently running — session id, current step, heartbeat age, work-item title                                                                                   |
| **QUEUE**          | top 10 queued items in priority order                                                                                                                                  |
| **RECENT WINS**    | items merged/done in the last 24h with PR URLs                                                                                                                         |
| **ANOMALIES**      | stale or failed sessions with last-heartbeat delta and notes                                                                                                           |
| **FYI**            | normal-urgency notifications, deprioritized                                                                                                                            |
| **DIGEST**         | digest-tier notifications                                                                                                                                              |

### Per-row actions

Every row has at least one action (button in the web UI, keybinding in TUI). Pick the row with `↑/↓` in TUI; web is point-and-click.

| Row kind                     | Actions                                                                   | TUI keys        |
| ---------------------------- | ------------------------------------------------------------------------- | --------------- |
| notification                 | ack                                                                       | `a` or `d`      |
| work-item (pending approval) | approve & dispatch · snooze (priority +1)                                 | `A` · `s`       |
| signal                       | suppress                                                                  | `d`             |
| session (stale/failed)       | retry (re-dispatch the work item) · kill tmux window · dismiss (acked_at) | `r` · `k` · `d` |
| worker (running)             | peek (prints `tmux attach` hint) · kill                                   | `p` · `k`       |
| queue-item                   | dispatch now · bump priority · archive                                    | `D` · `b` · `x` |
| pr-review                    | open in github · mark reviewed (sets `inbox_acked_at`)                    | `↵` · `v`       |
| blocked-item                 | retry · view failure log (tail of session notes) · abandon                | `r` · `l` · `x` |
| recent-win                   | dismiss                                                                   | `d`             |

Bulk: **mark all FYI + anomalies read** (`m` in TUI, button in web) — clears notifications _and_ dismisses session-kind anomaly rows so they actually disappear on the next refresh.

### Reply in plain English (per row)

Every row has a freeform reply box. Type whatever you want and it enqueues a `handle inbox response: <text>` work item at priority 2, referencing the row. Po picks it up on the next tick.

- **Web:** the textbox at the bottom of each card; press _send_.
- **TUI:** focus the row, hit `/` to open compose, type, `Enter` to send (`Esc` to cancel).

This is the answer to "how do I tell Po what to do with that row?" — no button matrix, just say it.

## What to say (and what happens)

| You say                                                           | What happens under the hood                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "status?" / "what's going on?"                                    | Runs `cos fleet`, gives 3-line digest.                                                       |
| "add: fix X in gp-api"                                            | Grooms inline (title/description/acceptance), then `cos enqueue`. Offers to dispatch.        |
| "idea: split queueConsumer per-type"                              | Writes to `ideas` table via `cos idea`. No follow-up unless you ask.                         |
| "dispatch wi-01K…"                                                | Runs `cos dispatch <id>`. Returns session id.                                                |
| "triage ideas"                                                    | `/groom` flow. Walks backlog, one at a time.                                                 |
| "what do you think about X?" (design, tradeoff, strategic)        | Loads full persona + team + arch + priorities. Engages as strategic advisor per `system.md`. |
| "pressure-test this design doc" [paste]                           | Same as above — COS applies rigorous-not-polite stance.                                      |
| "kill that runaway gp-api worker"                                 | Finds session, stops tmux window, marks killed.                                              |
| "show me what's changed in decisions.log"                         | `tail` on `~/.claude/cos/decisions.log`.                                                     |
| "remember that we decided to defer the people-api split until Q3" | Updates `priorities.md` (or writes a `decisions.log` entry).                                 |
| "prep me for the 1:1 with Mike at 2"                              | Meeting mode (self-build item #3). Pulls calendar/ClickUp/Gmail, drafts agenda.              |

## When to reach for `/cos` explicitly

`/cos <topic>` forces the full persona + context load. Use it when:

- You're going into a **big design decision** and want it pressure-tested.
- You're writing a **doc / comms / proposal** and want critique.
- You're **stuck** on a people-dynamics thread and want an opinion.
- You want **elevation** — pull yourself out of tactics and look at the system.
- **Weekly review** — what shipped, what drifted, what to reprioritize.

For operational stuff (enqueue, dispatch, status), don't need `/cos`. Just talk.

## Push notifications: types and responses

### Urgent (immediate push)

- A PR needs your review > 2h with no activity.
- A CI failure on a PR you authored.
- A worker has been stale (no heartbeat) > 20 min — likely stuck.
- A meeting starts in 30 min and COS has prep ready.
- A worker asked a clarifying question it can't resolve.

**Reply:** "handle it" (autonomous fix), "show me" (open a session for you to drive), "wait" (COS defers to next tick), or "kill it" (abandon the worker).

### Normal (immediate push)

- A work item's PR was merged — work_item is now done.
- An idea generator produced a high-confidence proposal and needs triage.

### Digest (batched, max 1/day)

- Anything COS suppressed or decided can wait.

## Signal collectors

Collectors run at the top of every `cos tick`. Each one is a function in `cli/src/collectors/*.ts` that returns `CollectedSignal[]`. The tick inserts them through `signals.insert`, which dedupes by the unique index on `(source, kind, external_id)` — so re-emitting the same event across ticks is a no-op.

### GitHub (`collectors/github.ts`)

Uses the `gh` CLI. Reads `~/.claude/cos/watched-repos.json` to scope the search. Emits `pr-needs-my-review`, `pr-ci-failed`, `pr-comments-on-mine`, `pr-merge-conflict`.

Run it in isolation: `cos collect-github`.

### ClickUp (`collectors/clickup.ts`)

Uses the ClickUp REST API v2. Emits:

- `clickup-task-assigned` — a task assigned to you was newly created (`external_id=clickup-task:{id}:created`) or entered a new status (`external_id=clickup-task:{id}:status:{status}`).
- `clickup-mention` — a comment mentioning you on a task you're watching (`external_id=clickup-comment:{id}`).
- `clickup-deadline` — a task assigned to you with `due_date` within the next 24h (`external_id=clickup-task:{id}:due:{ms}`).

Configure:

```bash
export CLICKUP_API_TOKEN=pk_xxxxxx           # required; from ClickUp Settings → Apps → Generate
export CLICKUP_TEAM_ID=12345678              # optional; defaults to your first workspace
```

The collector stores the last-tick ISO timestamp in the `kv` table under `clickup.last_tick_at` and queries only tasks updated since that point (24h lookback on first run).

If `CLICKUP_API_TOKEN` is unset, the collector returns zero signals and the tick continues normally.

Run it in isolation: `cos collect-clickup`.

## How to extend COS

**Everything post-MVP lives in the queue.** You extend COS by enqueuing a work item that describes the extension.

Example: you want to add a Linear signal collector.

> "add to the queue: write a Linear signal collector that queries issues assigned to me and issues with @me mentions in comments. Priority 2, repos cos, acceptance: new issues appear as signals with source=linear and kind=issue-assigned or mention. Tests + dry-run verified."

COS grooms, enqueues, dispatches. A worker writes the TS in `cli/src/collectors/linear.ts`, wires it into `cos tick`, opens a PR. You review + merge. The next cron tick starts pulling Linear signals.

**Do not** directly edit `~/.claude/cos/cli/` outside of this loop. The discipline is the point.

## Anti-patterns

- **Hand-running `cos` commands when you could just talk.** If you catch yourself, step back.
- **Adding fields to the DB without a work item.** Schema changes go through the queue too.
- **Silencing noise by hand.** If a signal kind is noisy, the fix is to update the cron prompt's triage rules (via a work item), not to manually clear the signals table.
- **Treating the queue as a TODO list.** It's a _commitment_ list. Things in the queue get worked. Speculative stuff goes in ideas.
- **Ignoring stale sessions.** They usually mean a worker is stuck on something real. Read the worklog, decide: resume, reset, or abandon.
- **Editing `system.md` casually.** The persona is load-bearing. Changes to it affect every future interaction. If you think the tone is wrong, have a `/cos` conversation first.
- **Skipping `decisions.log`.** It's your long memory. Don't let important choices vanish into chat history.

## When something breaks

Your first move is always `cos doctor --dry-run`. It checks seven invariants and prints what (if anything) has drifted without touching state:

```bash
cos doctor --dry-run                 # text report, read it yourself
cos doctor --dry-run --format json   # machine-readable, pipe to jq
```

The text output is a single header line plus one row per invariant. `✓` means the invariant held; `✗` means it did not, and the rows underneath list the offending ids. Example:

```
doctor: 2 issue(s) across 7 invariants — fixed=0 notified=0 (dry-run)
  ✓ zombie-tmux-window
  ✗ stale-heartbeat (1)
      - sess-01K…: no heartbeat for 47.2 min (threshold 20)
  ✓ silent-worker
  ✓ pr-status-drift
  ✗ queued-but-running (1)
      - wi-01K…: queued work item has active session
  ✓ dispatch-circuit-breaker
  ✓ cron-tick-health
```

If the report shows something fixable and you trust the fix, re-run with `--auto-fix`:

```bash
cos doctor --auto-fix                # apply fixes 1–5, notify on 6–7
```

What each invariant means and what auto-fix does:

| Invariant                  | What it catches                                                                                       | Auto-fix                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `zombie-tmux-window`       | session `running`/`starting` but the tmux window is gone                                              | mark session `stale`                                         |
| `stale-heartbeat`          | heartbeat older than 20 min (configurable) on a live session                                          | mark session `stale`                                         |
| `silent-worker`            | `~/.claude/cos/logs/worker-<sess>.log` is 0 bytes + older than 5 min AND heartbeat also > 5 min stale | kill tmux window, mark session `failed`, work item `blocked` |
| `pr-status-drift`          | work item is `pr-open` but the PR is actually merged/closed on GitHub                                 | reconcile to `merged` or `abandoned`                         |
| `queued-but-running`       | work item is `queued` but has an active session                                                       | flip work item to `in-progress`                              |
| `dispatch-circuit-breaker` | last 3 worker sessions all failed within 15 min of start                                              | **urgent** notification + `dispatch_paused=true`             |
| `cron-tick-health`         | last 3 cron ticks all exited non-zero                                                                 | **urgent** notification                                      |
| `old-session-archive`      | session in `stale`/`killed`/`failed` older than 7 days (configurable)                                 | mark session `archived`                                      |

`cos tick` already calls `cos doctor --auto-fix --format json` as step 0, so for routine drift you rarely need to run it by hand. Reach for `--dry-run` when: a notification points at something you want to inspect, a worker seems stuck, or dispatch got auto-paused and you're deciding whether to unpause.

## Session retention policy

`fleet.db` keeps every session row ever created — they are the audit log for worker runs. To keep the _dashboard view_ legible and the hot-path queries fast, the fleet view and the doctor treat age as first-class:

- **`cos fleet` / `cos render-status`** count and list only sessions whose `started_at` is within the last 24h. Historical sessions (last week's stale worker, yesterday's failure) are still in the DB but won't clutter the digest. Override with `config.fleet_session_window_hours` in `~/.claude/cos/config.json` — e.g. set it to `72` if you want a three-day window.
- **`cos doctor --auto-fix`** (also run automatically at the top of every `cos tick`) transitions sessions that have been in `stale`, `killed`, or `failed` for more than 7 days to status `archived`. Archived rows stay in the DB for long-horizon forensics but are invisible to the fleet view and the inbox. Override the threshold with `config.session_archive_days`.

Archived sessions never come back to life; if you need to look one up, query `sqlite3 ~/.claude/cos/fleet.db "SELECT * FROM sessions WHERE status='archived' AND id=...";` directly.

## Troubleshooting

### Cron isn't firing

```bash
launchctl print gui/$(id -u)/com.smolster.cos.cron
tail -20 ~/.claude/cos/logs/cron-$(date +%Y-%m-%d).log
tail ~/.claude/cos/logs/launchd.err.log
```

Common causes: `claude` binary not on PATH for launchd (fix: check `PATH` setup in `~/.claude/cos/bin/cos-tick`), auth expired, network down.

To reload after editing the plist:

```bash
launchctl bootout gui/$(id -u)/com.smolster.cos.cron 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smolster.cos.cron.plist
launchctl kickstart gui/$(id -u)/com.smolster.cos.cron
```

### A worker is stuck

```bash
cos peek                       # read-only summary of every active worker
cos peek <sess|wi|win-num>     # last 35 lines of that worker's log
cos peek --attach              # only when you actually want a tmux takeover
cos fleet --format json | jq '.active_sessions'
# Mark it stale manually:
cos session-mark-stale sess-<id>
# Or kill it:
tmux kill-window -t cos-workers:<window>
```

`cos peek` (no args) prints a compact table — header counts (`N running, K idle, J stale`)
plus one row per worker (sess id tail, work-item title, current step, heartbeat age, last
log line). It exits cleanly to your shell. To inspect a specific worker, pass any of: a
session id (or its trailing 6 chars as shown in the summary), a work-item id, or its tmux
window number — `cos peek` resolves and tails `~/.claude/cos/logs/worker-<sess>.log`.
The old "attach me to tmux" behavior is now opt-in via `--attach` (or `--tmux`).

### DB seems broken

```bash
sqlite3 ~/.claude/cos/fleet.db '.tables'
# Or just rebuild from scratch (loses queue state!):
rm ~/.claude/cos/fleet.db
cos init
```

### Dispatch is disabled ("dispatch_paused=true")

Intentional default at first run. Unpause when ready:

```bash
jq '.dispatch_paused=false' ~/.claude/cos/config.json > /tmp/c && mv /tmp/c ~/.claude/cos/config.json
```

### `claude` is aliased (not a binary) in my shell

COS uses `~/.local/bin/claude` directly (not the alias) so launchd and child processes work. If you change where `claude` is installed, update `CLAUDE_BIN` in `~/.claude/cos/cli/src/util.ts` and `spawn-worker`/`cos-tick`.

## Teammate adoption

Eventually you may want teammates on the same setup. The path:

1. They clone the cos repo locally (e.g. `git clone https://github.com/swain/cos ~/Repos/cos`).
2. Run `~/Repos/cos/install.sh` — symlinks shareable files into `~/.claude/`, copies starter templates for personal files (`team.md`, `priorities.md`, `arch.md`, `ai-native.md`, `watched-repos.json`, `watched-services.json`, `config.json`), builds the CLI, renders the launchd plist.
3. Fill in their own `team.md` and `priorities.md` — these are local-only and never committed.
4. Edit `watched-repos.json` to match repos they actually work in.
5. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<whoami>.cos.cron.plist` to start the cron.

Everything in the repo is generic; the personal state stays on their machine.

## Quick reference: CLI

You rarely invoke these by hand. COS or slash commands handle them. But for the record:

```
cos init                          # bootstrap dirs + db (idempotent)
cos fleet [--format md|json]      # current state
cos render-status                 # regenerate status.md
cos enqueue --title ... --description ... --acceptance ... --repos '[...]' --priority N
cos dispatch <wi-id> [--force]
cos heartbeat <sess-id> [--step <name>]
cos worker-done <sess-id> --pr-url <url>   OR --failed <reason>
cos worker-setup <wi-id>          # create worktrees for a work item
cos worker-prompt <wi-id> --session <sess-id>   # print the worker prompt
cos session-new --work-item <id> --kind worker
cos session-mark-stale <sess-id>
cos signals [--status <s>] [--source <s>]
cos signal-triage <sig-id> <action> ...   # action: suppress|idea|work-item|notify
cos collect-github                # run github collector only
cos collect-clickup               # run clickup collector only
cos collect-sentry [--dry-run]    # run sentry collector only
cos ideas [--status <s>]
cos idea --title ... --description ...
cos idea-promote <idea-id> --priority N --repos '[...]' --acceptance "..."
cos notify --subject ... [--body ...] [--urgency urgent|normal|digest]
cos notify-unpushed
cos notify-mark-pushed <id>
cos followup --topic ... --trigger <next-dialog|before-meeting:<name>|before-workitem:<wi-id>|after-date:<iso>> [--context ...]
cos followups [--status open|raised|addressed|dropped]
cos followup-mark-raised <id>
cos followup-mark-addressed <id>
cos tick [--dry-run]              # run one cron tick manually
cos doctor [--auto-fix] [--dry-run] [--format text|json]   # health-check + self-heal
cos peek                          # summary table of active workers (no tmux takeover)
cos peek <target> [-n <lines>]    # tail a worker's log (target: sess/wi prefix or window #)
cos peek --attach                 # attach the cos-workers tmux session (old default)
```

## What's next (self-build queue)

On MVP launch, 11 work items are seeded (dispatch paused until you flip `config.json`). In rough order:

1. Sentry signal collector
2. ClickUp signal collector
3. Calendar + meeting-prep flow
4. Grafana signal collector
5. Slack signal collector
6. Idea generator: ai-native evals
7. Idea generator: diff-driven
8. Weekly review flow
9. Worker lifecycle polish (stale, auto-revive)
10. Planning / chunking for multi-PR work
11. Post-meeting TODO extraction

Each becomes a PR. You review, merge, and the capability lights up on the next tick. By end of Week 1 the system is v1.
