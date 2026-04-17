# COS — Chief of Staff for Claude Code

A persistent AI chief-of-staff system built on Claude Code primitives. Combines:

- **A strategic-advisor persona** with durable context (team, architecture, priorities) loaded into every interaction.
- **A work queue spine** (SQLite) — signals → ideas → work items → sessions → PRs → done.
- **An autonomous cron tick** (launchd, every 15 min) that triages inbound signals, dispatches workers, pushes notifications.
- **Parallel background workers** (tmux + `claude -p`) that ship PRs without babysitting.
- **English-first interface** — you talk to it normally; slash commands are optional shortcuts.

> Built for one-person throughput of 5–10 PRs/day without babysitting agents, with the system itself as the artifact — legible enough for teammates to adopt.

## What you get

```
~/.claude/
├── CLAUDE.md           → symlink to cos repo's CLAUDE.md.template
│                          (makes every Claude Code session boot as COS)
├── commands/
│   ├── fleet.md        → symlink to cos/commands/fleet.md
│   ├── enqueue.md      → symlink
│   ├── cos.md          → symlink (full strategic dialogue)
│   ├── groom.md        → symlink
│   └── dispatch.md     → symlink
└── cos/
    ├── design.md            (symlinked from repo)  — full system design
    ├── USING_COS.md         (symlinked from repo)  — how to use this
    ├── system.md            (symlinked from repo)  — persona
    ├── prompts/             (symlinked from repo)  — cron + worker prompts
    ├── bin/                 (symlinked from repo)  — cos, cos-tick, spawn-worker
    ├── cli/                 (symlinked from repo)  — Node/TS CLI source
    ├── launchd/             (symlinked from repo)  — plist template
    ├── team.md              (LOCAL — your people)
    ├── priorities.md        (LOCAL — your goals)
    ├── arch.md              (LOCAL — your stack)
    ├── ai-native.md         (LOCAL — your eval docs)
    ├── watched-repos.json   (LOCAL — repos COS monitors)
    ├── config.json          (LOCAL — dispatch paused, daily cap, etc.)
    ├── fleet.db             (LOCAL — SQLite state)
    ├── decisions.log        (LOCAL — append-only cron history)
    ├── status.md            (LOCAL — regenerated every tick)
    ├── worklogs/            (LOCAL — per-worker logs)
    └── meetings/            (LOCAL — meeting prep + TODOs)
```

A launchd LaunchAgent runs every 15 minutes, calling `cos tick`, which invokes `claude -p` with the cron prompt. The agent reads state, decides what to do, calls the `cos` CLI for mutations, and pushes notifications for anything urgent.

## Prerequisites

- macOS (launchd-based cron)
- `node` (v20+), `npm`, `git`, `tmux`, `gh` (authenticated), `launchctl`
- [Claude Code](https://claude.com/code) installed, with `claude` on PATH (or at `~/.local/bin/claude`)
- An Anthropic API subscription or equivalent that lets `claude -p` run

## Install

```bash
git clone https://github.com/swain/cos ~/Repos/cos
cd ~/Repos/cos
./install.sh
```

The installer:

1. Checks prereqs.
2. Symlinks shareable files into `~/.claude/cos/` (design, USING_COS, system, prompts, bin, cli, launchd).
3. Symlinks the five slash commands into `~/.claude/commands/`.
4. Symlinks `~/.claude/CLAUDE.md` to the repo's `CLAUDE.md.template` (so every Claude Code session boots as COS).
5. Copies starter templates to `~/.claude/cos/team.md`, `priorities.md`, `arch.md`, `ai-native.md`, `watched-repos.json`, `config.json` — **only if they don't exist yet**, so re-runs are safe.
6. Installs npm deps + builds the CLI.
7. Adds `~/.claude/cos/bin` to your `$PATH` (in `~/.zshrc`).
8. Runs `cos init` to create `fleet.db`.
9. Renders the launchd plist with your paths.

It does **NOT** automatically load the launchd agent. Do that manually after customizing your personal files:

```bash
# Fill in team.md, priorities.md, arch.md, ai-native.md, watched-repos.json first.

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$(whoami).cos.cron.plist
launchctl kickstart gui/$(id -u)/com.$(whoami).cos.cron
```

## First-run checklist

1. **Personal context**: edit `~/.claude/cos/team.md` and `priorities.md` with your real people/goals.
2. **Architecture**: edit `~/.claude/cos/arch.md` with your stack (topology, auth, code style, deploy).
3. **Ideas source**: edit `~/.claude/cos/ai-native.md` with pointers to your own repo evaluations.
4. **Watched repos**: edit `~/.claude/cos/watched-repos.json` with repos COS should monitor for PRs needing your review, CI failures, etc.
5. **Unpause dispatch** when you're ready for workers to start running autonomously:

   ```bash
   jq '.dispatch_paused=false' ~/.claude/cos/config.json > /tmp/c && mv /tmp/c ~/.claude/cos/config.json
   ```

## How to use it

Plain English in any Claude Code session — `~/.claude/CLAUDE.md` tells Claude to behave as COS.

Examples:

- "status?" / "what's going on?" → `cos fleet` rendered as 3-line digest
- "add: fix the null check in auth.service" → grooms inline, `cos enqueue`, offers to dispatch
- "idea: split queueConsumer per-type" → `cos idea`
- "dispatch wi-01K…" → `cos dispatch`
- "triage ideas" / `/groom` → walks backlog, one-at-a-time
- "what do you think about X?" (design / tradeoff) → full persona + context loaded
- "pressure-test this design doc" [paste] → rigorous-not-polite critique
- "kill that runaway worker" → finds + stops
- "remember that we decided to defer the people-api split" → updates priorities.md

See `USING_COS.md` for the full guide (daily rhythm, notification types, anti-patterns, troubleshooting).

## Design philosophy

1. **English is the interface.** Slash commands exist but are optional shortcuts.
2. **The queue is the spine.** Nothing bypasses it to become a running worker.
3. **Sequential PR gating per work item.** Parallelism is across _different_ items.
4. **Minimal manual intervention.** COS triages, dispatches, and only pings you when you're needed.
5. **Dogfooding from day one.** Everything after MVP is built by MVP as work items. If it hurts to use COS to build COS, that's the signal to fix.
6. **Context is durable.** Decisions, team notes, architectural commitments live in markdown files. COS loads them into every dialog.
7. **Failure is visible.** Workers write worklogs. Stale sessions are detected. Nothing silently dies.

## Repo layout

| Path                                  | Purpose                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `design.md`                           | Full architecture + state schema                                                                                      |
| `implementation-plan.md`              | Step-by-step build plan (historical)                                                                                  |
| `USING_COS.md`                        | Daily-use guide                                                                                                       |
| `system.md`                           | Persona (loaded into every interaction)                                                                               |
| `CLAUDE.md.template`                  | User-level Claude instructions                                                                                        |
| `prompts/`                            | `cron.md` (every tick) and `worker.md` (every dispatch)                                                               |
| `bin/`                                | `cos` shim, `cos-tick` (launchd wrapper), `spawn-worker`                                                              |
| `cli/`                                | Node/TS CLI source (commander + better-sqlite3)                                                                       |
| `commands/`                           | Slash command definitions (`/fleet`, `/enqueue`, `/cos`, `/groom`, `/dispatch`)                                       |
| `launchd/com.cos.cron.plist.template` | LaunchAgent template (rendered by `install.sh`)                                                                       |
| `templates/`                          | Starter files for personal `team.md`, `priorities.md`, `arch.md`, `ai-native.md`, `watched-repos.json`, `config.json` |
| `install.sh`                          | Bootstraps a fresh machine                                                                                            |

## License

MIT (add a LICENSE file).

## Status

MVP. Self-build queue seeds 11 follow-up work items that extend COS via its own queue:
Sentry / ClickUp / Calendar / Grafana / Slack collectors, idea generator (ai-native + diff-driven), weekly review, worker lifecycle polish, planning/chunking, post-meeting TODO extraction.
