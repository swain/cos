import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import {
  getDb,
  ideas,
  meetingPrepRuns,
  notifications,
  sessions,
  workItems,
} from "../db.js";
import { cmdEnqueue } from "../commands/enqueue.js";
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

// `cos review` needs an interactive terminal (plannotator takes over stdio, then
// we readline for the gh mirror). We can't inherit the inbox server's stdio, so
// we ask Terminal.app to open a new window running the command. Darwin-only —
// matches `cos dashboard`'s existing darwin gate.
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
// the child exits, reconcileOrphanedPrepRuns() (called at server boot)
// sweeps the row to `failed` — "timeout (server restarted)".
//
// We cap the collector's wall time at 5 min. Claude-p occasionally stalls
// on MCP auth and we'd rather surface a failure than a silently-stuck
// yellow badge.
const PREP_COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const NO_PREP_SENTINEL = "no-prep-needed";

const lastNonEmptyLines = (s: string, n: number): string => {
  const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
};

export const prepMeetingNow = async (
  eventId: string,
): Promise<ActionResult> => {
  if (!eventId) return { ok: false, message: "no event id" };

  // If there's already a running row for this event, don't spawn a duplicate —
  // just return ok so the UI stays responsive. The badge is already yellow.
  const existing = meetingPrepRuns.latestForEvent(eventId);
  if (existing && existing.status === "running") {
    return { ok: true, message: `prep already running for ${eventId}` };
  }

  const upcoming = findUpcomingMeetingById(eventId);
  const slug = upcoming?.prepSlug ?? eventId;
  const runId = `mpr-${ulid()}`;
  meetingPrepRuns.start({ id: runId, event_id: eventId, slug });

  let child;
  try {
    child = spawn(COS_BIN, ["collect-calendar", "--event-id", eventId], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    meetingPrepRuns.finish(runId, {
      status: "failed",
      error: `failed to spawn collector: ${String(e)}`,
    });
    invalidateUpcomingCache();
    return { ok: false, message: `failed to spawn collector: ${String(e)}` };
  }

  // Detached + unref so the child keeps running if the parent exits for a
  // deploy; the reconcile sweep handles the orphan case on next boot.
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

  const settle = (status: "ready" | "no-prep-needed" | "failed") => {
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
        error: tail(stderrBuf) ?? tail(stdoutBuf) ?? "collector failed",
      });
    }
    invalidateUpcomingCache();
  };

  child.once("exit", (code, sig) => {
    clearTimeout(timeoutHandle);
    const combined = stdoutBuf + "\n" + stderrBuf;
    const sawNoPrep = combined.toLowerCase().includes(NO_PREP_SENTINEL);
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
    settle(sawNoPrep ? "no-prep-needed" : "ready");
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

// Walked at inbox-serve boot. Any `meeting_prep_runs` row still marked
// running belongs to a child that died with its parent — launchd kickstart
// after a merge, OS reboot, etc. Marks them failed so the dashboard doesn't
// paint a stuck yellow badge forever. Intentionally does not look at the
// filesystem: if the file landed post-exit, the prep-ready rule
// (file-on-disk wins) in upcoming.ts already takes precedence.
export const reconcileOrphanedPrepRuns = (): number => {
  const running = meetingPrepRuns.listRunning();
  for (const r of running) {
    meetingPrepRuns.finish(r.id, {
      status: "failed",
      error: "collector orphaned (inbox-serve restarted before child exited)",
    });
  }
  return running.length;
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

// Launches `cos review <pr-url>` in a new Terminal window. The user drives
// plannotator there and, on exit, is prompted to mirror the decision to
// GitHub via `gh pr review`. See cmdReviewPr in commands/review-pr.ts.
export const reviewInPlannotator = async (
  prUrl: string,
): Promise<ActionResult> => {
  if (!prUrl) return { ok: false, message: "no PR URL on this row" };
  const cmd = `${shellQuote(COS_BIN)} review ${shellQuote(prUrl)}`;
  if (!openTerminalRunning(cmd)) {
    return {
      ok: false,
      message: `run manually: cos review ${prUrl}`,
      detail: `run manually: cos review ${prUrl}`,
    };
  }
  return {
    ok: true,
    message: `opened plannotator for ${prUrl}`,
    detail: `running in new Terminal: cos review ${prUrl}`,
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
