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
│  cos_log            │  tick summary rows
└─────────┬───────────┘
          │
  ┌───────┴────────┬──────────────┬──────────────┐
  ▼                ▼              ▼              ▼
  launchd cron     /cos           /fleet         workers
  every 15 min     strategic      status         (tmux +
  - collect GH     dialogue       digest         claude -p)
  - triage         (full persona                 per work item
  - dispatch        + context)
  - notify you
  - render
    status.md
```

## The queue model (signals → ideas → work items → sessions → PRs → done)

Nothing bypasses the queue:

- **Signals** — raw inbound events (GH PR needs your review, CI failed, etc.). Not actionable yet.
- **Ideas** — proposals that _could_ become work. Ungroomed. Come from signal triage, the idea generator (self-build), or you.
- **Work items** — committed, groomed work with scope + repos + priority + acceptance criteria.
- **Sessions** — execution instances of a work item. One session = one worker = one tmux window = one `claude -p` process.
- **PRs** — outputs of sessions. Gated by CI + your review + merge.

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
tmux attach -t cos-workers   # then switch to its window to peek
cos fleet --format json | jq '.active_sessions'
# Mark it stale manually:
cos session-mark-stale sess-<id>
# Or kill it:
tmux kill-window -t cos-workers:<window>
```

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

1. They clone `github.com/swain/dotfiles` (bare-repo pattern).
2. Run `~/.claude/cos/bin/cos init` (creates local state).
3. Fill in their own `team.md`, `priorities.md` (local-only; never committed).
4. Update `watched-repos.json` to match their own.
5. Install the LaunchAgent from the template in `launchd/`.
6. Build the CLI: `cd ~/.claude/cos/cli && npm install && npm run build`.

Everything that's been committed is generic enough; the personal state stays on their machine.

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
cos ideas [--status <s>]
cos idea --title ... --description ...
cos idea-promote <idea-id> --priority N --repos '[...]' --acceptance "..."
cos notify --subject ... [--body ...] [--urgency urgent|normal|digest]
cos notify-unpushed
cos notify-mark-pushed <id>
cos tick [--dry-run]              # run one cron tick manually
cos dotfiles-sync [--push]        # stage/publish committable files
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
