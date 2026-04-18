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
  cronTicks,
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
import { collectGrafanaSignals } from "../collectors/grafana.js";
import { runCalendarCollector } from "../collectors/calendar.js";
import { collectClickupSignals } from "../collectors/clickup.js";
import { collectSlackSignals } from "../collectors/slack.js";
import { cmdRenderStatus } from "./fleet.js";
import { ideas } from "../db.js";
import { runDoctor, type DoctorReport } from "./doctor.js";

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

2. DISPATCH ready work items. For each queued work item eligible for auto-dispatch (config.json auto_dispatch_max_priority and dispatch_paused apply), run \`cos dispatch <wi-id>\`. No daily cap — dispatch every eligible item.

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

  // Mark the tick as in-progress in the DB before any work runs. This is
  // what `cos fleet` and the inbox use to show "Cron tick in progress"
  // instead of just the last completed timestamp. Skip the marker in
  // --dry-run so preview runs do not pollute the UI.
  if (!opts.dryRun) cronTicks.start(tickId);
  let rc: number | null = null;

  try {
    // 0) Collect GitHub signals. Runs before doctor so invariant 13
    //    (pr-comment re-dispatch) can see freshly-collected signals this
    //    same tick, otherwise claude's LLM triage would mark them triaged
    //    before doctor ever gets a chance.
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
      console.error(
        chalk.yellow(`[tick] github collection error: ${e.message}`),
      );
    }

    // 0b) Collect Grafana signals (firing alerts; dedup is via external_id).
    try {
      const collected = await collectGrafanaSignals();
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
          `[tick] grafana: ${inserted} new / ${collected.length} firing`,
        ),
      );
    } catch (e: any) {
      console.error(
        chalk.yellow(`[tick] grafana collection error: ${e.message}`),
      );
    }

    // 0c) Collect calendar + meeting-prep — spawns claude with MCP tools.
    //     Writes prep files to ~/.claude/cos/meetings/, emits
    //     meeting-prep-ready signals, and records urgent notifications.
    //     Skipped in --dry-run because it is itself a claude invocation.
    if (!opts.dryRun) {
      try {
        const res = runCalendarCollector();
        if (!res.ran) {
          console.error(
            chalk.gray(`[tick] calendar: skipped (${res.reason ?? "?"})`),
          );
        } else {
          console.error(
            chalk.gray(
              `[tick] calendar: exit ${res.exitCode ?? "null"}${res.reason ? ` (${res.reason})` : ""}`,
            ),
          );
        }
      } catch (e: any) {
        console.error(chalk.yellow(`[tick] calendar error: ${e.message}`));
      }
    }

    // 0d) Collect ClickUp signals
    try {
      const collected = await collectClickupSignals();
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
          `[tick] clickup: ${inserted} new / ${collected.length} checked`,
        ),
      );
    } catch (e: any) {
      console.error(
        chalk.yellow(`[tick] clickup collection error: ${e.message}`),
      );
    }

    // 0e) Collect Slack signals (DMs + @-mentions via MCP). Best-effort:
    //     slack requires spawning an inner claude subprocess for MCP access,
    //     so any failure here should not abort the tick.
    try {
      const collected = await collectSlackSignals();
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
          `[tick] slack: ${inserted} new / ${collected.length} checked`,
        ),
      );
    } catch (e: any) {
      console.error(
        chalk.yellow(`[tick] slack collection error: ${e.message}`),
      );
    }

    // 1) Doctor — run system invariants and auto-fix.
    //    Runs even in --dry-run mode for the tick: the tick's dry-run only
    //    skips invoking claude, but doctor's own dry-run is independent.
    let doctorReport: DoctorReport | null = null;
    try {
      doctorReport = runDoctor({
        autoFix: !opts.dryRun,
        dryRun: !!opts.dryRun,
        format: "json",
      });
      console.error(
        chalk.gray(
          `[tick] doctor: ${doctorReport.summary.issues} issue(s), fixed=${doctorReport.summary.fixed}, notified=${doctorReport.summary.notified}`,
        ),
      );
    } catch (e: any) {
      console.error(chalk.yellow(`[tick] doctor error: ${e.message}`));
    }

    // 2) Prepare state snapshot for the claude invocation
    const snapshot = {
      now: nowIso(),
      doctor_report: doctorReport,
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
    rc = claudeRes.status ?? null;

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
      summary: `tick ${tickId} rc=${rc ?? "null"}`,
    });
    appendFileSync(
      DECISIONS_LOG,
      `\n---\n[${startedAt}] tick ${tickId} rc=${rc ?? "null"}\n`,
    );
  } finally {
    // Clear the start marker whether the tick completed cleanly, threw,
    // or returned early (dry-run returns before rc is set). Using
    // try/finally rather than post-claude cleanup is deliberate — a
    // thrown doctor/collector/snapshot error would otherwise leave the
    // UI stuck showing "in progress" forever.
    if (!opts.dryRun) cronTicks.end(tickId, rc);
  }

  if (rc !== null && rc !== 0) {
    console.error(chalk.red(`[tick] claude exited ${rc}`));
    process.exit(rc ?? 1);
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
