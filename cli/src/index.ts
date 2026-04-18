import { Command } from "commander";
import { cmdInit } from "./commands/init.js";
import { cmdEnqueue } from "./commands/enqueue.js";
import { cmdFleet, cmdRenderStatus } from "./commands/fleet.js";
import { cmdHeartbeat } from "./commands/heartbeat.js";
import {
  cmdSessionNew,
  cmdWorkerDone,
  cmdWorkerSetup,
  cmdWorkerPrompt,
  cmdDispatch,
  cmdWorkerPrimaryWorktree,
  cmdWorkItemSetDeps,
} from "./commands/workitems.js";
import {
  cmdSignalsList,
  cmdSignalTriage,
  cmdCollectGithub,
} from "./commands/signals.js";
import {
  cmdIdeasList,
  cmdIdeaPromote,
  cmdIdeaInsert,
} from "./commands/ideas.js";
import {
  cmdNotify,
  cmdNotifyListUnpushed,
  cmdNotifyMarkPushed,
} from "./commands/notify.js";
import { cmdTick, cmdSessionMarkStale } from "./commands/tick.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdLogAppend } from "./commands/log.js";
import { cmdInbox } from "./commands/inbox.js";
import { cmdInboxServe } from "./commands/inbox-serve.js";
import { cmdPeek } from "./commands/peek.js";
import {
  cmdRecurringList,
  cmdRecurringAdd,
  cmdRecurringDue,
  cmdRecurringMarkRan,
  cmdRecurringSetEnabled,
} from "./commands/recurring.js";
import { cmdGenerateAiNative } from "./commands/generators.js";
import { cmdReviewWeek } from "./commands/review.js";

const program = new Command();
program.name("cos").description("Chief of Staff CLI").version("0.1.0");

program
  .command("init")
  .description("Initialize ~/.claude/cos/ and fleet.db")
  .action(() => cmdInit());

program
  .command("enqueue")
  .description("Add a work item")
  .requiredOption("--title <t>")
  .requiredOption("--description <d>")
  .requiredOption("--acceptance <a>")
  .option("--repos <json>", "JSON array of repo names", "[]")
  .option("--priority <n>", "priority 1-5", "3")
  .option("--source <s>", "source", "user")
  .action((opts) => {
    cmdEnqueue({
      title: opts.title,
      description: opts.description,
      acceptance: opts.acceptance,
      repos: JSON.parse(opts.repos),
      priority: parseInt(opts.priority, 10),
      source: opts.source,
    });
  });

program
  .command("fleet")
  .description("Show fleet status")
  .option("--format <md|json>", "output format", "md")
  .option("--write-status", "also write ~/.claude/cos/status.md", false)
  .action((opts) => cmdFleet(opts.format, opts.writeStatus));

program
  .command("render-status")
  .description("Regenerate ~/.claude/cos/status.md")
  .action(() => cmdRenderStatus());

program
  .command("heartbeat <sessionId>")
  .description("Worker heartbeat")
  .option("--step <s>")
  .action((sessionId, opts) => cmdHeartbeat(sessionId, opts.step));

program
  .command("session-new")
  .description("Create a new session row")
  .option("--work-item <id>")
  .option("--kind <k>", "worker|cron|dialog|meeting-prep", "worker")
  .option("--notes <n>")
  .action((opts) =>
    cmdSessionNew({
      workItemId: opts.workItem,
      kind: opts.kind,
      notes: opts.notes,
    }),
  );

program
  .command("session-mark-stale <sessionId>")
  .description("Mark a session as stale")
  .action((id) => cmdSessionMarkStale(id));

program
  .command("worker-done <sessionId>")
  .description("Worker finished — provide --pr-url or --failed")
  .option("--pr-url <url>")
  .option("--failed <reason>")
  .action((sessionId, opts) =>
    cmdWorkerDone(sessionId, { prUrl: opts.prUrl, failed: opts.failed }),
  );

program
  .command("worker-setup <workItemId>")
  .description("Create worktrees for a work item")
  .action((id) => cmdWorkerSetup(id));

program
  .command("worker-prompt <workItemId>")
  .description("Print the worker prompt for a work item")
  .requiredOption("--session <sessionId>")
  .action((id, opts) => cmdWorkerPrompt(id, opts.session));

program
  .command("worker-primary-worktree <workItemId>")
  .description("Print the primary worktree path for a work item")
  .action((id) => cmdWorkerPrimaryWorktree(id));

program
  .command("dispatch <workItemId>")
  .description("Spawn a worker on a work item")
  .option("--force", "skip auto-dispatch guards", false)
  .action((id, opts) => cmdDispatch(id, { force: opts.force }));

program
  .command("wi-set-deps <workItemId>")
  .description("Add/remove depends_on entries on a work item")
  .option("--add <depId...>", "dep work-item id(s) to add")
  .option("--remove <depId...>", "dep work-item id(s) to remove")
  .action((id, opts) =>
    cmdWorkItemSetDeps(id, { add: opts.add, remove: opts.remove }),
  );

program
  .command("signals")
  .description("List signals")
  .option("--status <s>")
  .option("--source <s>")
  .action((opts) =>
    cmdSignalsList({ status: opts.status, source: opts.source }),
  );

program
  .command("signal-triage <signalId> <action>")
  .description("Triage a signal: suppress | idea | work-item | notify")
  .option("--title <t>")
  .option("--description <d>")
  .option("--priority <n>")
  .option("--repos <json>")
  .option("--acceptance <a>")
  .option("--urgency <u>")
  .option("--body <b>")
  .action((signalId, action, opts) =>
    cmdSignalTriage(signalId, action as any, {
      title: opts.title,
      description: opts.description,
      priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
      repos: opts.repos ? JSON.parse(opts.repos) : undefined,
      acceptance: opts.acceptance,
      urgency: opts.urgency,
      body: opts.body,
    }),
  );

program
  .command("collect-github")
  .description("Run the GitHub signal collector")
  .action(() => cmdCollectGithub());

program
  .command("ideas")
  .description("List ideas")
  .option("--status <s>")
  .action((opts) => cmdIdeasList(opts.status));

program
  .command("idea")
  .description("Add an idea")
  .requiredOption("--title <t>")
  .requiredOption("--description <d>")
  .option("--source <s>")
  .option("--confidence <c>")
  .option("--repos <json>")
  .action((opts) =>
    cmdIdeaInsert({
      title: opts.title,
      description: opts.description,
      source: opts.source,
      confidence: opts.confidence ? parseFloat(opts.confidence) : undefined,
      repos: opts.repos ? JSON.parse(opts.repos) : undefined,
    }),
  );

program
  .command("idea-promote <ideaId>")
  .description("Promote an idea to a work item")
  .requiredOption("--priority <n>")
  .requiredOption("--repos <json>")
  .requiredOption("--acceptance <a>")
  .option("--title <t>")
  .option("--description <d>")
  .action((id, opts) =>
    cmdIdeaPromote(id, {
      priority: parseInt(opts.priority, 10),
      repos: JSON.parse(opts.repos),
      acceptance: opts.acceptance,
      title: opts.title,
      description: opts.description,
    }),
  );

program
  .command("notify")
  .description("Record a notification (written to DB; pushed on next tick)")
  .requiredOption("--subject <s>")
  .option("--body <b>")
  .option("--urgency <u>", "urgent|normal|digest", "normal")
  .option("--related <json>")
  .action((opts) =>
    cmdNotify({
      subject: opts.subject,
      body: opts.body,
      urgency: opts.urgency,
      related: opts.related ? JSON.parse(opts.related) : undefined,
    }),
  );

program
  .command("notify-unpushed")
  .description("List unpushed notifications")
  .action(() => cmdNotifyListUnpushed());

program
  .command("notify-mark-pushed <id>")
  .description("Mark a notification as pushed")
  .action((id) => cmdNotifyMarkPushed(id));

program
  .command("generate-ai-native")
  .description(
    "Generate ideas from ai-native evaluation docs (~/Repos/thegoodparty/ai-native-evaluation-*.md)",
  )
  .action(() => cmdGenerateAiNative());

program
  .command("tick")
  .description("Run one cron tick (invokes claude -p)")
  .option("--dry-run", "print prompt, do not invoke claude", false)
  .action(async (opts) => {
    await cmdTick({ dryRun: opts.dryRun });
  });

program
  .command("doctor")
  .description("Run system health invariants; optionally auto-fix")
  .option(
    "--auto-fix",
    "apply fixes for invariants 1-5, 8-9; always notify on 6-7",
    false,
  )
  .option("--dry-run", "report only; never mutate state", false)
  .option("--format <text|json>", "output format", "text")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "text";
    cmdDoctor({
      autoFix: !!opts.autoFix,
      dryRun: !!opts.dryRun,
      format,
    });
  });

program
  .command("inbox")
  .description(
    "Open the local inbox TUI (live view of fleet.db attention items)",
  )
  .action(() => cmdInbox());

program
  .command("inbox-serve")
  .description("Start the local inbox HTTP server at 127.0.0.1:4411")
  .action(() => cmdInboxServe());

program
  .command("peek")
  .description("Attach to the cos-workers tmux session (or list its windows)")
  .option("--list", "list windows in the session instead of attaching", false)
  .action((opts) => cmdPeek({ list: opts.list }));

const recurringCmd = program
  .command("recurring")
  .description("Manage recurring tasks (tick-driven)");

recurringCmd
  .command("list")
  .description("List recurring tasks")
  .option("--enabled", "only enabled")
  .option("--disabled", "only disabled")
  .action((opts) => {
    const enabled = opts.enabled ? true : opts.disabled ? false : undefined;
    cmdRecurringList({ enabled });
  });

recurringCmd
  .command("add")
  .description("Add a recurring task")
  .requiredOption("--id <id>", "must start with 'rec-'")
  .requiredOption("--title <t>")
  .requiredOption("--hours <n>", "cadence in hours")
  .requiredOption(
    "--prompt-file <path>",
    "absolute or relative to ~/.claude/cos/",
  )
  .option("--start-at <iso>", "first due time (default: now)")
  .action((opts) => {
    cmdRecurringAdd({
      id: opts.id,
      title: opts.title,
      hours: parseInt(opts.hours, 10),
      promptFile: opts.promptFile,
      startAt: opts.startAt,
    });
  });

recurringCmd
  .command("due")
  .description("List tasks that are due now")
  .option("--format <text|json>", "output format", "text")
  .action((opts) => cmdRecurringDue({ format: opts.format }));

recurringCmd
  .command("mark-ran <id>")
  .description("Record that a recurring task ran; reschedules next_run_at")
  .option("--status <ok|failed>", "run outcome", "ok")
  .option("--notes <s>", "short summary")
  .action((id, opts) =>
    cmdRecurringMarkRan(id, { status: opts.status, notes: opts.notes }),
  );

recurringCmd
  .command("enable <id>")
  .description("Enable a recurring task")
  .action((id) => cmdRecurringSetEnabled(id, true));

recurringCmd
  .command("disable <id>")
  .description("Disable a recurring task")
  .action((id) => cmdRecurringSetEnabled(id, false));

program
  .command("review-week")
  .description(
    "Generate the weekly review digest (writes to ~/.claude/cos/reviews/YYYY-WW.md and queues a notification)",
  )
  .option("--no-notify", "skip queuing a notification")
  .option("--stdout", "print to stdout; do not write file or notify", false)
  .action((opts) =>
    cmdReviewWeek({ notify: opts.notify, stdout: !!opts.stdout }),
  );

program
  .command("log-append <text>")
  .description(
    "Append an entry to decisions.log with an ISO timestamp. Use '-' as <text> to read from stdin.",
  )
  .option("--tick-id <id>", "include tick id in the entry header")
  .action((text, opts) => cmdLogAppend(text, { tickId: opts.tickId }));

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
