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
  .command("tick")
  .description("Run one cron tick (invokes claude -p)")
  .option("--dry-run", "print prompt, do not invoke claude", false)
  .action(async (opts) => {
    await cmdTick({ dryRun: opts.dryRun });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
