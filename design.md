# COS — Chief of Staff System Design

**Author:** Swain Molster
**Date:** 2026-04-17
**Status:** Draft, pending approval

---

## TL;DR

A persistent Chief of Staff built on Claude Code primitives. One persona, four modes of action (cron / dialog / embedded / meeting), one state substrate (SQLite), dispatched workers for throughput, proactive outreach via push notifications. English-first interface — slash commands exist only as power-user shortcuts. Every piece after MVP is built _by_ the MVP, dogfooded into existence.

## Goals

1. **Enable 5–10 PRs/day across my team's repos** without babysitting agent sessions. COS dispatches, monitors, and surfaces only what needs my attention.
2. **Set the AI-native standard.** The system itself is the artifact — legible enough that teammates can adopt or learn from it.
3. **Make me a sharper technical leader.** Strategic dialogue, decision memory, team context — COS as advisor, not just operator.
4. **Eliminate context-switching cost.** One status surface. One inbox. One persona who remembers what I've decided.

## Non-Goals

- A shared multi-user system. This is personal. Teammate adoption comes later, if at all, via documentation not shared infra.
- Replacing GitHub, ClickUp, or Grafana as source-of-truth. COS reads from them; it does not replace them.
- A GUI / web dashboard. The dashboard is `status.md` + push notifications. If a richer UI is ever needed, it's post-v1.
- Pa-compatible tmux orchestration. Adopt Pa's _control model_; discard Pa's _plumbing_. Claude Code has better primitives.

## Principles

1. **English is the interface.** Slash commands are optional shortcuts. The default motion is plain talking.
2. **The queue is the spine.** Signals → ideas → work items → sessions → PRs → done. Nothing bypasses the queue to become a running session.
3. **Sequential PR gating per work item.** After dispatching a PR, the worker on that item only responds to CI / review comments until merged. Parallelism is across _different_ work items.
4. **Minimal manual intervention.** COS triages signals, grooms ideas into work items, auto-dispatches where confidence is high, and only pings you when a decision genuinely requires you.
5. **Dogfooding from day one.** MVP is built hand; everything after MVP is built _by_ MVP as work items. If it hurts to use COS to build COS, that's the signal to fix.
6. **Context is durable.** Decisions, team notes, architectural commitments live as markdown in `~/.claude/cos/`. COS loads them into every dialog.
7. **Failure is visible.** Workers write worklogs. Stale sessions are detected. Nothing silently dies.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    ~/.claude/cos/                             │
│  system.md        — COS persona (the strategic advisor prompt)│
│  team.md          — people, dynamics, skills, blind spots     │
│  arch.md          — architectural decisions, invariants       │
│  priorities.md    — current quarter goals, open initiatives   │
│  ai-native.md     — linked eval docs → open improvements      │
│  decisions.log    — append-only log of every COS cron tick    │
│  status.md        — rendered every cron tick (fleet view)     │
│  worklogs/<id>.md — per-worker structured log                 │
│  meetings/        — prep + TODOs per meeting                  │
│  USING_COS.md     — how-to-use guide (separate deliverable)   │
│  design.md        — this file                                 │
└───────────────────────────┬───────────────────────────────────┘
                            │ loaded as context for every COS mode
                            ▼
┌───────────────────────────────────────────────────────────────┐
│                    ~/.claude/cos/fleet.db (SQLite)            │
│  work_items      — queued work                                │
│  ideas           — ungroomed proposals                        │
│  signals         — inbound events awaiting triage             │
│  sessions        — active workers (heartbeats)                │
│  notifications   — outbound push log                          │
│  cos_log         — structured cron-tick records               │
└──────────┬────────────────────────────────────────────────────┘
           │
  ┌────────┴───────────────┬───────────────────┬─────────────────┐
  ▼                        ▼                   ▼                 ▼
  cron tick           /cos (dialog)        signal            worker
  (launchd agent,     — user-invoked,      collectors        dispatch
   every 15 min,      full persona         (scheduled or     (spawn-worker
  - reads state +     + context            cron-driven       script via
    signals           + recent log         polling:          tmux + claude -p;
  - decides:                               GH/Sentry/        registers in
    ignore / nudge                         Grafana/Slack/    sessions table;
    / promote /                            Cal/ClickUp)      writes worklog)
    dispatch /                             → write rows
    escalate                               to signals table
  - writes status.md
  - push notify if
    anything for you
```

## State Schema (fleet.db)

### work_items

| column              | type                               | notes                                                                        |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| id                  | TEXT PK                            | `wi-<ulid>`                                                                  |
| title               | TEXT                               | short human label                                                            |
| description         | TEXT                               | full scope                                                                   |
| acceptance_criteria | TEXT                               | checklist the worker tests against                                           |
| repos               | TEXT (JSON array)                  | e.g. `["gp-api","gp-webapp"]`                                                |
| priority            | INTEGER                            | 1 (critical) – 5 (someday)                                                   |
| status              | TEXT                               | `queued`, `in-progress`, `blocked`, `pr-open`, `merged`, `done`, `abandoned` |
| source              | TEXT                               | `user`, `idea:<id>`, `signal:<id>`, `cos`                                    |
| depends_on          | TEXT (JSON array of work_item ids) | empty in MVP; used when planning arrives                                     |
| session_id          | TEXT FK                            | current worker (nullable)                                                    |
| pr_urls             | TEXT (JSON array)                  | PRs opened for this item                                                     |
| worklog_path        | TEXT                               | `~/.claude/cos/worklogs/<id>.md`                                             |
| created_at          | TIMESTAMP                          |                                                                              |
| updated_at          | TIMESTAMP                          |                                                                              |
| completed_at        | TIMESTAMP                          | nullable                                                                     |

### ideas

| column      | type              | notes                                                                           |
| ----------- | ----------------- | ------------------------------------------------------------------------------- |
| id          | TEXT PK           | `idea-<ulid>`                                                                   |
| title       | TEXT              |                                                                                 |
| description | TEXT              |                                                                                 |
| source      | TEXT              | `user`, `generator:ai-native`, `generator:diff`, `cos-triage:signal-<id>`, etc. |
| confidence  | REAL              | 0.0 – 1.0, how strongly the generator believes it's worth doing                 |
| repos_guess | TEXT (JSON array) | optional                                                                        |
| status      | TEXT              | `new`, `promoted`, `deferred`, `killed`                                         |
| promoted_to | TEXT FK           | work_item id, if promoted                                                       |
| created_at  | TIMESTAMP         |                                                                                 |

### signals

| column     | type        | notes                                                                                                                     |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| id         | TEXT PK     | `sig-<ulid>`                                                                                                              |
| source     | TEXT        | `github`, `sentry`, `grafana`, `slack`, `calendar`, `clickup`                                                             |
| kind       | TEXT        | `pr-needs-review`, `pr-has-comments`, `ci-failed`, `new-error`, `alert`, `mention`, `meeting-soon`, `task-assigned`, etc. |
| payload    | TEXT (JSON) | source-specific                                                                                                           |
| status     | TEXT        | `new`, `triaged`, `suppressed`, `converted-to-idea`, `converted-to-work-item`                                             |
| triaged_at | TIMESTAMP   | nullable                                                                                                                  |
| created_at | TIMESTAMP   |                                                                                                                           |

### sessions

| column         | type      | notes                                                                   |
| -------------- | --------- | ----------------------------------------------------------------------- |
| id             | TEXT PK   | `sess-<ulid>`                                                           |
| work_item_id   | TEXT FK   | nullable (for non-work-item sessions like `/cos` dialogs)               |
| tmux_window    | TEXT      | e.g. `cos-workers:3`                                                    |
| kind           | TEXT      | `worker`, `cron`, `dialog`, `meeting-prep`                              |
| status         | TEXT      | `starting`, `running`, `idle`, `completed`, `failed`, `killed`, `stale` |
| last_heartbeat | TIMESTAMP |                                                                         |
| started_at     | TIMESTAMP |                                                                         |
| ended_at       | TIMESTAMP | nullable                                                                |

### notifications

| column      | type        | notes                                             |
| ----------- | ----------- | ------------------------------------------------- |
| id          | TEXT PK     |                                                   |
| subject     | TEXT        |                                                   |
| body        | TEXT        |                                                   |
| urgency     | TEXT        | `urgent`, `normal`, `digest`                      |
| related_ids | TEXT (JSON) | work_item / signal / session ids                  |
| pushed_at   | TIMESTAMP   | nullable (null means "in digest, not yet pushed") |
| acked_at    | TIMESTAMP   | nullable                                          |

### cos_log

| column             | type      | notes                               |
| ------------------ | --------- | ----------------------------------- |
| id                 | TEXT PK   |                                     |
| tick_at            | TIMESTAMP |                                     |
| signals_triaged    | INTEGER   |                                     |
| ideas_promoted     | INTEGER   |                                     |
| items_dispatched   | INTEGER   |                                     |
| notifications_sent | INTEGER   |                                     |
| summary            | TEXT      | short markdown summary of decisions |

## Persona & Context Files

### system.md

The strategic-advisor persona prompt (adapted from the user's long-time COS prompt). Defines:

- Role: tech lead advisor, organizational leverage counselor, team coach, product/eng/business bridge.
- Behavioral constraints: rigorous not polite, strategically opinionated, context-hungry.
- Elevation mandate: push conversations from tasks → projects → systems → incentives → culture → strategy.

### team.md

Who's on the team. Skill distribution. Dynamics. Known blind spots of the user as a leader. Updated by COS when the user shares relevant context ("Mike is ramping on Prisma, don't assign him the schema split yet").

### arch.md

Architectural decisions and invariants:

- Monorepo-of-repos topology.
- Shared contracts via `gp-api/contracts` npm workspace.
- S2S JWT auth between services.
- Repo-per-service DB isolation.
- Key incidents and their lessons (references AARs).

### priorities.md

Current-quarter goals, open initiatives, explicit non-priorities. What the user has committed to internally. Used by COS to push back when a proposed work item drifts from priorities.

### ai-native.md

Pointers to each repo's AI-native evaluation doc and its "highest-leverage fix" rows. Source for the idea generator.

### decisions.log

Append-only. Every COS cron tick writes a row: what it saw, what it decided, why. Enables audit and continuity across runs. Also used as recent-context in dialog mode so COS has memory of what it's been doing.

### status.md

Regenerated every cron tick. Current queue state, active workers, PRs awaiting review, ideas backlog depth, recent notifications. Single source of truth for "what's happening right now." Human-readable; you can `cat` it, tail it, pipe it to tmux status, or open it in a tab.

## Runtime Modes

### Cron mode (autonomous, every 15 min)

Triggered by a macOS **launchd** LaunchAgent (`~/Library/LaunchAgents/com.smolster.cos.cron.plist`) that runs `claude -p "<cron-prompt>"` every 900 seconds, `RunAtLoad=true`, loaded at login via `launchctl bootstrap gui/$(id -u)`. No terminal required; survives reboots. Each tick is a single headless Claude turn — stateless, reads everything from `fleet.db` and `~/.claude/cos/*.md`, writes everything back.

stdout/stderr from each tick go to `~/.claude/cos/logs/cron.log` with timestamps. If five consecutive ticks fail, launchd's `ThrottleInterval` kicks in and a `PushNotification` is sent via an `ExitHook` wrapper script so failure is visible.

Each tick:

1. **Refresh signals** — run signal collectors (MVP: GitHub only; later, all). Write new rows to `signals`.
2. **Triage signals** — for each `new` signal, decide:
   - Suppress (`sig-triaged`, no action)
   - Convert to idea (write `ideas` row, mark `sig-converted-to-idea`)
   - Convert to work item (write `work_items` row at priority, mark `sig-converted-to-work-item`)
   - Notify user directly (push, and mark `sig-triaged` — some signals are just "you should know")
3. **Dispatch ready work items** — for queued items where worker-count < max-parallelism and no open PR is blocking, spawn a worker via `spawn-worker`.
4. **Check active sessions** — update heartbeats; detect stale sessions (no heartbeat in 20 min); mark failed; push notification.
5. **Render `status.md`** — queue depth, active sessions, PRs awaiting review, recent notifications.
6. **Append `cos_log`** — summary of what this tick did.

### Dialog mode (user-invoked)

User types something that matches the COS skill's description. Skill loads:

- `system.md` (persona)
- `team.md`, `arch.md`, `priorities.md` (context)
- Last N entries of `decisions.log` (recent COS activity)
- Relevant state (current queue snapshot if the question is operational)

Then engages in dialogue. May propose writing a new file to `~/.claude/cos/` (e.g., a design-doc critique), may update `decisions.log`, may enqueue a work item.

### Embedded mode (subagent)

A worker (or a cron tick) calls the COS persona as a subagent for a tradeoff call. E.g., a worker trying to split a service calls COS to confirm the split boundary aligns with `arch.md`.

### Meeting mode (calendar-triggered)

30 min before a meeting on the watched calendar, COS (via cron) spawns a meeting-prep session:

- Pulls the calendar event details.
- Pulls relevant ClickUp tasks, Gmail threads, Notion/Drive docs (via MCP).
- Pulls last meeting notes with same participants.
- Writes `~/.claude/cos/meetings/YYYY-MM-DD-<slug>.md` with an agenda draft.
- Pushes a notification: "Meeting in 30 with Mike. Prep is ready."

After the meeting (detected by calendar end + N minutes), COS checks for a transcript (if available via integration), extracts TODOs, and either enqueues them or writes to priorities / team notes. MVP does prep only; post-meeting extraction is self-build item.

## Worker Dispatch

### Spawn mechanism

`spawn-worker` skill (or underlying script). Given a work item id:

1. Read `work_items` row.
2. For each repo in `work_items.repos`:
   - Create worktree `../<repo>-worktrees/<work-item-id>` off latest `develop`.
   - Run post-worktree hook (`npm install --legacy-peer-deps` for TS repos, `uv sync` for Python).
3. Create worklog at `~/.claude/cos/worklogs/<work-item-id>.md` with: goal, acceptance criteria, PR plan (likely single PR for MVP-era work), notes section, status.
4. Register a row in `sessions`.
5. Open a new tmux window in a `cos-workers` tmux session.
6. Start `claude -p "<prompt>"` in the window. The prompt includes:
   - Work item description + acceptance criteria
   - Worklog path and instructions to update it
   - Session id and heartbeat command
   - Repo(s) it can touch + worktree paths
   - Rules: test before PR, use `develop` base, don't self-approve, sequential PR gating
   - Reference to `~/.claude/cos/arch.md` and the repo's `CLAUDE.md`

### Heartbeat

Worker calls a tiny CLI (e.g., `cos heartbeat <session-id>`) at each major step transition. Updates `sessions.last_heartbeat`. Cron tick detects > 20 min silence → mark stale → push notify.

### Worker lifecycle

1. Worker starts → `starting`.
2. First heartbeat → `running`.
3. PR opened → `pr-open` state on the work item; worker process exits; `sessions.status = idle`.
4. PR gets comments / CI fails → cron detects, spawns a fix-comments worker (same work item, new session).
5. PR merged → `merged` → `done` after verification. Worktree cleaned up.

### Auto-dispatch vs. hand-dispatch

An enqueued item auto-dispatches if:

- Priority ≤ 3, AND
- `repos` is set, AND
- `acceptance_criteria` is non-empty, AND
- No other session is active on the same work item, AND
- Worker count for today < daily cap (default: 8).

Otherwise COS asks: "This looks underspecified — want me to groom it more, or dispatch anyway?"

## Self-healing invariants (`cos doctor`)

`cos doctor` runs as step 0 of every cron tick and can also be invoked by hand. It enforces a short list of cross-cutting invariants that, if violated, mean the system's view of itself has drifted from reality. The first five are auto-fixable when `--auto-fix` is set; the last two are escalations that always notify.

| #   | Invariant                                                                                                                                  | Auto-fix action (with `--auto-fix`)                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Sessions marked `running`/`starting` whose tmux window is gone                                                                             | Mark session `stale`; record `tmux window not found` in notes                                                      |
| 2   | Sessions marked `running` with `last_heartbeat` older than `stale_heartbeat_minutes` (default 20)                                          | Mark session `stale`; record the age in notes                                                                      |
| 3   | Worker log `~/.claude/cos/logs/worker-<sess>.log` that is 0 bytes AND older than 5 min, while session is still `starting`/`running`/`idle` | Kill the tmux window; mark session `failed` with note `claude produced no output`; flip the work item to `blocked` |
| 4   | Work items in status `pr-open` whose referenced PR is actually `MERGED` or `CLOSED` on GitHub                                              | Reconcile to `merged` or `abandoned`                                                                               |
| 5   | Work items marked `queued` but with an active (`running`/`starting`) session on them                                                       | Flip work item to `in-progress`                                                                                    |
| 6   | **Circuit breaker** — last 3 worker sessions all ended `failed` within 15 min of start (no PRs opened)                                     | Set `dispatch_paused=true` in `config.json`; push **urgent** notification                                          |
| 7   | Last 3 cron ticks all exited non-zero                                                                                                      | Push **urgent** notification                                                                                       |

Flags:

- `--auto-fix` — apply fixes for 1–5; always notify on 6–7.
- `--dry-run` — report only; never mutate state or send notifications.
- `--format text|json` — default `text`; `json` is machine-readable and used by `cos tick`.

The cron tick always calls doctor with `--auto-fix --format json` and embeds the resulting report in the state snapshot handed to the claude invocation (key: `doctor_report`). That lets the agent see what just got fixed without re-deriving it.

## Signal Collection

MVP: **GitHub only.** Implemented as a function called at the start of each cron tick. Queries via `gh` CLI:

- Open PRs in any watched repo where I'm a requested reviewer.
- PRs I authored with new comments since last tick.
- PRs I authored with CI failed since last tick.
- PRs I authored merged since last tick (for cleanup / notifications).

Each writes a `signals` row keyed by `(kind, external_id)` to dedupe.

Self-build adds: Sentry, Grafana, Slack mentions, calendar, ClickUp assignments.

## Repo Layout

COS lives in its own standalone repo at `~/Repos/cos/` (published to `github.com/swain/cos`). The operational directory at `~/.claude/cos/` is a mix of symlinks (to the repo for generic machinery) and real local files (for personal state).

### What lives in the repo (committable)

- `design.md` — this spec
- `USING_COS.md` — the how-to guide
- `system.md` — persona
- `po.md` — the bio
- `CLAUDE.md.template` — `~/.claude/CLAUDE.md` bootstrap
- `cli/` — Node/TS CLI source (without `node_modules/`, without `dist/`)
- `prompts/cron.md`, `prompts/worker.md`
- `bin/cos`, `bin/cos-tick`, `bin/spawn-worker`
- `commands/{fleet,enqueue,cos,groom,dispatch}.md` — slash commands
- `launchd/com.cos.cron.plist.template` — LaunchAgent template with `{{USER_HOME}}` / `{{LABEL}}` placeholders
- `templates/` — starter copies of personal files (`team.md.template`, `priorities.md.template`, `arch.md.template`, `ai-native.md.template`, `watched-repos.json.template`, `config.json.template`)
- `install.sh` — bootstrap script for fresh machines
- `README.md`, `.gitignore`

### What stays local-only (never committed anywhere)

All under `~/.claude/cos/`:

- `fleet.db` — runtime SQLite state
- `decisions.log` — may reference teammates, incidents, private calls
- `status.md` — ephemeral, regenerated every tick
- `team.md` — candid people notes
- `priorities.md` — business-sensitive goals
- `arch.md` — org-specific architecture (customized from template; template in the repo is generic)
- `ai-native.md` — pointers to your own eval docs
- `watched-repos.json`, `config.json`
- `worklogs/`, `meetings/`, `logs/`
- Any file ending in `.local.md` (escape hatch for local-only notes)

### Teammate adoption path

A teammate cloning the cos repo:

1. `git clone https://github.com/swain/cos ~/Repos/cos`.
2. `~/Repos/cos/install.sh` — symlinks shareable files into `~/.claude/`, copies starter templates for personal files (only if they don't exist — safe to re-run), builds the CLI, renders the launchd plist.
3. Fill in `~/.claude/cos/team.md`, `priorities.md`. Customize `arch.md`, `ai-native.md`.
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<whoami>.cos.cron.plist`.

## MVP Scope (hand-built, target: end of Day 1)

1. **Directory + state substrate.** `~/.claude/cos/` created. `fleet.db` initialized with schema above. Node/TypeScript CLI `cos` at `~/.claude/cos/cli/` using `better-sqlite3` for direct DB manipulation (heartbeats, enqueue, fleet read, dispatch). Built with `tsup` to a single `dist/cos.js`; installed to PATH via a shim at `~/.claude/cos/bin/cos`. Exposes subcommands: `cos heartbeat <session-id>`, `cos enqueue …`, `cos fleet`, `cos signals`, `cos ideas`, `cos dispatch <work-item-id>`, `cos tick` (one cron tick for testing).
2. **Persona + seed context.** `system.md` written (adapted from user's COS prompt). `team.md`, `arch.md`, `priorities.md`, `ai-native.md` seeded with initial content from user + eval docs.
3. **Global CLAUDE.md update.** Adds COS identity section at top.
4. **The `cos` skill.** Broad description so it triggers on daily-life intents. Sub-skills: `cos-enqueue`, `cos-fleet`, `cos-dispatch`, `cos-groom`.
5. **Cron loop.** launchd LaunchAgent `com.smolster.cos.cron` every 900s. Invokes `claude -p` with the cron prompt, capturing output to `~/.claude/cos/logs/cron.log`. Loaded at login, survives reboots, no terminal session required.
6. **Worker dispatch.** `spawn-worker` sub-skill + supporting tmux/bash script. Dispatches a work item to a tmux-resident `claude -p` worker with worklog path and heartbeat instructions.
7. **`USING_COS.md` guide.** Seeded with initial usage patterns, English-intent examples, daily rhythm.
8. **Standalone `cos` repo.** `~/Repos/cos/` with all committable files at their natural paths; `install.sh` wired up to symlink into `~/.claude/` and copy starter templates for personal files. Initial commit locally; push to GitHub when the user is ready.

## Self-Build Queue (built by MVP, target: Days 2–5)

Each is a queued work item on MVP launch. Order roughly:

| #   | Item                            | Priority | Repos | Notes                                    |
| --- | ------------------------------- | -------- | ----- | ---------------------------------------- |
| 1   | Sentry signal collector         | 2        | cos   | New errors, error spike detection        |
| 2   | ClickUp signal collector        | 3        | cos   | Assigned tasks, mentions, deadlines      |
| 3   | Calendar + meeting-prep flow    | 2        | cos   | Pulls context, drafts agenda             |
| 4   | Grafana signal collector        | 3        | cos   | Firing alerts, failed deploys            |
| 5   | Slack signal collector          | 3        | cos   | DMs, mentions in key channels            |
| 6   | Idea generator: ai-native evals | 2        | cos   | Read eval docs, propose PRs              |
| 7   | Idea generator: diff-driven     | 3        | cos   | Scan recent team PRs, propose follow-ups |
| 8   | Weekly review flow              | 3        | cos   | Digest of shipped / stale / drifting     |
| 9   | Worker lifecycle polish         | 3        | cos   | Stale detection, auto-kill, auto-revive  |
| 10  | Planning / chunking             | 4        | cos   | Pa-style multi-PR dependency graphs      |
| 11  | Post-meeting TODO extraction    | 3        | cos   | Read transcripts, enqueue or note        |

## Push Notifications

Uses the `PushNotification` tool. Each cron tick may generate:

- **Urgent** (immediate push): a CI failure on my PR, a PR needs my review and has been waiting > 2h, an agent is stale, a meeting starts in 30 min, a worker asked a clarifying question.
- **Normal** (immediate push): work item completed and PR merged, an idea got generated and needs triage.
- **Digest** (queued for next digest push, max 1/day default): anything COS decides can wait.

User can reply to a notification in plain English ("handle it autonomously," "wait," "show me the diff"). COS parses the reply in the next cron tick or next user session.

## Deliverables

1. **`~/Repos/cos/design.md`** (this file) — committed to the standalone `cos` repo, symlinked into `~/.claude/cos/design.md`.
2. **`~/.claude/cos/USING_COS.md`** — the how-to-use guide. Written during MVP build and continuously updated.
3. **The MVP itself** — code, skill definitions, CLAUDE.md updates, seed context files, initial cron registration.
4. **The self-build queue** — 11 work items seeded into the MVP on launch day.
5. **Implementation plan** — step-by-step for the MVP build, generated as the next output after this spec is approved.

## Open Questions / Risks

- **launchd tick cost.** 96 `claude -p` invocations per day. Each tick is short (read state, decide, write files) so cost should be modest, but should be monitored early. If it becomes an issue, batch ticks via a longer interval + more work per tick, or introduce a "sleep mode" (e.g., only 1 tick per 2 hours overnight).
- **Tmux still in the loop for workers.** Pragmatic for MVP (isolation, outlives main session, peek-ability). Accept the cost. Workers never appear in the user's main tmux — they live in a dedicated `cos-workers` session the user rarely attaches to.
- **Dispatch confidence.** Auto-dispatch logic in MVP is naive (priority ≤ 3 + fields filled). May over-dispatch low-quality items. Refined in self-build via better grooming + idea-generator confidence scoring.
- **PR review flow.** When a worker opens a PR, I still have to review it. MVP does not auto-review (would be self-approving). Post-MVP: a pre-review agent (already have pr-review-toolkit plugin) runs on each opened PR and posts findings, so my review is mostly "yes/no" not "read from scratch."
- **Legibility for teammates.** Nothing is broken for them by my setup (it's all in my `~/.claude/`). But adoption requires documentation + a setup script. Deferred, but `USING_COS.md` should be written with eventual teammate copying in mind.
- **Secret handling.** Signal collectors need tokens (GitHub already via `gh`; Sentry, Grafana, ClickUp already in MCP configs). Confirm no token lands in the `fleet.db` or worklogs.

## Timeline

| Day       | Target                                                           |
| --------- | ---------------------------------------------------------------- |
| 0 (today) | Spec approved; implementation plan written; plan approved.       |
| 1         | MVP built, smoke-tested, seeded with self-build queue.           |
| 2         | Items #1–5 in flight; ~5 PRs for user review.                    |
| 3         | Items #6–7 in flight; ~2 PRs for user review.                    |
| 4         | Items #8–9 in flight; ~2 PRs for user review.                    |
| 5         | Items #10–11 in flight; ~2 PRs for user review.                  |
| 6–7       | Buffer; polish; `USING_COS.md` second pass; first weekly review. |

End of Day 7: v1 complete.

## Anti-Patterns to Avoid

- **Slash commands as primary interface.** English is the contract. Slash commands are keyboard shortcuts.
- **Silent failure.** If a worker dies without a PR, that's a push notification, not a ghost in the db.
- **Oversurfacing.** If every signal becomes a notification, the user stops reading. COS's job is to _suppress_ the 90% that don't matter so the 10% cut through.
- **Drift from persona.** If dialog mode starts sounding like a generic assistant, reload `system.md`. The persona is load-bearing.
- **Building features not in the queue.** Every post-MVP change goes through the queue. No one-off "let me just tweak this."
- **Bikeshedding the dashboard.** `status.md` is the dashboard. Resist building a TUI/web UI unless v1 has been live for 2+ weeks and status.md has demonstrably failed.
