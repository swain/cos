import { ulid } from "ulid";
import chalk from "chalk";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  workItems,
  sessions as sessionsApi,
  cosLog,
  notifications,
} from "../db.js";
import { CONFIG_JSON, LOGS_DIR, nowIso, parseJson } from "../util.js";
import type { Session } from "../types.js";

const TMUX_SESSION = "cos-workers";
const DEFAULT_STALE_MINUTES = 20;
const SILENT_WORKER_MINUTES = 5;
const CIRCUIT_BREAKER_MINUTES = 15;

type Severity = "info" | "warn" | "error";

type DoctorEntry = {
  id?: string;
  reason: string;
  details?: Record<string, unknown>;
};

type DoctorFix = {
  id?: string;
  action: string;
  details?: Record<string, unknown>;
};

type DoctorFinding = {
  invariant: string;
  severity: Severity;
  ok: boolean;
  entries: DoctorEntry[];
  fixed: DoctorFix[];
  notified: string[];
};

export type DoctorReport = {
  ran_at: string;
  auto_fix: boolean;
  dry_run: boolean;
  findings: DoctorFinding[];
  summary: {
    checked: number;
    issues: number;
    fixed: number;
    notified: number;
  };
};

export type DoctorOptions = {
  autoFix: boolean;
  dryRun: boolean;
  format: "text" | "json";
};

const emptyFinding = (
  invariant: string,
  severity: Severity = "warn",
): DoctorFinding => ({
  invariant,
  severity,
  ok: true,
  entries: [],
  fixed: [],
  notified: [],
});

const minutesSince = (iso: string): number =>
  (Date.now() - new Date(iso).getTime()) / 60_000;

const readConfig = (): {
  dispatch_paused?: boolean;
  stale_heartbeat_minutes?: number;
  auto_dispatch_max_priority?: number;
  [k: string]: unknown;
} => {
  if (!existsSync(CONFIG_JSON)) return {};
  return parseJson(readFileSync(CONFIG_JSON, "utf8"), {});
};

const writeConfig = (cfg: Record<string, unknown>) => {
  writeFileSync(CONFIG_JSON, JSON.stringify(cfg, null, 2) + "\n");
};

const listTmuxWindows = (): string[] | null => {
  // Returns null when the tmux session itself does not exist. In that case
  // every supposedly-running session is orphaned. Returns [] only when the
  // session exists but has no workers (unexpected — the placeholder window
  // is always there), so we distinguish the two.
  try {
    const out = execFileSync(
      "tmux",
      ["list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
};

const killTmuxWindow = (name: string): boolean => {
  try {
    execFileSync("tmux", ["kill-window", "-t", `${TMUX_SESSION}:${name}`], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
};

// spawn-worker sets:   WINDOW_NAME="${WI_ID#wi-}"; WINDOW_NAME="${WINDOW_NAME:0:18}"
// Sessions do not persist the tmux window name in fleet.db, so we recompute
// the expected name from the work item id.
const expectedTmuxWindow = (s: Session): string | null => {
  if (s.tmux_window) return s.tmux_window;
  if (!s.work_item_id) return null;
  return s.work_item_id.replace(/^wi-/, "").slice(0, 18);
};

const pushNotification = (
  subject: string,
  body: string,
  related: string[],
): string => {
  const id = `notif-${ulid()}`;
  notifications.insert({
    id,
    subject,
    body,
    urgency: "urgent",
    related_ids: related,
    pushed_at: null,
  });
  return id;
};

// Invariant 1: sessions marked running/starting whose tmux window is gone.
const checkInvariant1Zombie = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("zombie-tmux-window");
  const active = [
    ...sessionsApi.list({ status: "running" }),
    ...sessionsApi.list({ status: "starting" }),
  ].filter((s) => s.kind === "worker");
  if (!active.length) return f;
  const windows = listTmuxWindows();
  for (const s of active) {
    const expected = expectedTmuxWindow(s);
    if (!expected) continue;
    const gone = windows === null ? true : !windows.includes(expected);
    if (!gone) continue;
    f.ok = false;
    f.entries.push({
      id: s.id,
      reason: "tmux window not found",
      details: {
        expected_window: expected,
        work_item_id: s.work_item_id,
        last_heartbeat: s.last_heartbeat,
        status: s.status,
      },
    });
    if (opts.autoFix && !opts.dryRun) {
      sessionsApi.update(s.id, {
        status: "stale",
        notes: `${s.notes ? s.notes + "; " : ""}tmux window not found`,
        ended_at: nowIso(),
      });
      f.fixed.push({ id: s.id, action: "marked stale" });
    }
  }
  return f;
};

// Invariant 2: sessions marked running with last_heartbeat > threshold minutes.
const checkInvariant2StaleHeartbeat = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("stale-heartbeat");
  const cfg = readConfig();
  const threshold = cfg.stale_heartbeat_minutes ?? DEFAULT_STALE_MINUTES;
  const candidates = [
    ...sessionsApi.list({ status: "running" }),
    ...sessionsApi.list({ status: "starting" }),
  ];
  for (const s of candidates) {
    const age = minutesSince(s.last_heartbeat);
    if (age <= threshold) continue;
    f.ok = false;
    f.entries.push({
      id: s.id,
      reason: `no heartbeat for ${age.toFixed(1)} min (threshold ${threshold})`,
      details: {
        last_heartbeat: s.last_heartbeat,
        status: s.status,
        work_item_id: s.work_item_id,
      },
    });
    if (opts.autoFix && !opts.dryRun) {
      sessionsApi.update(s.id, {
        status: "stale",
        notes: `${s.notes ? s.notes + "; " : ""}heartbeat stale (${age.toFixed(0)}m)`,
        ended_at: nowIso(),
      });
      f.fixed.push({ id: s.id, action: "marked stale" });
    }
  }
  return f;
};

// Invariant 3: zero-byte worker log older than 5 minutes AND heartbeat also
// stale → claude is dead. Fresh heartbeats mean claude IS running and executing
// tool calls (claude -p doesn't stream tool calls, only final messages), so a
// long tool-heavy task can legitimately have a 0-byte log for 30+ min. Killing
// such a worker is a false-positive (observed 2026-04-17 on gp-api#1033).
const checkInvariant3SilentWorker = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("silent-worker");
  if (!existsSync(LOGS_DIR)) return f;
  const files = readdirSync(LOGS_DIR).filter(
    (n) => n.startsWith("worker-sess-") && n.endsWith(".log"),
  );
  for (const name of files) {
    const path = join(LOGS_DIR, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.size > 0) continue;
    const logAgeMin = (Date.now() - st.mtimeMs) / 60_000;
    if (logAgeMin < SILENT_WORKER_MINUTES) continue;
    const sessionId = name.replace(/^worker-/, "").replace(/\.log$/, "");
    const s = sessionsApi.get(sessionId);
    // Only flag sessions that are still supposedly alive — if the session is
    // already completed/failed/stale/killed we don't re-escalate.
    if (!s || !["starting", "running", "idle"].includes(s.status)) continue;
    const heartbeatAgeMin = minutesSince(s.last_heartbeat);
    if (heartbeatAgeMin < SILENT_WORKER_MINUTES) continue;
    f.ok = false;
    f.entries.push({
      id: sessionId,
      reason: `claude produced no output and heartbeat is ${heartbeatAgeMin.toFixed(1)} min stale`,
      details: {
        log_path: path,
        log_age_minutes: Number(logAgeMin.toFixed(1)),
        heartbeat_age_minutes: Number(heartbeatAgeMin.toFixed(1)),
        last_heartbeat: s.last_heartbeat,
        status: s.status,
        work_item_id: s.work_item_id,
      },
    });
    if (opts.autoFix && !opts.dryRun) {
      const window = expectedTmuxWindow(s);
      if (window) killTmuxWindow(window);
      sessionsApi.update(sessionId, {
        status: "failed",
        current_step: "failed",
        notes: `${s.notes ? s.notes + "; " : ""}claude silent + heartbeat stale`,
        ended_at: nowIso(),
      });
      if (s.work_item_id) {
        workItems.update(s.work_item_id, {
          status: "blocked",
          session_id: null,
        });
      }
      f.fixed.push({
        id: sessionId,
        action:
          "marked failed (log empty + heartbeat stale), tmux window killed",
      });
    }
  }
  return f;
};

// Invariant 4: pr-open work items whose PR is actually merged/closed on GH.
const checkInvariant4PrDrift = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("pr-status-drift");
  const items = workItems.list({ status: "pr-open" });
  for (const wi of items) {
    const url = wi.pr_urls[wi.pr_urls.length - 1];
    if (!url) continue;
    let state: string | null = null;
    let mergedAt: string | null = null;
    try {
      const out = execFileSync(
        "gh",
        ["pr", "view", url, "--json", "state,mergedAt,url"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const detail = JSON.parse(out);
      state = detail.state ?? null;
      mergedAt = detail.mergedAt ?? null;
    } catch {
      continue;
    }
    if (state === "OPEN") continue;
    const newStatus = state === "MERGED" ? "merged" : "abandoned";
    f.ok = false;
    f.entries.push({
      id: wi.id,
      reason: `PR is ${state} on GitHub but work item is pr-open`,
      details: { pr_url: url, state, merged_at: mergedAt },
    });
    if (opts.autoFix && !opts.dryRun) {
      const patch: Record<string, unknown> = { status: newStatus };
      if (newStatus === "merged") patch.completed_at = mergedAt ?? nowIso();
      workItems.update(wi.id, patch as any);
      f.fixed.push({ id: wi.id, action: `reconciled to ${newStatus}` });
    }
  }
  return f;
};

// Invariant 5: work items marked queued but with an active session on them.
const checkInvariant5QueuedButRunning = (
  opts: DoctorOptions,
): DoctorFinding => {
  const f = emptyFinding("queued-but-running");
  const queued = workItems.list({ status: "queued" });
  if (!queued.length) return f;
  const active = [
    ...sessionsApi.list({ status: "running" }),
    ...sessionsApi.list({ status: "starting" }),
  ];
  const activeByWi = new Map<string, Session>();
  for (const s of active) {
    if (s.work_item_id) activeByWi.set(s.work_item_id, s);
  }
  for (const wi of queued) {
    const s = activeByWi.get(wi.id);
    if (!s) continue;
    f.ok = false;
    f.entries.push({
      id: wi.id,
      reason: "queued work item has active session",
      details: { session_id: s.id, session_status: s.status },
    });
    if (opts.autoFix && !opts.dryRun) {
      workItems.update(wi.id, { status: "in-progress", session_id: s.id });
      f.fixed.push({ id: wi.id, action: "status → in-progress" });
    }
  }
  return f;
};

// Invariant 6: last 3 worker sessions all failed within 15 min → circuit breaker.
const checkInvariant6CircuitBreaker = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("dispatch-circuit-breaker", "error");
  const recent = sessionsApi
    .list({ kind: "worker" })
    .filter((s) => s.ended_at !== null)
    .slice(0, 3);
  if (recent.length < 3) return f;
  const allFailedFast = recent.every((s) => {
    if (s.status !== "failed" || !s.ended_at) return false;
    const durationMin =
      (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) /
      60_000;
    return durationMin < CIRCUIT_BREAKER_MINUTES;
  });
  if (!allFailedFast) return f;
  const cfg = readConfig();
  const alreadyPaused = !!cfg.dispatch_paused;
  f.ok = false;
  f.entries.push({
    reason:
      "last 3 worker sessions all failed within 15 min; dispatch health degraded",
    details: {
      sessions: recent.map((s) => ({
        id: s.id,
        status: s.status,
        started_at: s.started_at,
        ended_at: s.ended_at,
        notes: s.notes,
      })),
      dispatch_paused_before: alreadyPaused,
    },
  });
  if (opts.dryRun) return f;
  // Always notify (even without --auto-fix). The notification is the escalation;
  // pausing dispatch is the automated safety net that stops the bleeding.
  const body = [
    "The last 3 worker sessions all ended in status=failed within 15 min of start.",
    "",
    "Failed sessions:",
    ...recent.map(
      (s) =>
        `- ${s.id} (work_item ${s.work_item_id ?? "—"}): ${s.notes ?? "no notes"}`,
    ),
    "",
    alreadyPaused
      ? "dispatch_paused was already true; leaving it."
      : "dispatch_paused set to true in ~/.claude/cos/config.json.",
    "",
    "Investigate the worker prompts, worktree setup, or underlying repo state, then flip dispatch_paused back to false.",
  ].join("\n");
  const notifId = pushNotification(
    "Worker dispatch auto-paused: 3 consecutive failures, investigate",
    body,
    recent.map((s) => s.id),
  );
  f.notified.push(notifId);
  if (!alreadyPaused) {
    cfg.dispatch_paused = true;
    writeConfig(cfg);
    f.fixed.push({ action: "set dispatch_paused=true in config.json" });
  }
  return f;
};

// Invariant 7: last 3 cron ticks all failed (rc != 0 in cos_log.summary).
const checkInvariant7TickHealth = (opts: DoctorOptions): DoctorFinding => {
  const f = emptyFinding("cron-tick-health", "error");
  const recent = cosLog.recent(3);
  if (recent.length < 3) return f;
  const parseRc = (summary: string): number | null => {
    const m = /rc=(-?\d+|null)/.exec(summary);
    if (!m) return null;
    return m[1] === "null" ? null : parseInt(m[1], 10);
  };
  const rcs = recent.map((r: any) => parseRc(String(r.summary ?? "")));
  const allFailed = rcs.every((rc) => rc !== 0);
  if (!allFailed) return f;
  f.ok = false;
  f.entries.push({
    reason: "last 3 cron ticks all exited non-zero",
    details: {
      ticks: recent.map((r: any) => ({
        id: r.id,
        tick_at: r.tick_at,
        summary: r.summary,
      })),
    },
  });
  if (opts.dryRun) return f;
  const notifId = pushNotification(
    "COS cron ticks failing",
    `Last 3 ticks returned non-zero: ${rcs.join(", ")}. Check ~/.claude/cos/logs/cron-*.log.`,
    recent.map((r: any) => r.id),
  );
  f.notified.push(notifId);
  return f;
};

export const runDoctor = (opts: DoctorOptions): DoctorReport => {
  const findings: DoctorFinding[] = [
    checkInvariant1Zombie(opts),
    checkInvariant2StaleHeartbeat(opts),
    checkInvariant3SilentWorker(opts),
    checkInvariant4PrDrift(opts),
    checkInvariant5QueuedButRunning(opts),
    checkInvariant6CircuitBreaker(opts),
    checkInvariant7TickHealth(opts),
  ];
  const issues = findings.filter((f) => !f.ok).length;
  const fixed = findings.reduce((n, f) => n + f.fixed.length, 0);
  const notified = findings.reduce((n, f) => n + f.notified.length, 0);
  return {
    ran_at: nowIso(),
    auto_fix: opts.autoFix,
    dry_run: opts.dryRun,
    findings,
    summary: { checked: findings.length, issues, fixed, notified },
  };
};

const renderText = (r: DoctorReport): string => {
  const lines: string[] = [];
  const head =
    `doctor: ${r.summary.issues} issue(s) across ${r.summary.checked} invariants` +
    ` — fixed=${r.summary.fixed} notified=${r.summary.notified}` +
    (r.dry_run ? " (dry-run)" : r.auto_fix ? "" : " (report-only)");
  lines.push(r.summary.issues ? chalk.yellow(head) : chalk.green(head));
  for (const f of r.findings) {
    if (f.ok) {
      lines.push(chalk.green(`  ✓ ${f.invariant}`));
      continue;
    }
    lines.push(
      (f.severity === "error" ? chalk.red : chalk.yellow)(
        `  ✗ ${f.invariant} (${f.entries.length})`,
      ),
    );
    for (const e of f.entries) {
      lines.push(`      - ${e.id ? e.id + ": " : ""}${e.reason}`);
    }
    for (const fix of f.fixed) {
      lines.push(
        chalk.gray(`      fix: ${fix.id ? fix.id + " " : ""}${fix.action}`),
      );
    }
    for (const nid of f.notified) {
      lines.push(chalk.gray(`      notified: ${nid}`));
    }
  }
  return lines.join("\n");
};

export const cmdDoctor = (opts: DoctorOptions) => {
  const report = runDoctor(opts);
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(report) + "\n");
  }
};
