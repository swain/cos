import { writeFileSync } from "node:fs";
import chalk from "chalk";
import {
  workItems,
  sessions,
  notifications,
  ideas,
  signals,
  cosLog,
} from "../db.js";
import { STATUS_MD, nowIso } from "../util.js";

export type FleetSummary = {
  queued: ReturnType<typeof workItems.list>;
  in_progress: ReturnType<typeof workItems.list>;
  pr_open: ReturnType<typeof workItems.list>;
  blocked: ReturnType<typeof workItems.list>;
  active_sessions: ReturnType<typeof sessions.list>;
  stale_sessions: ReturnType<typeof sessions.list>;
  new_signals_count: number;
  new_ideas_count: number;
  recent_notifications: ReturnType<typeof notifications.listUnpushed>;
  last_tick_at: string | null;
};

export const collectFleet = (): FleetSummary => {
  const queued = workItems.list({ status: "queued" });
  const in_progress = workItems.list({ status: "in-progress" });
  const pr_open = workItems.list({ status: "pr-open" });
  const blocked = workItems.list({ status: "blocked" });
  const all_active = [
    ...sessions.list({ status: "running" }),
    ...sessions.list({ status: "starting" }),
    ...sessions.list({ status: "idle" }),
  ];
  const stale = sessions.list({ status: "stale" });
  const new_signals = signals.list({ status: "new" });
  const new_ideas = ideas.list({ status: "new" });
  const recentLogs = cosLog.recent(1);
  return {
    queued,
    in_progress,
    pr_open,
    blocked,
    active_sessions: all_active,
    stale_sessions: stale,
    new_signals_count: new_signals.length,
    new_ideas_count: new_ideas.length,
    recent_notifications: notifications.listUnpushed(),
    last_tick_at: recentLogs[0]?.tick_at ?? null,
  };
};

export const renderFleetMarkdown = (f: FleetSummary): string => {
  const lines: string[] = [];
  lines.push(`# COS Status`);
  lines.push("");
  lines.push(`_Generated ${nowIso()}_`);
  lines.push("");
  lines.push(`- Queued: **${f.queued.length}**`);
  lines.push(`- In progress: **${f.in_progress.length}**`);
  lines.push(`- PR open (awaiting review): **${f.pr_open.length}**`);
  lines.push(`- Blocked: **${f.blocked.length}**`);
  lines.push(`- Active sessions: **${f.active_sessions.length}**`);
  lines.push(`- Stale sessions: **${f.stale_sessions.length}**`);
  lines.push(`- New signals: **${f.new_signals_count}**`);
  lines.push(`- New ideas: **${f.new_ideas_count}**`);
  lines.push(`- Unpushed notifications: **${f.recent_notifications.length}**`);
  lines.push(`- Last cron tick: ${f.last_tick_at ?? "_never_"}`);
  lines.push("");

  const fmtWI = (wi: (typeof f.queued)[number]) =>
    `- \`${wi.id}\` **P${wi.priority}** ${wi.title} _[${wi.repos.join(", ") || "—"}]_`;

  if (f.pr_open.length) {
    lines.push("## PRs awaiting review");
    lines.push("");
    for (const wi of f.pr_open) {
      lines.push(fmtWI(wi));
      for (const u of wi.pr_urls) lines.push(`  - ${u}`);
    }
    lines.push("");
  }

  if (f.in_progress.length) {
    lines.push("## In progress");
    lines.push("");
    f.in_progress.forEach((wi) => lines.push(fmtWI(wi)));
    lines.push("");
  }

  if (f.blocked.length) {
    lines.push("## Blocked");
    lines.push("");
    f.blocked.forEach((wi) => lines.push(fmtWI(wi)));
    lines.push("");
  }

  if (f.queued.length) {
    lines.push("## Queued");
    lines.push("");
    f.queued.slice(0, 20).forEach((wi) => lines.push(fmtWI(wi)));
    if (f.queued.length > 20)
      lines.push(`- _…and ${f.queued.length - 20} more_`);
    lines.push("");
  }

  const titleFor = (work_item_id: string | null): string => {
    if (!work_item_id) return "—";
    return workItems.get(work_item_id)?.title ?? "—";
  };

  if (f.active_sessions.length) {
    lines.push("## Active sessions");
    lines.push("");
    for (const s of f.active_sessions) {
      lines.push(
        `- \`${s.id}\` **${titleFor(s.work_item_id)}** (wi=${s.work_item_id ?? "—"}) kind=${s.kind} step=${s.current_step ?? "—"} hb=${s.last_heartbeat}`,
      );
    }
    lines.push("");
  }

  if (f.stale_sessions.length) {
    lines.push("## Stale sessions (need attention)");
    lines.push("");
    f.stale_sessions.forEach((s) =>
      lines.push(
        `- \`${s.id}\` **${titleFor(s.work_item_id)}** (wi=${s.work_item_id ?? "—"}) last=${s.last_heartbeat}`,
      ),
    );
    lines.push("");
  }

  return lines.join("\n") + "\n";
};

export const cmdFleet = (format: "md" | "json" = "md", writeStatus = false) => {
  const f = collectFleet();
  if (format === "json") {
    console.log(JSON.stringify(f, null, 2));
  } else {
    const md = renderFleetMarkdown(f);
    console.log(md);
    if (writeStatus) {
      writeFileSync(STATUS_MD, md);
      console.error(chalk.gray(`wrote ${STATUS_MD}`));
    }
  }
};

export const cmdRenderStatus = () => {
  const f = collectFleet();
  writeFileSync(STATUS_MD, renderFleetMarkdown(f));
  console.log(chalk.gray(`wrote ${STATUS_MD}`));
};
