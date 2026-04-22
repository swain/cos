import { spawn, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import chalk from "chalk";
import {
  getDb,
  ideas,
  meetingPrepRuns,
  notifications,
  plans,
  sessions,
  signals,
  workItems,
} from "../db.js";
import { cmdEnqueue } from "../commands/enqueue.js";
import { decidePlanReviewAction } from "../commands/plans.js";
import {
  COS_DIR,
  displayWorkItemId,
  MEETINGS_DIR,
  tmuxWindowName,
} from "../util.js";
import {
  findUpcomingMeetingById,
  invalidateUpcomingCache,
} from "./upcoming.js";
import type { InboxDashboard, InboxItem } from "./types.js";

const COS_BIN = join(COS_DIR, "bin/cos");
const TMUX_WORKER_SESSION = "cos-workers";

// Bulk PR review (`cos review <url1> <url2>...`) walks the URLs sequentially
// with an interactive readline prompt for `gh pr review` mirror after each.
// That needs a TTY, so the bulk flow still asks Terminal.app to open a window.
// Single-plan and single-PR review no longer use this — they spawn plannotator
// headlessly (see reviewPlanInPlannotator / reviewInPlannotator below).
const openTerminalRunning = (command: string): boolean => {
  if (process.platform !== "darwin") return false;
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    spawn(
      "osascript",
      ["-e", `tell application "Terminal" to do script "${escaped}"`],
      { stdio: "ignore", detached: true },
    ).unref();
    spawn("osascript", ["-e", 'tell application "Terminal" to activate'], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return true;
  } catch {
    return false;
  }
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const runCos = (args: string[]): Promise<{ ok: boolean; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(COS_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stderr });
    });
    child.on("error", (err) => {
      resolve({ ok: false, stderr: String(err) });
    });
  });

export type ActionResult = { ok: boolean; message: string; detail?: string };

const windowNameForWi = (wiId: string): string => {
  const wi = workItems.get(wiId);
  return tmuxWindowName(wi ? displayWorkItemId(wi) : wiId);
};

const killTmuxWindow = (sessionId: string, wiId: string | null) => {
  const candidates: string[] = [];
  const sess = sessions.get(sessionId);
  if (sess?.tmux_window) candidates.push(sess.tmux_window);
  if (wiId) candidates.push(`${TMUX_WORKER_SESSION}:${windowNameForWi(wiId)}`);
  for (const target of candidates) {
    try {
      execSync(`tmux kill-window -t "${target}"`, { stdio: "pipe" });
      return { ok: true as const, target };
    } catch {
      // try next
    }
  }
  return { ok: false as const, target: candidates.join(", ") || "(unknown)" };
};

export const ackNotification = async (id: string): Promise<ActionResult> => {
  notifications.markPushed(id);
  return { ok: true, message: `acked ${id}` };
};

export const approveWorkItem = async (id: string): Promise<ActionResult> => {
  const r = await runCos(["dispatch", id]);
  return r.ok
    ? { ok: true, message: `dispatched ${id}` }
    : {
        ok: false,
        message: `dispatch failed: ${r.stderr.trim().split("\n")[0]}`,
      };
};

export const dispatchWorkItem = approveWorkItem;

export const snoozeWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const next = Math.min(5, wi.priority + 1);
  workItems.update(wi.id, { priority: next });
  return { ok: true, message: `snoozed ${displayWorkItemId(wi)} → P${next}` };
};

export const bumpWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const next = Math.max(1, wi.priority - 1);
  workItems.update(wi.id, { priority: next });
  return { ok: true, message: `bumped ${displayWorkItemId(wi)} → P${next}` };
};

export const archiveWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  workItems.update(wi.id, { status: "abandoned" });
  return { ok: true, message: `archived ${displayWorkItemId(wi)}` };
};

export const abandonWorkItem = archiveWorkItem;

export const retryWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  workItems.update(wi.id, { status: "queued", session_id: null });
  const r = await runCos(["dispatch", wi.id, "--force"]);
  return r.ok
    ? { ok: true, message: `retrying ${displayWorkItemId(wi)}` }
    : {
        ok: false,
        message: `retry failed: ${r.stderr.trim().split("\n")[0]}`,
      };
};

export const markPrReviewed = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  getDb()
    .prepare(
      `UPDATE work_items SET inbox_acked_at = datetime('now') WHERE id = ?`,
    )
    .run(wi.id);
  return { ok: true, message: `marked ${displayWorkItemId(wi)} reviewed` };
};

// Doc-review: worker output landed as a local markdown file (file:// pr_url)
// rather than a GitHub PR. Reviewing it from the dashboard does three things:
//   1. If `reply` is non-empty, append a timestamped "## Review feedback" block
//      to the doc so the worker sees it on pickup.
//   2. Mark the WI inbox_acked_at so the card drops off Review.
//   3. Transition the WI to `done` (terminal lifecycle state — same destination
//      as a merged PR, but via this non-GitHub path).
export const submitDocReview = async (
  id: string,
  reply: string,
): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const docUrl = wi.pr_urls[0];
  if (!docUrl || !docUrl.startsWith("file://")) {
    return { ok: false, message: `no doc output on ${displayWorkItemId(wi)}` };
  }
  const docPath = docUrl.replace(/^file:\/\//, "");
  const trimmed = reply.trim();
  if (trimmed) {
    if (!existsSync(docPath)) {
      return { ok: false, message: `doc file not found: ${docPath}` };
    }
    const ts = new Date().toISOString();
    try {
      appendFileSync(
        docPath,
        `\n## Review feedback — ${ts}\n\n${trimmed}\n`,
        "utf8",
      );
    } catch (e) {
      return {
        ok: false,
        message: `failed to append to doc: ${String(e)}`,
      };
    }
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE work_items
         SET inbox_acked_at = datetime('now'),
             status = 'done',
             completed_at = ?
       WHERE id = ?`,
    )
    .run(now, wi.id);
  return {
    ok: true,
    message: trimmed
      ? `doc review filed for ${displayWorkItemId(wi)}`
      : `acked ${displayWorkItemId(wi)}`,
  };
};

export const suppressSignal = async (id: string): Promise<ActionResult> => {
  const r = await runCos(["signal-triage", id, "suppress"]);
  return r.ok
    ? { ok: true, message: `suppressed ${id}` }
    : {
        ok: false,
        message: `suppress failed: ${r.stderr.trim().split("\n")[0]}`,
      };
};

export const dismissSession = async (id: string): Promise<ActionResult> => {
  const s = sessions.get(id);
  if (!s) return { ok: false, message: `session not found: ${id}` };
  getDb()
    .prepare(`UPDATE sessions SET acked_at = datetime('now') WHERE id = ?`)
    .run(id);
  return { ok: true, message: `dismissed ${id}` };
};

export const killSession = async (id: string): Promise<ActionResult> => {
  const s = sessions.get(id);
  if (!s) return { ok: false, message: `session not found: ${id}` };
  const kill = killTmuxWindow(id, s.work_item_id);
  sessions.update(id, {
    status: "killed",
    ended_at: new Date().toISOString(),
  });
  if (s.work_item_id) {
    const wi = workItems.get(s.work_item_id);
    if (wi && wi.status === "in-progress") {
      workItems.update(s.work_item_id, {
        status: "blocked",
        session_id: null,
      });
    }
  }
  return kill.ok
    ? { ok: true, message: `killed ${id} (${kill.target})` }
    : {
        ok: true,
        message: `marked ${id} killed; tmux window not found (${kill.target})`,
      };
};

export const retrySession = async (id: string): Promise<ActionResult> => {
  const s = sessions.get(id);
  if (!s) return { ok: false, message: `session not found: ${id}` };
  if (!s.work_item_id)
    return { ok: false, message: `session ${id} has no work item` };
  getDb()
    .prepare(`UPDATE sessions SET acked_at = datetime('now') WHERE id = ?`)
    .run(id);
  return retryWorkItem(s.work_item_id);
};

export const peekSession = async (id: string): Promise<ActionResult> => {
  const s = sessions.get(id);
  if (!s) return { ok: false, message: `session not found: ${id}` };
  const target =
    s.tmux_window ??
    (s.work_item_id
      ? `${TMUX_WORKER_SESSION}:${windowNameForWi(s.work_item_id)}`
      : TMUX_WORKER_SESSION);
  const hint = `tmux attach -t ${target}`;
  return { ok: true, message: hint, detail: hint };
};

export const viewFailureLog = async (id: string): Promise<ActionResult> => {
  const wi = workItems.resolve(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const display = displayWorkItemId(wi);
  const rows = getDb()
    .prepare(
      `SELECT id, status, notes, current_step, last_heartbeat FROM sessions
       WHERE work_item_id = ? ORDER BY started_at DESC LIMIT 3`,
    )
    .all(wi.id) as {
    id: string;
    status: string;
    notes: string | null;
    current_step: string | null;
    last_heartbeat: string;
  }[];
  if (!rows.length) return { ok: true, message: `no sessions for ${display}` };
  const detail = rows
    .map(
      (r) =>
        `${r.id} [${r.status}] step=${r.current_step ?? "—"} hb=${r.last_heartbeat}${
          r.notes ? `\n  ${r.notes}` : ""
        }`,
    )
    .join("\n");
  return { ok: true, message: `failure log for ${display}`, detail };
};

export const enqueueInboxResponse = async (
  rowKey: string,
  text: string,
): Promise<ActionResult> => {
  const body = text.trim();
  if (!body) return { ok: false, message: "empty response" };
  const short = body.length > 60 ? `${body.slice(0, 57)}…` : body;
  const title = `handle inbox response: ${short}`;
  const description = `User replied on inbox row ${rowKey}:\n\n${body}`;
  const acceptance = `Act on the user's natural-language response for inbox row ${rowKey}. Response body: ${body}`;
  const id = cmdEnqueue({
    title,
    description,
    acceptance,
    repos: ["cos"],
    priority: 2,
    source: "inbox",
  });
  const wi = workItems.get(id);
  return {
    ok: true,
    message: `enqueued ${wi ? displayWorkItemId(wi) : id}`,
  };
};

// Promotes an idea to a queued work item. We use the idea's own title and
// description and an empty acceptance string — user can groom on dispatch.
export const promoteIdea = async (id: string): Promise<ActionResult> => {
  const idea = ideas.get(id);
  if (!idea) return { ok: false, message: `idea not found: ${id}` };
  if (idea.status !== "new")
    return { ok: false, message: `idea ${id} already ${idea.status}` };
  const wiId = `wi-${ulid()}`;
  const { num, slug } = workItems.insert({
    id: wiId,
    title: idea.title,
    description: idea.description,
    acceptance_criteria: "",
    repos: idea.repos_guess,
    priority: 3,
    status: "queued",
    source: `idea:${id}`,
    depends_on: [],
    session_id: null,
    pr_urls: [],
    worklog_path: null,
    worktree_paths: {},
    needs_approval: false,
    parent_id: null,
    needs_planning: false,
  });
  ideas.update(id, { status: "promoted", promoted_to: wiId });
  return {
    ok: true,
    message: `promoted ${id} → ${displayWorkItemId({ id: wiId, num, slug })}`,
  };
};

export const killIdea = async (id: string): Promise<ActionResult> => {
  const idea = ideas.get(id);
  if (!idea) return { ok: false, message: `idea not found: ${id}` };
  if (idea.status !== "new")
    return { ok: false, message: `idea ${id} already ${idea.status}` };
  ideas.update(id, { status: "killed" });
  return { ok: true, message: `killed ${id}` };
};

export const deferIdea = async (id: string): Promise<ActionResult> => {
  const idea = ideas.get(id);
  if (!idea) return { ok: false, message: `idea not found: ${id}` };
  if (idea.status !== "new")
    return { ok: false, message: `idea ${id} already ${idea.status}` };
  ideas.update(id, { status: "deferred" });
  return { ok: true, message: `deferred ${id}` };
};

// "accept" applies the Po verdict: promote for suggest-promote, kill for
// suggest-kill, no-op for your-call (user must pick explicitly).
export const acceptIdea = async (id: string): Promise<ActionResult> => {
  const idea = ideas.get(id);
  if (!idea) return { ok: false, message: `idea not found: ${id}` };
  if (idea.triage_verdict === "suggest-promote") return promoteIdea(id);
  if (idea.triage_verdict === "suggest-kill") return killIdea(id);
  if (idea.triage_verdict === "your-call")
    return {
      ok: false,
      message: `idea ${id} is your-call — pick an explicit action`,
    };
  return { ok: false, message: `idea ${id} has no triage verdict yet` };
};

// Bulk hygiene action. Requires two submits to fire — the first call returns
// ok=false with a "confirm" token; the second call, passing that token via
// the `confirm` field on the POST form, actually kills the ideas. This keeps
// the action one click away without making it a one-click disaster.
export const acceptAllSuggestKill = async (
  confirm: boolean,
): Promise<ActionResult> => {
  const candidates = ideas
    .list({ status: "new" })
    .filter((i) => i.triage_verdict === "suggest-kill");
  if (!candidates.length) return { ok: true, message: "no suggest-kill ideas" };
  if (!confirm) {
    return {
      ok: false,
      message: `confirm to kill ${candidates.length} suggest-kill ideas`,
    };
  }
  let killed = 0;
  for (const idea of candidates) {
    ideas.update(idea.id, { status: "killed" });
    killed++;
  }
  return { ok: true, message: `killed ${killed} suggest-kill ideas` };
};

export const markAllFyiRead = async (
  source: InboxDashboard | InboxItem[],
): Promise<ActionResult> => {
  const fyi = Array.isArray(source)
    ? source.filter((i) => i.section === "fyi")
    : source.fyi;
  let dismissed = 0;
  const ackSession = getDb().prepare(
    `UPDATE sessions SET acked_at = datetime('now') WHERE id = ? AND acked_at IS NULL`,
  );
  for (const item of fyi) {
    if (item.kind === "notification") {
      notifications.markPushed(item.id);
      dismissed++;
    } else if (item.kind === "session") {
      const r = ackSession.run(item.id);
      if (r.changes > 0) dismissed++;
    }
  }
  return { ok: true, message: `dismissed ${dismissed} FYI rows` };
};

// Ad-hoc calendar prep for a single event. The collector subprocess runs
// ~30-180s (it spawns `claude -p` internally), so we spawn async and return
// immediately. Before returning we insert a `meeting_prep_runs` row with
// status=running so the dashboard's next render flips the badge to yellow
// without having to wait for the child to finish.
//
// We keep a one-shot exit listener on the child to reconcile the run row
// on the way out: collector stdout is scanned for the `no-prep-needed`
// sentinel, stderr is tail-clipped for failure messaging, and the prep
// file path is checked on disk. If the inbox server is restarted before
// the child exits, reconcilePrepRuns() picks up on the next render or boot:
// PID-alive rows stay running, PID-dead rows settle to ready (file on
// disk) or failed (no file) without implementation-leak copy.
//
// We cap the collector's wall time at 5 min. Claude-p occasionally stalls
// on MCP auth and we'd rather surface a failure than a silently-stuck
// yellow badge.
const PREP_COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const NO_PREP_SENTINEL = "no-prep-needed";
const GWS_FETCH_FAILED_SENTINEL = "gws-event-fetch-failed";
const GWS_UNAVAILABLE_SENTINEL = "gws-unavailable";

const lastNonEmptyLines = (s: string, n: number): string => {
  const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
};

// Classifies a successful (exit 0) collector run by scanning combined
// stdout/stderr for known sentinels. Callers still check exit code and signal
// themselves before calling into this — this function only decides between
// the happy-path outcomes plus the gws-event-fetch-failed infra-break.
export type PrepOutcome =
  | { kind: "ready" }
  | { kind: "no-prep-needed" }
  | { kind: "gws-fetch-failed"; reason: string };

export const classifyCollectorOutput = (combined: string): PrepOutcome => {
  const lower = combined.toLowerCase();
  if (lower.includes(GWS_FETCH_FAILED_SENTINEL)) {
    return {
      kind: "gws-fetch-failed",
      reason: "couldn't fetch event (gws calendar events get failed)",
    };
  }
  if (lower.includes(GWS_UNAVAILABLE_SENTINEL)) {
    return {
      kind: "gws-fetch-failed",
      reason: "gws CLI unavailable — check /opt/homebrew/bin/gws",
    };
  }
  if (lower.includes(NO_PREP_SENTINEL)) {
    return { kind: "no-prep-needed" };
  }
  return { kind: "ready" };
};

export const prepMeetingNow = async (
  eventId: string,
): Promise<ActionResult> => {
  if (!eventId) return { ok: false, message: "no event id" };

  // If there's already a running row for this event, reconcile it first —
  // a previous spawn may have been orphaned by an inbox-serve restart and is
  // no longer alive, in which case we want to start fresh rather than
  // short-circuit on a stale row.
  reconcilePrepRuns();
  const existing = meetingPrepRuns.latestForEvent(eventId);
  if (existing && existing.status === "running") {
    return { ok: true, message: `prep already running for ${eventId}` };
  }

  const upcoming = findUpcomingMeetingById(eventId);
  // Solo events can never yield useful prep. Short-circuit before spawning
  // the collector so a stray Prep Now / Retry click doesn't pay the claude
  // cold-start just to print `no-prep-needed`.
  if (upcoming && upcoming.prepStatus === "solo") {
    return { ok: true, message: `solo meeting — no prep needed` };
  }
  const slug = upcoming?.prepSlug ?? eventId;
  const runId = `mpr-${ulid()}`;

  let child;
  try {
    child = spawn(COS_BIN, ["collect-calendar", "--event-id", eventId], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    // Insert the row only so we can immediately close it out — keeps the
    // audit trail consistent with the happy path.
    meetingPrepRuns.start({ id: runId, event_id: eventId, slug });
    meetingPrepRuns.finish(runId, {
      status: "failed",
      error: `failed to spawn collector: ${String(e)}`,
    });
    invalidateUpcomingCache();
    return { ok: false, message: `failed to spawn collector: ${String(e)}` };
  }

  meetingPrepRuns.start({
    id: runId,
    event_id: eventId,
    slug,
    pid: child.pid ?? null,
  });

  // Detached + unref so the child keeps running if the parent exits for a
  // deploy; reconcilePrepRuns() handles the orphan case on next render / boot
  // by checking PID liveness and filesystem.
  child.unref();

  let stdoutBuf = "";
  let stderrBuf = "";
  const BUF_CAP = 32_000;
  child.stdout?.on("data", (chunk) => {
    if (stdoutBuf.length < BUF_CAP) stdoutBuf += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    if (stderrBuf.length < BUF_CAP) stderrBuf += chunk.toString();
  });

  const timeoutHandle = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // child already exited — exit handler will still run
    }
  }, PREP_COLLECTOR_TIMEOUT_MS);
  timeoutHandle.unref();

  const settle = (
    status: "ready" | "no-prep-needed" | "failed",
    failureReason?: string,
  ) => {
    const prepPath = `${MEETINGS_DIR}/${slug}.md`;
    const hasFile = existsSync(prepPath);
    const tail = (s: string) => lastNonEmptyLines(s, 3) || null;
    if (status === "ready" && !hasFile) {
      // Collector claims success but no file — treat as failed so the user
      // can retry instead of staring at a green badge with no payload.
      meetingPrepRuns.finish(runId, {
        status: "failed",
        exit_code: 0,
        error: "collector finished with exit 0 but no prep file was written",
      });
    } else if (status === "ready") {
      meetingPrepRuns.finish(runId, {
        status: "ready",
        exit_code: 0,
        prep_file_path: prepPath,
      });
    } else if (status === "no-prep-needed") {
      meetingPrepRuns.finish(runId, {
        status: "no-prep-needed",
        exit_code: 0,
      });
    } else {
      meetingPrepRuns.finish(runId, {
        status: "failed",
        exit_code: null,
        error:
          failureReason ??
          tail(stderrBuf) ??
          tail(stdoutBuf) ??
          "collector failed",
      });
    }
    invalidateUpcomingCache();
  };

  child.once("exit", (code, sig) => {
    clearTimeout(timeoutHandle);
    const combined = stdoutBuf + "\n" + stderrBuf;
    if (sig === "SIGTERM") {
      meetingPrepRuns.finish(runId, {
        status: "failed",
        exit_code: code,
        error: `timed out after ${PREP_COLLECTOR_TIMEOUT_MS / 1000}s`,
      });
      invalidateUpcomingCache();
      return;
    }
    if (code !== 0) {
      settle("failed");
      return;
    }
    const outcome = classifyCollectorOutput(combined);
    if (outcome.kind === "gws-fetch-failed") {
      settle("failed", outcome.reason);
      return;
    }
    settle(outcome.kind);
  });
  child.once("error", (err) => {
    clearTimeout(timeoutHandle);
    meetingPrepRuns.finish(runId, {
      status: "failed",
      error: `spawn error: ${String(err)}`,
    });
    invalidateUpcomingCache();
  });

  invalidateUpcomingCache();
  return { ok: true, message: `queued prep for ${eventId}` };
};

const INTERRUPTED_ERROR = "Collector interrupted — retry";

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM → process exists but we lack permission to signal. Treat as alive.
    return e?.code === "EPERM";
  }
};

const parseStartedAtMs = (ts: string): number => {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const withZ = iso.endsWith("Z") ? iso : `${iso}Z`;
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? 0 : t;
};

// Reconciles `meeting_prep_runs` rows still marked `running`. Safe to call
// repeatedly — called at inbox-serve boot and on each upcoming render so a
// child that finishes after its parent died doesn't leave the row stuck.
//
// Per row:
//   - PID alive                                  → leave running
//   - PID dead + prep file on disk (mtime > run) → mark ready
//   - PID dead + no prep file                    → mark failed (friendly copy)
//   - No PID recorded (legacy)                   → mark failed (friendly copy)
//
// Returns the number of rows transitioned out of running.
export const reconcilePrepRuns = (): number => {
  const running = meetingPrepRuns.listRunning();
  let reconciled = 0;
  for (const r of running) {
    if (r.pid && isProcessAlive(r.pid)) continue;
    const prepPath = `${MEETINGS_DIR}/${r.slug}.md`;
    let fileMtimeMs = 0;
    if (existsSync(prepPath)) {
      try {
        fileMtimeMs = statSync(prepPath).mtimeMs;
      } catch {
        fileMtimeMs = 0;
      }
    }
    const startedMs = parseStartedAtMs(r.started_at);
    if (fileMtimeMs > 0 && fileMtimeMs >= startedMs) {
      meetingPrepRuns.finish(r.id, {
        status: "ready",
        exit_code: null,
        prep_file_path: prepPath,
      });
    } else {
      meetingPrepRuns.finish(r.id, {
        status: "failed",
        error: INTERRUPTED_ERROR,
      });
    }
    reconciled++;
  }
  return reconciled;
};

// Prep-feedback capture: the user jots a line on the prep page saying whether
// the prep was useful. We persist it to a human-readable log AND drop a signal
// so Po sees it on the next cron tick. Po triages the signal to a normal
// notification — no auto-rewrite of the collector prompt (that's feature-creep
// territory; the user makes the call).
export const submitPrepFeedback = async (
  eventId: string,
  feedback: string,
): Promise<ActionResult> => {
  if (!eventId) return { ok: false, message: "no event id" };
  const trimmed = feedback.trim();
  if (!trimmed) return { ok: false, message: "empty feedback" };

  const upcoming = findUpcomingMeetingById(eventId);
  const slug = upcoming?.prepSlug ?? null;
  const summary = upcoming?.summary ?? null;

  const logPath = `${MEETINGS_DIR}/feedback.log`;
  try {
    mkdirSync(MEETINGS_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const header = summary
      ? `[${ts}] event_id=${eventId} slug=${slug ?? "-"} summary=${JSON.stringify(summary)}`
      : `[${ts}] event_id=${eventId} slug=${slug ?? "-"}`;
    appendFileSync(logPath, `${header}\n${trimmed}\n\n`, "utf8");
  } catch (e) {
    return { ok: false, message: `failed to write feedback log: ${String(e)}` };
  }

  signals.insert({
    id: `sig-${ulid()}`,
    source: "meeting-prep",
    kind: "meeting-prep-feedback",
    external_id: null,
    payload: {
      event_id: eventId,
      slug,
      summary,
      feedback: trimmed,
    },
    status: "new",
    triaged_at: null,
  });

  return { ok: true, message: `feedback filed for ${eventId}` };
};

// Opens the prep .md file in the user's default macOS handler. darwin-only.
export const openPrepFile = async (path: string): Promise<ActionResult> => {
  if (!path) return { ok: false, message: "no prep path" };
  if (!path.startsWith(COS_DIR))
    return { ok: false, message: "prep path outside cos dir" };
  if (!existsSync(path))
    return { ok: false, message: `prep file not found: ${path}` };
  if (process.platform !== "darwin")
    return { ok: false, message: `open not supported on ${process.platform}` };
  try {
    spawn("open", [path], { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    return { ok: false, message: `failed to open: ${String(e)}` };
  }
  return { ok: true, message: `opened ${path}` };
};

export const approvePlan = async (planId: string): Promise<ActionResult> => {
  const r = await runCos(["plan-approve", planId]);
  return r.ok
    ? { ok: true, message: `approved ${planId}` }
    : {
        ok: false,
        message: `approve failed: ${r.stderr.trim().split("\n")[0] || "unknown"}`,
      };
};

export const dismissPlan = async (planId: string): Promise<ActionResult> => {
  const r = await runCos([
    "plan-supersede",
    planId,
    "--note",
    "dismissed from inbox",
  ]);
  return r.ok
    ? { ok: true, message: `dismissed ${planId}` }
    : {
        ok: false,
        message: `dismiss failed: ${r.stderr.trim().split("\n")[0] || "unknown"}`,
      };
};

export const submitPlanFeedback = async (
  planId: string,
  body: string,
): Promise<ActionResult> => {
  if (!body.trim()) return { ok: false, message: "empty feedback" };
  const r = await runCos(["plan-resubmit", planId, "--feedback", body]);
  return r.ok
    ? { ok: true, message: `feedback recorded for ${planId}` }
    : {
        ok: false,
        message: `feedback failed: ${r.stderr.trim().split("\n")[0] || "unknown"}`,
      };
};

// Spawns `plannotator annotate <plan.path>` headlessly. plannotator starts its
// own local HTTP server and auto-opens the reviewer's default browser — no
// Terminal window involved. When the reviewer clicks "Send feedback" with
// annotations, plannotator writes the feedback body to stdout on exit and we
// auto-`cos plan-resubmit --feedback <body>`. If plannotator exits without a
// usable body (closed tab, no annotations, etc.), we leave the plan row in
// `awaiting-review` — the reviewer can approve or dismiss from the dashboard.
// Sentinel semantics (`No feedback provided.` = empty) are shared with
// `cos plan-review` via `decidePlanReviewAction`.
export const reviewPlanInPlannotator = async (
  planId: string,
): Promise<ActionResult> => {
  if (!planId) return { ok: false, message: "no plan id" };
  const plan = plans.get(planId);
  if (!plan) return { ok: false, message: `plan not found: ${planId}` };
  if (plan.status !== "awaiting-review") {
    return {
      ok: false,
      message: `plan ${planId} is ${plan.status}, not awaiting-review`,
    };
  }
  if (!existsSync(plan.path)) {
    return { ok: false, message: `plan file missing: ${plan.path}` };
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  const BUF_CAP = 64_000;
  let child;
  try {
    child = spawn("plannotator", ["annotate", plan.path], {
      cwd: COS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLANNOTATOR_CWD: COS_DIR },
    });
  } catch (e) {
    return {
      ok: false,
      message: `failed to spawn plannotator: ${String(e)}`,
    };
  }
  child.stdout?.on("data", (c) => {
    if (stdoutBuf.length < BUF_CAP) stdoutBuf += c.toString();
  });
  child.stderr?.on("data", (c) => {
    if (stderrBuf.length < BUF_CAP) stderrBuf += c.toString();
  });
  child.once("error", (err) => {
    console.error(
      chalk.red(
        `[plannotator annotate] spawn failed for plan ${planId}: ${err.message}`,
      ),
    );
  });
  child.once("exit", async (code) => {
    if (code !== 0) {
      const tail = stderrBuf
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join("\n");
      console.error(
        chalk.yellow(
          `[plannotator annotate] plan ${planId} exited with code ${code}${
            tail ? `\n${tail}` : ""
          }`,
        ),
      );
      return;
    }
    const decision = decidePlanReviewAction(stdoutBuf);
    if (decision.kind !== "resubmit") {
      console.log(
        chalk.gray(
          `[plannotator annotate] ${planId} exited without a feedback body; plan stays awaiting-review`,
        ),
      );
      return;
    }
    const r = await runCos([
      "plan-resubmit",
      planId,
      "--feedback",
      decision.feedback,
    ]);
    if (r.ok) {
      console.log(
        chalk.green(`[plannotator annotate] feedback recorded for ${planId}`),
      );
    } else {
      console.error(
        chalk.red(
          `[plannotator annotate] plan-resubmit ${planId} failed: ${
            r.stderr.trim().split("\n")[0] || "unknown"
          }`,
        ),
      );
    }
  });

  return {
    ok: true,
    message: `plannotator opened for plan ${planId} — submit feedback in the new tab to approve or resubmit`,
  };
};

// Spawns `plannotator review <pr-url>` headlessly. plannotator opens the
// reviewer's default browser to show the diff; when they click "approve" or
// send feedback the child exits with the result on stdout. We log the
// outcome but do not auto-mirror to `gh pr review` — that interactive
// mirror step lives in `cos review <url>` (bulk queue) where a Terminal
// is available. For single-PR review from the dashboard, reviewers mirror
// to GitHub manually if they want to.
export const reviewInPlannotator = async (
  prUrl: string,
): Promise<ActionResult> => {
  if (!prUrl) return { ok: false, message: "no PR URL on this row" };

  let stdoutBuf = "";
  let stderrBuf = "";
  const BUF_CAP = 64_000;
  let child;
  try {
    child = spawn("plannotator", ["review", prUrl], {
      cwd: COS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLANNOTATOR_CWD: COS_DIR },
    });
  } catch (e) {
    return {
      ok: false,
      message: `failed to spawn plannotator: ${String(e)}`,
    };
  }
  child.stdout?.on("data", (c) => {
    if (stdoutBuf.length < BUF_CAP) stdoutBuf += c.toString();
  });
  child.stderr?.on("data", (c) => {
    if (stderrBuf.length < BUF_CAP) stderrBuf += c.toString();
  });
  child.once("error", (err) => {
    console.error(
      chalk.red(
        `[plannotator review] spawn failed for ${prUrl}: ${err.message}`,
      ),
    );
  });
  child.once("exit", (code) => {
    if (code !== 0) {
      const tail = stderrBuf
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join("\n");
      console.error(
        chalk.yellow(
          `[plannotator review] ${prUrl} exited with code ${code}${
            tail ? `\n${tail}` : ""
          }`,
        ),
      );
      return;
    }
    const body = stdoutBuf.trim();
    if (!body) return;
    const preview = body.length > 280 ? `${body.slice(0, 277)}…` : body;
    console.log(chalk.cyan(`[plannotator review] ${prUrl} — ${preview}`));
  });

  return {
    ok: true,
    message: `plannotator opened for ${prUrl} — mirror to gh pr review manually if needed`,
  };
};

// Queue mode walks all open PRs sequentially — one plannotator at a time,
// then the gh mirror prompt, then the next URL. Single Terminal window.
export const startReviewQueue = async (
  urls: string[],
): Promise<ActionResult> => {
  if (!urls.length) return { ok: false, message: "no PRs to review" };
  const args = urls.map(shellQuote).join(" ");
  const cmd = `${shellQuote(COS_BIN)} review ${args}`;
  if (!openTerminalRunning(cmd)) {
    return {
      ok: false,
      message: `run manually: cos review ${urls.join(" ")}`,
      detail: `run manually: cos review ${urls.join(" ")}`,
    };
  }
  return {
    ok: true,
    message: `opened review queue (${urls.length} PRs)`,
    detail: `running in new Terminal: cos review ${urls.length} PR(s)`,
  };
};
