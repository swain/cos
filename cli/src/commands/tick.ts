import { ulid } from "ulid";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import {
  cosLog,
  signals,
  workItems,
  sessions as sessionsApi,
  notifications,
} from "../db.js";
import {
  CLAUDE_BIN,
  CLAUDE_PLUGIN_DIR,
  COS_DIR,
  DECISIONS_LOG,
  PROMPTS_DIR,
  nowIso,
} from "../util.js";
import { collectGithubSignals } from "../collectors/github.js";
import { cmdRenderStatus } from "./fleet.js";
import { ideas } from "../db.js";

const DEFAULT_CRON_PROMPT = `You are the COS (Chief of Staff) cron agent running a scheduled tick.

Your job this tick, in order:

1. TRIAGE new signals. For each signal with status=new:
   - If it is noise or low-value: \`cos signal-triage <id> suppress\`
   - If it is a signal the user should know about but it does not need action: \`cos signal-triage <id> notify --title "..." --urgency normal\`
   - If it could be a PR-sized piece of work but needs grooming: \`cos signal-triage <id> idea --title "..." --description "..."\`
   - If it is a clear actionable work item: \`cos signal-triage <id> work-item --title "..." --description "..." --priority <1-5> --repos '["repo"]' --acceptance "..."\`
   - PR-needs-my-review signals: ALWAYS notify urgent so the user sees them.
   - PR-ci-failed on my own PRs: create a work item at priority 2 to fix the failure, with the PR URL in the description.
   - PR-comments-on-mine: create a work item at priority 2 to address comments, unless the PR is already in pr-open state for a work item, in which case notify urgent to the user.
   - PR-merged: suppress (it's handled by the worker-done flow) or notify digest.

2. DISPATCH ready work items. For each queued work item eligible for auto-dispatch (config.json auto_dispatch_max_priority and dispatch_paused apply), run \`cos dispatch <wi-id>\`. Respect daily worker cap.

3. PUSH notifications. Read \`cos notify-unpushed\`. For each urgent or normal notification, call the PushNotification tool with subject+body. Then \`cos notify-mark-pushed <id>\`.

4. CHECK stale sessions. Any session whose last_heartbeat is > 20 min ago and status != completed|failed|killed should be marked stale (\`cos session-mark-stale <id>\`) and a notification raised.

5. WRITE a one-paragraph decision log entry to \`~/.claude/cos/decisions.log\` describing what you did this tick (append, don't overwrite). Keep it concise.

6. When done, do not perform other tasks. Exit.

All state is in \`~/.claude/cos/fleet.db\` (SQLite). Use the \`cos\` CLI for every mutation. Do NOT edit the DB directly.

Config is at \`~/.claude/cos/config.json\`. Watched repos at \`~/.claude/cos/watched-repos.json\`. Durable context at \`~/.claude/cos/{system,team,arch,priorities,ai-native}.md\` — read them if and only if you need to.

Current state snapshot is attached below. Begin now.
`;

export const cmdTick = async (opts: { dryRun?: boolean } = {}) => {
  const tickId = `tick-${ulid()}`;
  const startedAt = nowIso();
  console.error(chalk.gray(`[tick ${tickId}] start ${startedAt}`));

  // 1) Collect GitHub signals
  try {
    const collected = await collectGithubSignals();
    let inserted = 0;
    for (const s of collected) {
      const id = `sig-${ulid()}`;
      const res = signals.insert({
        id,
        source: s.source,
        kind: s.kind,
        external_id: s.external_id,
        payload: s.payload,
        status: "new",
        triaged_at: null,
      });
      if (res.inserted) inserted++;
    }
    console.error(
      chalk.gray(
        `[tick] github: ${inserted} new / ${collected.length} checked`,
      ),
    );
  } catch (e: any) {
    console.error(chalk.yellow(`[tick] github collection error: ${e.message}`));
  }

  // 2) Prepare state snapshot for the claude invocation
  const snapshot = {
    now: nowIso(),
    new_signals: signals.list({ status: "new" }),
    queued_items: workItems.list({ status: "queued" }),
    pr_open_items: workItems.list({ status: "pr-open" }),
    active_sessions: [
      ...sessionsApi.list({ status: "running" }),
      ...sessionsApi.list({ status: "starting" }),
    ],
    unpushed_notifications: notifications.listUnpushed(),
  };

  const promptPath = join(PROMPTS_DIR, "cron.md");
  const promptTemplate = existsSync(promptPath)
    ? readFileSync(promptPath, "utf8")
    : DEFAULT_CRON_PROMPT;
  const fullPrompt = `${promptTemplate}\n\n---\n\n## Current state\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n`;

  if (opts.dryRun) {
    console.log(fullPrompt);
    return;
  }

  // 3) Invoke claude -p
  const args = [
    "--plugin-dir",
    CLAUDE_PLUGIN_DIR,
    "--dangerously-skip-permissions",
    "-p",
    fullPrompt,
  ];
  console.error(
    chalk.gray(
      `[tick] invoking claude (${args.length} args, prompt ${fullPrompt.length} chars)`,
    ),
  );
  const claudeRes = spawnSync(CLAUDE_BIN, args, {
    stdio: "inherit",
    env: { ...process.env, COS_TICK_ID: tickId },
  });

  // 4) Regenerate status.md
  try {
    cmdRenderStatus();
  } catch (e: any) {
    console.error(chalk.yellow(`[tick] render-status: ${e.message}`));
  }

  // 5) Log tick
  const dispatchedCount = sessionsApi
    .list({ status: "running" })
    .filter((s) => new Date(s.started_at).toISOString() > startedAt).length;
  cosLog.insert({
    id: tickId,
    signals_triaged: 0,
    ideas_promoted: 0,
    items_dispatched: dispatchedCount,
    notifications_sent: 0,
    summary: `tick ${tickId} rc=${claudeRes.status ?? "null"}`,
  });
  appendFileSync(
    DECISIONS_LOG,
    `\n---\n[${startedAt}] tick ${tickId} rc=${claudeRes.status ?? "null"}\n`,
  );

  if (claudeRes.status !== 0) {
    console.error(chalk.red(`[tick] claude exited ${claudeRes.status}`));
    process.exit(claudeRes.status ?? 1);
  }
  console.error(chalk.gray(`[tick ${tickId}] done`));
};

export const cmdSessionMarkStale = (id: string) => {
  const s = sessionsApi.get(id);
  if (!s) {
    console.error(chalk.red(`session not found: ${id}`));
    process.exit(2);
  }
  sessionsApi.update(id, { status: "stale" });
  console.log(chalk.yellow("marked stale"), id);
};
