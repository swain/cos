import { writeFileSync, readFileSync, existsSync } from "node:fs";
import chalk from "chalk";
import {
  workItems,
  sessions,
  notifications,
  ideas,
  signals,
  cosLog,
  cronTicks,
} from "../db.js";
import { CONFIG_JSON, STATUS_MD, nowIso, parseJson } from "../util.js";
import type { WorkItem } from "../types.js";

// Threshold above which an in-progress cron tick is treated as potentially
// wedged. Typical ticks complete in ~1–5m; doctor-invoked claude -p can push
// it past 15m. Anything older than this likely means launchd lost the child
// or claude hung — surface a "looks stale" hint so the user notices.
export const STALE_TICK_MINUTES = 20;

const DEFAULT_SESSION_WINDOW_HOURS = 24;

const readSessionWindowHours = (): number => {
  if (!existsSync(CONFIG_JSON)) return DEFAULT_SESSION_WINDOW_HOURS;
  const cfg = parseJson<{ fleet_session_window_hours?: number }>(
    readFileSync(CONFIG_JSON, "utf8"),
    {},
  );
  const hours = cfg.fleet_session_window_hours;
  return typeof hours === "number" && hours > 0
    ? hours
    : DEFAULT_SESSION_WINDOW_HOURS;
};

export type LastFailure = {
  reason: string;
  session_id: string;
  at: string | null;
};

export type ActiveStep = {
  session_id: string;
  step: string | null;
  heartbeat: string;
};

export type EnrichedWorkItem = WorkItem & {
  last_failure?: LastFailure;
  active_step?: ActiveStep;
};

export type CurrentTick = {
  id: string;
  started_at: string;
};

export type FleetSummary = {
  queued: EnrichedWorkItem[];
  in_progress: EnrichedWorkItem[];
  pr_open: EnrichedWorkItem[];
  blocked: EnrichedWorkItem[];
  active_sessions: ReturnType<typeof sessions.list>;
  stale_sessions: ReturnType<typeof sessions.list>;
  new_signals_count: number;
  new_ideas_count: number;
  recent_notifications: ReturnType<typeof notifications.listUnpushed>;
  last_tick_at: string | null;
  current_tick: CurrentTick | null;
  session_window_hours: number;
};

const enrichBlocked = (wi: WorkItem): EnrichedWorkItem => {
  const s = sessions.latestForWorkItem(wi.id, "failed");
  if (!s || !s.notes) return wi;
  return {
    ...wi,
    last_failure: {
      reason: s.notes,
      session_id: s.id,
      at: s.ended_at,
    },
  };
};

const enrichInProgress = (wi: WorkItem): EnrichedWorkItem => {
  const s = sessions.latestForWorkItem(wi.id);
  if (!s) return wi;
  return {
    ...wi,
    active_step: {
      session_id: s.id,
      step: s.current_step,
      heartbeat: s.last_heartbeat,
    },
  };
};

export const collectFleet = (): FleetSummary => {
  const queued = workItems.list({ status: "queued" });
  const in_progress = workItems
    .list({ status: "in-progress" })
    .map(enrichInProgress);
  const pr_open = workItems.list({ status: "pr-open" });
  const blocked = workItems.list({ status: "blocked" }).map(enrichBlocked);
  const windowHours = readSessionWindowHours();
  const startedSince = new Date(
    Date.now() - windowHours * 3600_000,
  ).toISOString();
  const all_active = [
    ...sessions.list({ status: "running", startedSince }),
    ...sessions.list({ status: "starting", startedSince }),
    ...sessions.list({ status: "idle", startedSince }),
  ];
  const stale = sessions.list({ status: "stale", startedSince });
  const new_signals = signals.list({ status: "new" });
  const new_ideas = ideas.list({ status: "new" });
  const recentLogs = cosLog.recent(1);
  const active = cronTicks.current();
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
    current_tick: active
      ? { id: active.id, started_at: active.started_at }
      : null,
    session_window_hours: windowHours,
  };
};

const minutesSinceSqliteTs = (ts: string): number => {
  // SQLite's datetime('now') returns a UTC string without the Z suffix.
  // new Date() on that treats it as local; append Z so it's parsed as UTC.
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const withZ = iso.endsWith("Z") ? iso : `${iso}Z`;
  const t = new Date(withZ).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
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
  lines.push(
    `- Active sessions (last ${f.session_window_hours}h): **${f.active_sessions.length}**`,
  );
  lines.push(
    `- Stale sessions (last ${f.session_window_hours}h): **${f.stale_sessions.length}**`,
  );
  lines.push(`- New signals: **${f.new_signals_count}**`);
  lines.push(`- New ideas: **${f.new_ideas_count}**`);
  lines.push(`- Unpushed notifications: **${f.recent_notifications.length}**`);
  if (f.current_tick) {
    const ageMin = minutesSinceSqliteTs(f.current_tick.started_at);
    const staleHint =
      ageMin >= STALE_TICK_MINUTES
        ? ` (looks stale — last completed ${f.last_tick_at ?? "_never_"})`
        : "";
    lines.push(
      `- Cron tick in progress: started ${ageMin}m ago, \`${f.current_tick.id}\`${staleHint}`,
    );
  } else {
    lines.push(`- Last cron tick: ${f.last_tick_at ?? "_never_"}`);
  }
  lines.push("");

  const fmtWI = (wi: EnrichedWorkItem) =>
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
    for (const wi of f.in_progress) {
      lines.push(fmtWI(wi));
      if (wi.active_step) {
        lines.push(
          `  - step: \`${wi.active_step.step ?? "—"}\` (hb: ${wi.active_step.heartbeat}, sess \`${wi.active_step.session_id}\`)`,
        );
      }
    }
    lines.push("");
  }

  if (f.blocked.length) {
    lines.push("## Blocked");
    lines.push("");
    for (const wi of f.blocked) {
      lines.push(fmtWI(wi));
      if (wi.last_failure) {
        lines.push(`  - failed: ${wi.last_failure.reason}`);
        lines.push(
          `  - session: \`${wi.last_failure.session_id}\` at ${wi.last_failure.at ?? "—"}`,
        );
      }
    }
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
