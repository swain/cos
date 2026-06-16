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
  cmdWorkerDisplayId,
  cmdWorkerWindowName,
  cmdWorkItemAbandon,
  cmdWorkItemSetDeps,
} from "./commands/workitems.js";
import {
  cmdSignalsList,
  cmdSignalTriage,
  cmdSignalAdd,
  cmdCollectGithub,
  cmdCollectCalendar,
  cmdCollectClickup,
  cmdCollectSlack,
  cmdCollectSentry,
} from "./commands/signals.js";
import {
  cmdIdeasList,
  cmdIdeaPromote,
  cmdIdeaInsert,
} from "./commands/ideas.js";
import { cmdGenerateIdeasDiff } from "./commands/generate-ideas.js";
import { cmdIdeaTriage } from "./generators/idea-triage.js";
import {
  cmdNotify,
  cmdNotifyListUnpushed,
  cmdNotifyMarkPushed,
  cmdNotifyPush,
} from "./commands/notify.js";
import { cmdTick, cmdSessionMarkStale } from "./commands/tick.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdLogAppend } from "./commands/log.js";
import { cmdInbox } from "./commands/inbox.js";
import { cmdInboxServe } from "./commands/inbox-serve.js";
import { cmdDashboard } from "./commands/dashboard.js";
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
import { cmdReviewPr } from "./commands/review-pr.js";
import {
  cmdFollowupInsert,
  cmdFollowupList,
  cmdFollowupMarkRaised,
  cmdFollowupMarkAddressed,
} from "./commands/followups.js";
import { cmdPlan } from "./commands/plan.js";
import {
  cmdPlanApprove,
  cmdPlanResubmit,
  cmdPlanReview,
  cmdPlanStatus,
  cmdPlanSubmit,
  cmdPlanSupersede,
} from "./commands/plans.js";
import {
  cmdCommitmentsList,
  cmdCommitmentsAdd,
  cmdCommitmentsDone,
} from "./commands/commitments.js";

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
  .option(
    "--needs-planning",
    "flag as needing decomposition via `cos plan`",
    false,
  )
  .option("--parent-id <id>", "link as a child of another work item")
  .action((opts) => {
    cmdEnqueue({
      title: opts.title,
      description: opts.description,
      acceptance: opts.acceptance,
      repos: JSON.parse(opts.repos),
      priority: parseInt(opts.priority, 10),
      source: opts.source,
      needsPlanning: !!opts.needsPlanning,
      parentId: opts.parentId ?? null,
    });
  });

program
  .command("fleet")
  .description("Show fleet status")
  .option("--format <table|md|json>", "output format", "table")
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
  .command("work-item-display-id <workItemId>")
  .description("Print the human-friendly wi-<num>-<slug> id for a work item")
  .action((id) => cmdWorkerDisplayId(id));

program
  .command("worker-window-name <workItemId>")
  .description(
    "Print the tmux window name for a work item (used by spawn-worker)",
  )
  .action((id) => cmdWorkerWindowName(id));

program
  .command("dispatch <workItemId>")
  .description("Spawn a worker on a work item")
  .option("--force", "skip auto-dispatch guards", false)
  .action((id, opts) => cmdDispatch(id, { force: opts.force }));

program
  .command("plan <workItemId>")
  .description(
    "Decompose a needs_planning work item into child chunks via a planning subagent",
  )
  .option("--dry-run", "print the planner prompt and exit", false)
  .option("--replan", "re-plan even if children already exist", false)
  .option(
    "--from-file <path>",
    "skip claude and read the planner JSON from this file (for testing)",
  )
  .action((id, opts) =>
    cmdPlan(id, {
      dryRun: !!opts.dryRun,
      replan: !!opts.replan,
      fromFile: opts.fromFile,
    }),
  );

program
  .command("plan-submit <workItemId>")
  .description(
    "Persist a written plan markdown and queue it for user review in the inbox",
  )
  .requiredOption("--path <path>", "absolute path to the plan .md file")
  .action((id, opts) => cmdPlanSubmit(id, { path: opts.path }));

program
  .command("plan-status <planId>")
  .description("Print the plan row as JSON")
  .action((id) => cmdPlanStatus(id));

program
  .command("plan-approve <planId>")
  .description(
    "Mark a plan approved and redispatch its work item (worker runs against the approved plan)",
  )
  .action(async (id) => {
    await cmdPlanApprove(id);
  });

program
  .command("plan-resubmit <planId>")
  .description(
    "Record reviewer feedback on a plan and spawn a re-plan worker that regenerates with feedback in context",
  )
  .option("--feedback <body>", "feedback/comment bundle (markdown)", "")
  .action((id, opts) => cmdPlanResubmit(id, { feedback: opts.feedback }));

program
  .command("plan-review <planId>")
  .description(
    "Interactive plan review: open plannotator on the plan markdown, then approve / send feedback / skip",
  )
  .action(async (id) => {
    await cmdPlanReview(id);
  });

program
  .command("plan-supersede <planId>")
  .description("Mark a plan superseded (dashboard Dismiss / doctor age-out)")
  .option("--note <note>", "short reason (appended to plan markdown)")
  .action((id, opts) => cmdPlanSupersede(id, opts.note));

program
  .command("wi-abandon <workItemRef>")
  .description(
    "Mark a work item abandoned (CLI equivalent of the dashboard Archive/Abandon button)",
  )
  .action((ref) => cmdWorkItemAbandon(ref));

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
  .command("signal-add")
  .description("Insert a signal (deduped on source+kind+external-id)")
  .requiredOption("--source <s>")
  .requiredOption("--kind <k>")
  .option("--external-id <id>")
  .option("--payload <json>", "JSON payload", "{}")
  .action((opts) => {
    cmdSignalAdd({
      source: opts.source,
      kind: opts.kind,
      externalId: opts.externalId,
      payload: opts.payload ? JSON.parse(opts.payload) : {},
    });
  });

program
  .command("collect-github")
  .description("Run the GitHub signal collector")
  .action(() => cmdCollectGithub());

program
  .command("collect-calendar")
  .description(
    "Run the Google Calendar collector (spawns claude -p with MCP tools)",
  )
  .option("--timeout-ms <n>", "subprocess timeout in milliseconds", "180000")
  .option(
    "--event-id <id>",
    "prepare a single named event (bypasses the default 15–45 min window filter)",
  )
  .action((opts) =>
    cmdCollectCalendar({
      timeoutMs: parseInt(opts.timeoutMs, 10),
      eventId: opts.eventId,
    }),
  );

program
  .command("collect-clickup")
  .description("Run the ClickUp signal collector")
  .action(() => cmdCollectClickup());

program
  .command("collect-slack")
  .description("Run the Slack signal collector (DMs + @-mentions via MCP)")
  .action(() => cmdCollectSlack());

program
  .command("collect-sentry")
  .description("Run the Sentry signal collector")
  .option("--dry-run", "print what would be emitted without inserting", false)
  .action((opts) => cmdCollectSentry({ dryRun: !!opts.dryRun }));

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
  .command("generate-ideas-diff")
  .description(
    "Scan the last 7d of merged PRs across watched repos for follow-up ideas (TODOs, console.logs, large files)",
  )
  .option("--dry-run", "print candidates without inserting", false)
  .option("--since <yyyy-mm-dd>", "override the 7-day lookback")
  .option("--pr-limit <n>", "max PRs per repo to scan", "30")
  .option("--verbose", "print per-repo progress", false)
  .action((opts) =>
    cmdGenerateIdeasDiff({
      dryRun: !!opts.dryRun,
      since: opts.since,
      prLimit: opts.prLimit ? parseInt(opts.prLimit, 10) : undefined,
      verbose: !!opts.verbose,
    }),
  );

program
  .command("idea-triage")
  .description(
    "Score untriaged ideas against priorities / arch / queue via claude -p. Bounded by --limit (default 25).",
  )
  .option("--limit <n>", "max ideas to triage in this pass", "25")
  .option(
    "--from-file <path>",
    "skip claude and read triage JSON from this file (for testing)",
  )
  .option("--dry-run", "print the triage prompt and exit", false)
  .action((opts) =>
    cmdIdeaTriage({
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      fromFile: opts.fromFile,
      dryRun: !!opts.dryRun,
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
  .command("notify-push <id>")
  .description(
    "Push a notification via macOS osascript (marks pushed on success)",
  )
  .option("--dry-run", "print the osascript command without running it", false)
  .action((id, opts) => cmdNotifyPush(id, { dryRun: !!opts.dryRun }));

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
  .command("dashboard")
  .description(
    "Open the inbox web UI (http://127.0.0.1:4411) in the default browser; kickstart the launchd job if stopped",
  )
  .action(() => cmdDashboard());

program
  .command("peek [target]")
  .description(
    "Default: print a summary table of active workers. With <target> (sess/wi prefix or window number), tail that worker's log. Use --attach for the old tmux behavior.",
  )
  .option("--attach", "attach the cos-workers tmux session", false)
  .option("--tmux", "alias for --attach", false)
  .option(
    "--list",
    "list windows in the tmux session instead of attaching",
    false,
  )
  .option("-n, --lines <n>", "lines of log to tail when given a target", "35")
  .action((target, opts) =>
    cmdPeek(target, {
      attach: opts.attach || opts.tmux,
      list: opts.list,
      lines: parseInt(opts.lines, 10),
    }),
  );

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

const commitments = program
  .command("commitments")
  .description("Commitments ledger (who promised what, by when)");
commitments
  .command("list")
  .option("--due <filter>", "today | overdue | all", "all")
  .option("--format <fmt>", "text | json", "text")
  .action((o) => cmdCommitmentsList({ due: o.due, format: o.format }));
commitments
  .command("add")
  .requiredOption("--who <who>")
  .requiredOption("--what <what>")
  .option("--due <yyyy-mm-dd>")
  .option("--source <src>")
  .action((o) =>
    cmdCommitmentsAdd({
      who: o.who,
      what: o.what,
      due: o.due,
      source: o.source,
    }),
  );
commitments.command("done <id>").action((id) => cmdCommitmentsDone(id));

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
  .command("review <prUrls...>")
  .description(
    "Review PR(s) in plannotator, then mirror the decision to GitHub via gh pr review",
  )
  .action((prUrls: string[]) => cmdReviewPr(prUrls));

program
  .command("log-append <text>")
  .description(
    "Append an entry to decisions.log with an ISO timestamp. Use '-' as <text> to read from stdin.",
  )
  .option("--tick-id <id>", "include tick id in the entry header")
  .action((text, opts) => cmdLogAppend(text, { tickId: opts.tickId }));

program
  .command("followup")
  .description(
    "Record a dialog-mode followup to raise with me at the right moment",
  )
  .requiredOption("--topic <t>", "short topic label")
  .requiredOption(
    "--trigger <t>",
    "next-dialog | before-meeting:<name> | before-workitem:<wi-id> | after-date:<iso>",
  )
  .option("--context <c>", "why this matters / what to press on", "")
  .action((opts) =>
    cmdFollowupInsert({
      topic: opts.topic,
      context: opts.context,
      trigger: opts.trigger,
    }),
  );

program
  .command("followups")
  .description("List followups")
  .option("--status <s>", "filter by status (open|raised|addressed|dropped)")
  .action((opts) => cmdFollowupList(opts.status));

program
  .command("followup-mark-raised <id>")
  .description("Mark a followup as raised (surfaced in dialog)")
  .action((id) => cmdFollowupMarkRaised(id));

program
  .command("followup-mark-addressed <id>")
  .description("Mark a followup as addressed (dialog complete)")
  .action((id) => cmdFollowupMarkAddressed(id));

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
