# COS — MVP Implementation Plan

**Companion to:** `~/.claude/cos/design.md`
**Target:** MVP operational by end of Day 1; self-build running by Day 2
**Dotfiles repo:** `https://github.com/swain/dotfiles`

---

## Phase 0 — Prereqs (15 min)

Verify before building. Fix anything missing before proceeding.

```bash
# Binaries on PATH
which node            # v20+
which npm
which tmux
which gh              # authenticated: gh auth status
which claude          # the Claude Code CLI
which launchctl

# Auth
gh auth status        # must show logged in as swain
cat ~/.claude/.credentials.json | jq '.claudeAiOauth' >/dev/null  # must exist

# Directories
ls ~/.claude/cos/     # already created
ls ~/.claude/commands/  # exists
```

Clone dotfiles if absent:

```bash
if [ ! -d ~/Repos/dotfiles ]; then
  gh repo clone swain/dotfiles ~/Repos/dotfiles
fi
```

Set canonical path: `DOTFILES=~/Repos/dotfiles`. Hardcode for MVP; parameterize in `init.sh` for teammate adoption.

## Phase 1 — State substrate (Node/TS CLI) (90 min)

### 1.1 Scaffold

```bash
mkdir -p ~/.claude/cos/cli/src/{commands,collectors}
mkdir -p ~/.claude/cos/{bin,logs,worklogs,meetings,prompts,launchd}
cd ~/.claude/cos/cli
npm init -y
```

### 1.2 Dependencies

```json
{
  "type": "module",
  "bin": { "cos": "./dist/cos.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --target node20 --out-dir dist --no-splitting --clean",
    "dev": "tsup src/index.ts --format esm --target node20 --out-dir dist --watch"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "commander": "^12.1.0",
    "zod": "^3.23.8",
    "ulid": "^2.3.0",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true
  }
}
```

### 1.3 Schema + DB module

`src/schema.sql` — one SQL file with all six `CREATE TABLE IF NOT EXISTS` statements exactly as typed in `design.md`. Run at CLI startup (idempotent).

`src/db.ts`:

- Opens `~/.claude/cos/fleet.db` via `better-sqlite3`
- On first open, reads and executes `schema.sql`
- Exports typed query helpers: `insertWorkItem`, `listWorkItems(filter)`, `updateWorkItemStatus`, `insertSignal`, `insertIdea`, `insertSession`, `updateHeartbeat`, `insertNotification`, `insertCosLog`, etc.
- All queries use prepared statements. All input validated with Zod schemas defined in `src/types.ts`.

### 1.4 Commands (`src/commands/*.ts`)

| Command                      | Args                                                                                     | Behavior                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `cos init`                   | —                                                                                        | Creates dirs, initializes `fleet.db`, writes default state.md, idempotent |
| `cos enqueue`                | `--title --description --repos --priority --acceptance` (stdin fallback for long fields) | Writes `work_items` row; prints `wi-<id>`                                 |
| `cos fleet`                  | `[--format md\|json]` (default md)                                                       | Renders status from queue + sessions + recent notifications               |
| `cos dispatch <wi-id>`       | `[--force]`                                                                              | Calls spawn-worker; writes sessions row; returns session id               |
| `cos heartbeat <sess-id>`    | `[--step <name>]`                                                                        | Updates `sessions.last_heartbeat`                                         |
| `cos worker-done <sess-id>`  | `--pr-url <url>` OR `--failed <reason>`                                                  | Marks session complete/failed, updates work item                          |
| `cos signals`                | `[--status <s>] [--source <s>]`                                                          | List signals                                                              |
| `cos signal-triage <sig-id>` | `--action <suppress\|idea\|work-item\|notify>` + args                                    | Applies triage                                                            |
| `cos ideas`                  | `[--status <s>]`                                                                         | List ideas                                                                |
| `cos idea-promote <idea-id>` | `--priority --repos --acceptance`                                                        | Converts idea → work item                                                 |
| `cos tick`                   | `[--dry-run]`                                                                            | Runs the cron tick logic inline (used by launchd wrapper and for testing) |
| `cos worker-prompt <wi-id>`  | —                                                                                        | Prints the assembled worker prompt for dispatch scripts                   |
| `cos dotfiles-sync`          | `[--push]`                                                                               | Stages/commits committable files to dotfiles repo                         |

### 1.5 Build + install

```bash
npm install
npm run build
cat > ~/.claude/cos/bin/cos <<'EOF'
#!/usr/bin/env bash
exec node ~/.claude/cos/cli/dist/cos.js "$@"
EOF
chmod +x ~/.claude/cos/bin/cos
# Add to PATH via ~/.zshrc
grep -q 'claude/cos/bin' ~/.zshrc || echo 'export PATH="$HOME/.claude/cos/bin:$PATH"' >> ~/.zshrc
```

### 1.6 Verification

```bash
cos init
cos enqueue --title "Test" --description "test enqueue" --repos '["cos"]' --priority 3 --acceptance "works"
cos fleet
# Should show 1 queued item
```

## Phase 2 — Persona + seed context (60 min)

Write these files. Use the user's original COS prompt (already in conversation history) for `system.md` with light adaptation for the COS-tooling role.

### 2.1 `~/.claude/cos/system.md` (committed)

Adapt the original COS prompt. Core: strategic advisor, rigorous-not-polite, context-hungry, elevation from tasks → strategy. Add a short operational appendix:

> **When invoked in dialog mode**, load `team.md`, `arch.md`, `priorities.md`, and the last 20 entries of `decisions.log`. When invoked in cron mode, focus on triage + dispatch per the cron prompt in `~/.claude/cos/prompts/cron.md`. Always write decisions worth remembering to `decisions.log`.

### 2.2 `~/.claude/cos/team.md` (LOCAL ONLY)

Skeleton:

```md
# Team

## Direct team (core squad)

- (fill in: name, role, strengths, current focus, blind spots, communication notes)

## Adjacent collaborators

- (fill in)

## Leadership dynamics

- (fill in: who I report to, what they care about, how I manage up)

## My own blind spots (per recent retros / feedback)

- (fill in)
```

COS will prompt the user to fill this during first `/cos` invocation.

### 2.3 `~/.claude/cos/arch.md` (committed)

Seed from `~/Repos/thegoodparty/CLAUDE.md` topology section + auth patterns + shared contracts + repo roles. Add:

- Deployment platforms per service
- Key invariants ("people-api queries use raw SQL", "repo-per-service DB isolation", "develop as default branch")
- Recent AAR references (list the `aar-*.md` filenames in `~/Repos/thegoodparty/`)

### 2.4 `~/.claude/cos/priorities.md` (LOCAL ONLY)

Skeleton:

```md
# Current Priorities

## Quarter

- (fill in top 3–5 objectives)

## Explicit non-priorities

- (things I am _not_ doing this quarter, so COS doesn't drift me toward them)

## Open initiatives

- (fill in)

## Recent commitments

- (fill in)
```

### 2.5 `~/.claude/cos/ai-native.md` (committed)

Pointers to the eval docs:

```md
# AI-Native Evaluation Docs

Source of ideas for PR-sized improvements. Each doc has a "highest-leverage fix" column per dimension.

- gp-api: ~/Repos/thegoodparty/ai-native-evaluation-gp-api.md
- gp-webapp: ~/Repos/thegoodparty/ai-native-evaluation-gp-webapp.md
- election-api: ~/Repos/thegoodparty/ai-native-evaluation-election-api.md
- people-api: ~/Repos/thegoodparty/ai-native-evaluation-people-api.md
- ops: ~/Repos/thegoodparty/ai-native-evaluation-ops.md

Idea generator (self-build item #6) reads these and enqueues ideas.
```

### 2.6 Init empty files

```bash
touch ~/.claude/cos/decisions.log
echo "# COS Status\n\nNot yet initialized. Run \`cos tick\` or wait for launchd." > ~/.claude/cos/status.md
```

## Phase 3 — Slash commands + CLAUDE.md (45 min)

### 3.1 CLAUDE.md update

Update `~/.claude/CLAUDE.md` (user-level; preserve existing memory + remember sections). Add at top:

```md
# You are my Chief of Staff (COS)

I have a persistent COS system at `~/.claude/cos/`. When I talk about:

- Work, PRs, queue, fleet, ideas, signals, dispatching → you act as the operational COS.
- Team, people, leadership, strategy, architecture, priorities → you act as the strategic-advisor COS.
- Meetings, calendar prep, post-meeting TODOs → you act as the COS in meeting mode.

**Before responding to any such intent**, read the relevant context files:

- Always: `~/.claude/cos/system.md` (persona)
- For strategic/team/arch/priority topics: `team.md`, `arch.md`, `priorities.md`
- For operational topics: `cos fleet` and recent `decisions.log`

**Action commands** (via Bash to the `cos` CLI):

- `cos enqueue …` — add work item
- `cos fleet` — current state
- `cos dispatch <id>` — spawn worker
- `cos ideas` / `cos idea-promote <id> …` — manage ideas
- `cos signals` / `cos signal-triage <id> …` — manage signals

**Persona discipline:** rigorous not polite, strategically opinionated, context-hungry. Push me from tasks → systems → strategy. Don't agree to agree.

See `~/.claude/cos/design.md` for full system design and `~/.claude/cos/USING_COS.md` for interaction patterns.
```

### 3.2 Slash commands at `~/.claude/commands/`

Thin wrappers. Each is a single markdown file with a `---` frontmatter and a short prompt.

- `~/.claude/commands/fleet.md` — runs `cos fleet` and presents it
- `~/.claude/commands/enqueue.md` — takes args, runs `cos enqueue` after brief grooming if underspecified
- `~/.claude/commands/cos.md` — loads full persona + context, enters dialog mode
- `~/.claude/commands/groom.md` — walks ideas interactively
- `~/.claude/commands/dispatch.md` — force-dispatch a specific work item

Each file format:

```md
---
description: <what it does>
---

<prompt body that references ~/.claude/cos/ files and cos CLI>
```

## Phase 4 — Worker dispatch (90 min)

### 4.1 Worker prompt template

`~/.claude/cos/prompts/worker.md` — loaded by `cos worker-prompt <wi-id>` and passed to `claude -p` at spawn time. The template includes `{{placeholders}}` substituted by the dispatcher. Covers:

- Your identity (worker on work item `{{wi-id}}`)
- Goal + acceptance criteria
- Worktree path(s)
- Rules:
  - Create branch `cos/{{wi-id}}-{{slug}}` off latest `develop`
  - Commit incrementally (one logical unit per commit, imperative subject lines, explain why in body when non-obvious)
  - Run tests + lint before PR
  - Use `gh pr create --base develop` with reviewer assignment
  - Sequential PR gating (do not open a second PR until first is merged)
  - Do not self-approve
  - Call `cos heartbeat {{session-id}} --step <name>` at: start, branch-created, tests-pass, pr-opened
  - Call `cos worker-done {{session-id}} --pr-url <url>` when PR is opened, then exit
- Reference `~/.claude/cos/arch.md` and the repo's `CLAUDE.md` before changing anything
- If stuck for > 10 min on a single step, call `cos worker-done {{session-id}} --failed "<reason>"` and exit; a future tick will escalate to user

### 4.2 `spawn-worker` script

`~/.claude/cos/bin/spawn-worker`:

```bash
#!/usr/bin/env bash
set -euo pipefail
WI_ID="$1"
SESS_ID=$(cos session-new --work-item "$WI_ID")
PROMPT=$(cos worker-prompt "$WI_ID" --session "$SESS_ID")

# Create worktrees (cos CLI outputs JSON {repo: worktreePath})
WORKTREES=$(cos worker-setup "$WI_ID")

# Ensure tmux session exists
tmux has-session -t cos-workers 2>/dev/null || tmux new-session -d -s cos-workers -n _placeholder

# Create window named by work item
tmux new-window -t cos-workers -n "$WI_ID" -c "$HOME"

# Send the claude invocation
# YOLO mode: --dangerously-skip-permissions (matches user's adopted mode)
tmux send-keys -t "cos-workers:$WI_ID" \
  "cd $(cos worker-primary-worktree $WI_ID) && claude -p \"\$(cos worker-prompt $WI_ID --session $SESS_ID)\" --dangerously-skip-permissions" Enter

echo "$SESS_ID"
```

### 4.3 Worktree setup

`cos worker-setup <wi-id>` does, for each repo in the work item:

```bash
WORKTREE_ROOT=~/Repos/$REPO-worktrees
BRANCH=cos/$WI_ID-$SLUG
mkdir -p $WORKTREE_ROOT
cd ~/Repos/$REPO
git fetch origin develop
git worktree add $WORKTREE_ROOT/$BRANCH origin/develop -b $BRANCH
cd $WORKTREE_ROOT/$BRANCH
# Post-hook, per repo type
case "$REPO" in
  gp-api|gp-webapp|people-api|election-api|ops) npm install --legacy-peer-deps ;;
  gp-ai-projects) uv sync ;;
esac
```

Stored as JSON in the `work_items` row so heartbeats and PR-open know the paths.

### 4.4 Verification

```bash
cos enqueue --title "Worker smoke test" \
  --description "Create a file hello.md at repo root with 'hi from cos worker'." \
  --repos '["ops"]' --priority 3 \
  --acceptance "File exists and PR is opened against develop."
WI=$(cos fleet --format json | jq -r '.queued[-1].id')
cos dispatch "$WI"
# Watch tmux: tmux attach -t cos-workers
# Within ~5-10 min: PR should be opened, session marked complete
```

## Phase 5 — Cron loop via launchd (75 min)

### 5.1 Cron prompt

`~/.claude/cos/prompts/cron.md` — the full instructions for one tick. Read by `cos tick` which assembles and passes to `claude -p`. Covers the six steps from design.md §Cron mode. Includes references to all the commands available and the decision rules for triage / dispatch / notify.

### 5.2 `cos tick` orchestration

The `cos tick` command:

1. Reads current state (signals, sessions, work items) into a context block.
2. Runs GitHub signal collector (section 5.4), writes new signal rows.
3. Assembles a prompt: cron prompt template + current state + task instructions.
4. Calls `claude -p` with the assembled prompt. Claude uses the `cos` CLI for all actions.
5. Reads the `decisions.log` entry Claude wrote, regenerates `status.md`, appends a `cos_log` row.

### 5.3 Wrapper script

`~/.claude/cos/bin/cos-tick`:

```bash
#!/usr/bin/env bash
set -o pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$HOME/.claude/cos/bin:$PATH"
LOG=$HOME/.claude/cos/logs/cron-$(date +%Y-%m-%d).log
{
  echo "=== tick $(date -Iseconds) ==="
  cos tick 2>&1
  RC=$?
  echo "=== tick end rc=$RC ==="
  exit $RC
} >> "$LOG"
```

Non-zero exit + launchd `ThrottleInterval` handle repeated failures; a separate failure-notify hook checks the last 5 tick exit codes and fires `PushNotification` via `cos notify --urgent --subject "COS cron failing" …`.

### 5.4 GitHub signal collector

Implemented in `src/collectors/github.ts`. Uses `gh` CLI via `child_process.execSync`:

- `gh search prs --review-requested=@me --state=open` → `kind=pr-needs-review`
- `gh search prs --author=@me --state=open` then per-PR `gh pr view --json comments,reviews,statusCheckRollup` → `kind=pr-has-comments` / `kind=ci-failed`
- `gh search prs --author=@me --state=merged --updated=>=$LAST_TICK` → `kind=pr-merged`

Watched repos are read from `~/.claude/cos/watched-repos.json` (seeded with thegoodparty/\* + any user repos).

Dedupe by `(kind, external_id)`. `external_id` = PR URL.

### 5.5 LaunchAgent

`~/Library/LaunchAgents/com.smolster.cos.cron.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.smolster.cos.cron</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-lc</string>
        <string>$HOME/.claude/cos/bin/cos-tick</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>/Users/smolster/.claude/cos/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/smolster/.claude/cos/logs/launchd.err.log</string>
</dict>
</plist>
```

Load:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smolster.cos.cron.plist
launchctl kickstart gui/$(id -u)/com.smolster.cos.cron   # force first run
```

### 5.6 Verification

```bash
# Smoke test manual tick before launchd
cos tick --dry-run
cos tick
cat ~/.claude/cos/status.md
tail ~/.claude/cos/decisions.log

# After launchd install
launchctl print gui/$(id -u)/com.smolster.cos.cron | grep -E 'state|last exit'
tail -f ~/.claude/cos/logs/cron-$(date +%Y-%m-%d).log

# Confirm a push notification arrived
```

## Phase 6 — USING_COS.md guide (45 min)

Write `~/.claude/cos/USING_COS.md` (committed). Sections:

1. **What COS is** — 1 paragraph.
2. **How you interact with it** — English is the interface. Table of example phrases and what happens.
3. **The queue model** — signals → ideas → work items → sessions → PRs → done. One diagram.
4. **Daily rhythm** — morning, midday, end-of-day flow. Concrete examples.
5. **When to reach for `/cos` explicitly** — strategic dialogue, pressure-testing a design, weekly review.
6. **Push notifications you'll get** — types, what to do with each, how to reply in English.
7. **How to extend COS** — queue a work item that describes the extension. Example: "Add a Linear signal collector."
8. **Anti-patterns** — what not to do, cross-referenced with design.md §Anti-Patterns.
9. **Troubleshooting** — cron not firing (`launchctl print …`), worker stuck (`tmux attach -t cos-workers`), db corruption (`cos repair`).
10. **Teammate adoption** — pointer to `init.sh`.

Length target: 600–1000 lines, example-heavy.

## Phase 7 — Dotfiles integration (60 min)

### 7.1 Create subdirectory

```bash
cd ~/Repos/dotfiles
mkdir -p claude-cos/{cli,skills,prompts,launchd,commands-snippets}
```

### 7.2 Move + symlink committable files

For each file in the commit allowlist (from design.md), move it to `~/Repos/dotfiles/claude-cos/<rel-path>` and symlink back to `~/.claude/cos/<rel-path>`:

```bash
move_and_link() {
  local rel="$1"
  mkdir -p "$(dirname ~/Repos/dotfiles/claude-cos/$rel)"
  mv ~/.claude/cos/$rel ~/Repos/dotfiles/claude-cos/$rel
  ln -s ~/Repos/dotfiles/claude-cos/$rel ~/.claude/cos/$rel
}

move_and_link design.md
move_and_link system.md
move_and_link arch.md
move_and_link ai-native.md
move_and_link USING_COS.md
move_and_link cli/package.json
move_and_link cli/tsconfig.json
move_and_link cli/src  # whole directory
move_and_link prompts/cron.md
move_and_link prompts/worker.md
move_and_link bin/cos
move_and_link bin/cos-tick
move_and_link bin/spawn-worker
# Note: cli/node_modules and cli/dist stay local only; .gitignore covers them.
```

Also: copy (don't move) the slash command files from `~/.claude/commands/` into `~/Repos/dotfiles/claude-cos/commands-snippets/` so they're versioned, but `~/.claude/commands/` itself is user-level. Teammate `init.sh` copies them into their own `~/.claude/commands/`.

The LaunchAgent plist: committed as a template at `~/Repos/dotfiles/claude-cos/launchd/com.cos.cron.plist.template` with `{{USER_HOME}}` / `{{LABEL_PREFIX}}` placeholders. The resolved plist in `~/Library/LaunchAgents/` is NOT symlinked because launchd wants a real file at a specific path — `init.sh` renders the template into place.

### 7.3 `.gitignore` in `claude-cos/`

```
fleet.db
decisions.log
status.md
team.md
priorities.md
worklogs/
meetings/
logs/
cli/node_modules/
cli/dist/
*.local.md
```

### 7.4 `init.sh`

Bootstrap script for a fresh machine. Idempotent. Steps:

1. Check prereqs (node, tmux, gh, claude, launchctl).
2. Create `~/.claude/cos/` dir structure.
3. Symlink committed files from `claude-cos/` to `~/.claude/cos/`.
4. Copy slash-command snippets to `~/.claude/commands/`.
5. Prompt for personal context: writes initial `team.md`, `priorities.md` from templates.
6. Render LaunchAgent plist from template with user paths; load via `launchctl bootstrap`.
7. `cd cli && npm install && npm run build`.
8. Run `cos init` to create the empty `fleet.db`.
9. Print "COS is running. Type `/cos hi` to say hello."

### 7.5 First commit

```bash
cd ~/Repos/dotfiles
git add claude-cos/
git commit -m "Add COS (Chief of Staff) personal agent system

See claude-cos/design.md for architecture, claude-cos/USING_COS.md
for interaction patterns."
git push origin main
```

## Phase 8 — Seed the self-build queue (30 min)

With MVP operational, enqueue the 11 self-build items. Each needs title + description + acceptance + repos + priority. Auto-dispatch will pick them up as workers free up (daily cap: 8, so items will batch).

Example for item #1:

```bash
cos enqueue \
  --title "Sentry signal collector" \
  --description "Add a Sentry collector to ~/.claude/cos/cli/src/collectors/sentry.ts that queries the goodparty Sentry org for (a) new errors in watched services since last tick, and (b) error-rate spikes. Emits signals with kind=new-error and kind=error-spike. Uses the sentry MCP; respects watched-services list in ~/.claude/cos/watched-services.json. Includes a test that dry-runs a query." \
  --repos '["cos"]' \
  --priority 2 \
  --acceptance "1) cos tick triages new Sentry errors; 2) a visible signal row appears with kind=new-error when a synthetic error is present; 3) watched-services.json created with sensible defaults."
```

Repeat for items #2–#11 (see design.md §Self-Build Queue for the full list).

After seeding, manually pause auto-dispatch with an env flag (`COS_DISPATCH_PAUSED=1` in `~/.claude/cos/config.json`) until you've reviewed the queue and are ready to let the build loose.

## Phase 9 — Smoke test + handoff (30 min)

Checklist (all must pass before declaring MVP done):

- [ ] `cos fleet` returns a rendered status with all 11 self-build items queued
- [ ] `cos tick` runs end-to-end without errors
- [ ] launchd agent fires on schedule (wait 15 min, check `~/.claude/cos/logs/cron-*.log`)
- [ ] Manually dispatch a trivial test work item (not one of the 11) and verify the worker opens a PR
- [ ] Push a test `PushNotification` and confirm it arrives on your phone / desktop
- [ ] `/cos hi` triggers the COS persona with durable context loaded
- [ ] `~/Repos/dotfiles/claude-cos/` is committed and pushed
- [ ] `~/.claude/cos/USING_COS.md` renders cleanly and passes a self-read

Flip `COS_DISPATCH_PAUSED=0`. Post-flip, the cron will start dispatching self-build items. Days 2–7 are COS building itself while you live your life and review PRs as they land.

## Phase 10 — Known risks during self-build

Flagged for the author (me) to watch during Days 2–7:

- **Workers going off-rails** on less-specified items. Mitigation: all 11 self-build items need tight acceptance criteria at seed time; first worker PR gets human eyeballs before the second dispatches in the same area.
- **Duplicate PRs** if a worker fails silently and a retry is spawned. Mitigation: `cos dispatch` checks for existing PRs for the same work item before spawning.
- **Cron cost creep.** Mitigation: first week, monitor token usage; if ticks routinely exceed 10k input tokens, add a "light tick" every-other-run that skips deep triage.
- **Worktree sprawl.** Mitigation: automatic cleanup at tick start (PR merged → worktree removed).
- **Dotfiles leak.** Mitigation: `.gitignore` covers the known bad files; `cos dotfiles-sync` requires manual push and shows a diff before pushing.

## Execution Order

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Each phase has verification; if verification fails, fix before proceeding. Phases 2 and 6 can run in parallel with 1 (they're pure content). Phase 7 depends on 1–6 being done.

Total estimated time: **~9 hours** of focused work for MVP. Realistic in a Day 1 if started early.
