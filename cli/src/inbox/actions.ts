import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { getDb, notifications, sessions, workItems } from "../db.js";
import { cmdEnqueue } from "../commands/enqueue.js";
import { COS_DIR } from "../util.js";
import type { InboxDashboard, InboxItem } from "./types.js";

const COS_BIN = join(COS_DIR, "bin/cos");
const TMUX_WORKER_SESSION = "cos-workers";

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

const tmuxWindowName = (wiId: string) => wiId.replace(/^wi-/, "").slice(0, 18);

const killTmuxWindow = (sessionId: string, wiId: string | null) => {
  const candidates: string[] = [];
  const sess = sessions.get(sessionId);
  if (sess?.tmux_window) candidates.push(sess.tmux_window);
  if (wiId) candidates.push(`${TMUX_WORKER_SESSION}:${tmuxWindowName(wiId)}`);
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
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const next = Math.min(5, wi.priority + 1);
  workItems.update(id, { priority: next });
  return { ok: true, message: `snoozed ${id} → P${next}` };
};

export const bumpWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const next = Math.max(1, wi.priority - 1);
  workItems.update(id, { priority: next });
  return { ok: true, message: `bumped ${id} → P${next}` };
};

export const archiveWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  workItems.update(id, { status: "abandoned" });
  return { ok: true, message: `archived ${id}` };
};

export const abandonWorkItem = archiveWorkItem;

export const retryWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  workItems.update(id, { status: "queued", session_id: null });
  const r = await runCos(["dispatch", id, "--force"]);
  return r.ok
    ? { ok: true, message: `retrying ${id}` }
    : {
        ok: false,
        message: `retry failed: ${r.stderr.trim().split("\n")[0]}`,
      };
};

export const markPrReviewed = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  getDb()
    .prepare(
      `UPDATE work_items SET inbox_acked_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
  return { ok: true, message: `marked ${id} reviewed` };
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
      ? `${TMUX_WORKER_SESSION}:${tmuxWindowName(s.work_item_id)}`
      : TMUX_WORKER_SESSION);
  const hint = `tmux attach -t ${target}`;
  return { ok: true, message: hint, detail: hint };
};

export const viewFailureLog = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const rows = getDb()
    .prepare(
      `SELECT id, status, notes, current_step, last_heartbeat FROM sessions
       WHERE work_item_id = ? ORDER BY started_at DESC LIMIT 3`,
    )
    .all(id) as {
    id: string;
    status: string;
    notes: string | null;
    current_step: string | null;
    last_heartbeat: string;
  }[];
  if (!rows.length) return { ok: true, message: `no sessions for ${id}` };
  const detail = rows
    .map(
      (r) =>
        `${r.id} [${r.status}] step=${r.current_step ?? "—"} hb=${r.last_heartbeat}${
          r.notes ? `\n  ${r.notes}` : ""
        }`,
    )
    .join("\n");
  return { ok: true, message: `failure log for ${id}`, detail };
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
  return { ok: true, message: `enqueued ${id}` };
};

export const markAllFyiRead = async (
  source: InboxDashboard | InboxItem[],
): Promise<ActionResult> => {
  const fyi = Array.isArray(source)
    ? source.filter((i) => i.section === "fyi")
    : source.fyi;
  const anomalies = Array.isArray(source)
    ? source.filter((i) => i.section === "anomalies")
    : source.anomalies;
  let dismissed = 0;
  for (const item of fyi) {
    if (item.kind === "notification") {
      notifications.markPushed(item.id);
      dismissed++;
    }
  }
  const stmt = getDb().prepare(
    `UPDATE sessions SET acked_at = datetime('now') WHERE id = ? AND acked_at IS NULL`,
  );
  for (const item of anomalies) {
    if (item.kind === "session") {
      const r = stmt.run(item.id);
      if (r.changes > 0) dismissed++;
    }
  }
  return { ok: true, message: `dismissed ${dismissed} FYI / anomaly rows` };
};
