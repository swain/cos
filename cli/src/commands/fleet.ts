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
import {
  CONFIG_JSON,
  STATUS_MD,
  displayWorkItemId,
  nowIso,
  parseJson,
} from "../util.js";
import type { WorkItem } from "../types.js";

const DEFAULT_STALE_HEARTBEAT_MINUTES = 20;
const ID_COL_WIDTH = 26;
const PR_COL_WIDTH = 42;
const DEFAULT_TERM_WIDTH = 120;

const readStaleHeartbeatMinutes = (): number => {
  if (!existsSync(CONFIG_JSON)) return DEFAULT_STALE_HEARTBEAT_MINUTES;
  const cfg = parseJson<{ stale_heartbeat_minutes?: number }>(
    readFileSync(CONFIG_JSON, "utf8"),
    {},
  );
  const m = cfg.stale_heartbeat_minutes;
  return typeof m === "number" && m > 0 ? m : DEFAULT_STALE_HEARTBEAT_MINUTES;
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI_RE, "").length;
const padVisible = (s: string, width: number) =>
  s + " ".repeat(Math.max(0, width - visibleLen(s)));
const truncate = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";

const formatHbAge = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

const priorityBadge = (p: number): string => {
  if (p <= 1) return chalk.red.bold(`${p}`);
  if (p === 2) return chalk.yellow(`${p}`);
  if (p === 3) return chalk.cyan(`${p}`);
  return chalk.gray(`${p}`);
};

const statusColor = (status: string): string => {
  switch (status) {
    case "in-progress":
      return chalk.green(status);
    case "pr-open":
      return chalk.cyan(status);
    case "blocked":
      return chalk.red(status);
    case "queued":
      return chalk.gray(status);
    default:
      return status;
  }
};

const sessionStatusColor = (status: string): string => {
  switch (status) {
    case "running":
      return chalk.green(status);
    case "starting":
    case "idle":
      return chalk.cyan(status);
    case "stale":
      return chalk.red(status);
    case "failed":
      return chalk.red(status);
    default:
      return status;
  }
};

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
    `- \`${displayWorkItemId(wi)}\` **P${wi.priority}** ${wi.title} _[${wi.repos.join(", ") || "—"}]_`;

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

  const lookupWi = (work_item_id: string | null) =>
    work_item_id ? workItems.get(work_item_id) : null;
  const wiLabel = (work_item_id: string | null): string => {
    const wi = lookupWi(work_item_id);
    return wi ? displayWorkItemId(wi) : "—";
  };
  const titleFor = (work_item_id: string | null): string =>
    lookupWi(work_item_id)?.title ?? "—";

  if (f.active_sessions.length) {
    lines.push("## Active sessions");
    lines.push("");
    for (const s of f.active_sessions) {
      lines.push(
        `- \`${s.id}\` **${titleFor(s.work_item_id)}** (wi=${wiLabel(s.work_item_id)}) kind=${s.kind} step=${s.current_step ?? "—"} hb=${s.last_heartbeat}`,
      );
    }
    lines.push("");
  }

  if (f.stale_sessions.length) {
    lines.push("## Stale sessions (need attention)");
    lines.push("");
    f.stale_sessions.forEach((s) =>
      lines.push(
        `- \`${s.id}\` **${titleFor(s.work_item_id)}** (wi=${wiLabel(s.work_item_id)}) last=${s.last_heartbeat}`,
      ),
    );
    lines.push("");
  }

  return lines.join("\n") + "\n";
};

type FleetTableOptions = {
  termWidth?: number;
  staleMinutes?: number;
};

export const renderFleetTable = (
  f: FleetSummary,
  opts: FleetTableOptions = {},
): string => {
  const termWidth =
    opts.termWidth ?? process.stdout.columns ?? DEFAULT_TERM_WIDTH;
  const staleMinutes = opts.staleMinutes ?? readStaleHeartbeatMinutes();
  const lines: string[] = [];

  lines.push(chalk.bold(`COS Fleet`) + chalk.gray(`  ${nowIso()}`));
  lines.push(`Queued:          ${f.queued.length}`);
  lines.push(`In progress:     ${f.in_progress.length}`);
  lines.push(`PR open:         ${f.pr_open.length}`);
  lines.push(`Blocked:         ${f.blocked.length}`);
  lines.push(
    `Active sessions: ${f.active_sessions.length} (last ${f.session_window_hours}h)`,
  );
  lines.push(
    `Stale sessions:  ${f.stale_sessions.length} (last ${f.session_window_hours}h)`,
  );
  lines.push(`New signals:     ${f.new_signals_count}`);
  lines.push(`New ideas:       ${f.new_ideas_count}`);
  lines.push(`Unpushed notes:  ${f.recent_notifications.length}`);
  if (f.current_tick) {
    const ageMin = minutesSinceSqliteTs(f.current_tick.started_at);
    const stale = ageMin >= STALE_TICK_MINUTES;
    const staleHint = stale
      ? chalk.red(
          ` (looks stale — last completed ${f.last_tick_at ?? "never"})`,
        )
      : "";
    lines.push(
      `Cron tick:       in progress, started ${ageMin}m ago${staleHint}`,
    );
  } else {
    lines.push(`Last cron tick:  ${f.last_tick_at ?? "never"}`);
  }
  lines.push("");

  const allWIs: Array<EnrichedWorkItem & { _group: string }> = [
    ...f.in_progress.map((wi) => ({ ...wi, _group: "in-progress" })),
    ...f.pr_open.map((wi) => ({ ...wi, _group: "pr-open" })),
    ...f.blocked.map((wi) => ({ ...wi, _group: "blocked" })),
    ...f.queued.map((wi) => ({ ...wi, _group: "queued" })),
  ];

  if (allWIs.length) {
    lines.push(chalk.bold(`WORK ITEMS (${allWIs.length})`));
    const headerCols = [
      padVisible("ID", ID_COL_WIDTH),
      padVisible("P", 2),
      padVisible("STATUS", 12),
      padVisible("STEP", 14),
      padVisible("HB", 6),
      "TITLE",
    ];
    const fixedWidth = ID_COL_WIDTH + 2 + 12 + 14 + 6 + 5 * 2;
    const titleWidth = Math.max(20, termWidth - fixedWidth);
    lines.push(chalk.dim(headerCols.join("  ")));
    for (const wi of allWIs) {
      const id = truncate(displayWorkItemId(wi), ID_COL_WIDTH);
      const stepText = truncate(wi.active_step?.step ?? "—", 14);
      const stepCell =
        wi._group === "in-progress" && wi.active_step?.step
          ? chalk.green(stepText)
          : stepText;
      let hbCell = "—";
      if (wi.active_step) {
        const ageMin = minutesSinceSqliteTs(wi.active_step.heartbeat);
        const label = formatHbAge(ageMin);
        hbCell = ageMin >= staleMinutes ? chalk.red(label) : label;
      }
      lines.push(
        [
          padVisible(id, ID_COL_WIDTH),
          padVisible(priorityBadge(wi.priority), 2),
          padVisible(statusColor(wi._group), 12),
          padVisible(stepCell, 14),
          padVisible(hbCell, 6),
          truncate(wi.title, titleWidth),
        ].join("  "),
      );
    }
    lines.push("");
  }

  if (f.pr_open.length) {
    lines.push(chalk.bold(`PRS AWAITING REVIEW (${f.pr_open.length})`));
    const headerCols = [
      padVisible("WI", ID_COL_WIDTH),
      padVisible("PR", PR_COL_WIDTH),
      padVisible("P", 2),
      "TITLE",
    ];
    const fixedWidth = ID_COL_WIDTH + PR_COL_WIDTH + 2 + 3 * 2;
    const titleWidth = Math.max(20, termWidth - fixedWidth);
    lines.push(chalk.dim(headerCols.join("  ")));
    for (const wi of f.pr_open) {
      const prRaw = wi.pr_urls[0] ?? "—";
      const prShort = prRaw
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\/pull\//, "#");
      lines.push(
        [
          padVisible(
            truncate(displayWorkItemId(wi), ID_COL_WIDTH),
            ID_COL_WIDTH,
          ),
          padVisible(truncate(prShort, PR_COL_WIDTH), PR_COL_WIDTH),
          padVisible(priorityBadge(wi.priority), 2),
          truncate(wi.title, titleWidth),
        ].join("  "),
      );
      for (const extra of wi.pr_urls.slice(1)) {
        const extraShort = extra
          .replace(/^https?:\/\/github\.com\//, "")
          .replace(/\/pull\//, "#");
        lines.push(`  ${chalk.gray(extraShort)}`);
      }
    }
    lines.push("");
  }

  const allSessions = [...f.active_sessions, ...f.stale_sessions];
  if (allSessions.length) {
    const activeCount = f.active_sessions.length;
    lines.push(
      chalk.bold(
        `SESSIONS (last ${f.session_window_hours}h, active=${activeCount})`,
      ),
    );
    const headerCols = [
      padVisible("SESSION", ID_COL_WIDTH),
      padVisible("WI", ID_COL_WIDTH),
      padVisible("KIND", 7),
      padVisible("STEP", 14),
      padVisible("HB", 6),
      "STATUS",
    ];
    lines.push(chalk.dim(headerCols.join("  ")));
    const lookupWi = (id: string | null) => (id ? workItems.get(id) : null);
    for (const s of allSessions) {
      const wi = lookupWi(s.work_item_id);
      const wiLabel = wi ? displayWorkItemId(wi) : (s.work_item_id ?? "—");
      const ageMin = minutesSinceSqliteTs(s.last_heartbeat);
      const hbLabel = formatHbAge(ageMin);
      const hbCell = ageMin >= staleMinutes ? chalk.red(hbLabel) : hbLabel;
      const stepText = truncate(s.current_step ?? "—", 14);
      const stepCell =
        s.status === "running" && s.current_step
          ? chalk.green(stepText)
          : stepText;
      lines.push(
        [
          padVisible(truncate(s.id, ID_COL_WIDTH), ID_COL_WIDTH),
          padVisible(truncate(wiLabel, ID_COL_WIDTH), ID_COL_WIDTH),
          padVisible(truncate(s.kind, 7), 7),
          padVisible(stepCell, 14),
          padVisible(hbCell, 6),
          sessionStatusColor(s.status),
        ].join("  "),
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

export const cmdFleet = (
  format: "table" | "md" | "json" = "table",
  writeStatus = false,
) => {
  const f = collectFleet();
  if (format === "json") {
    console.log(JSON.stringify(f, null, 2));
  } else if (format === "md") {
    const md = renderFleetMarkdown(f);
    console.log(md);
    if (writeStatus) {
      writeFileSync(STATUS_MD, md);
      console.error(chalk.gray(`wrote ${STATUS_MD}`));
    }
  } else {
    console.log(renderFleetTable(f));
    if (writeStatus) {
      const md = renderFleetMarkdown(f);
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
