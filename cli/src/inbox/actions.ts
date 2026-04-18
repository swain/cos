import { spawn } from "node:child_process";
import { join } from "node:path";
import { notifications, workItems } from "../db.js";
import { COS_DIR } from "../util.js";
import type { InboxItem } from "./types.js";

const COS_BIN = join(COS_DIR, "bin/cos");

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

export type ActionResult = { ok: boolean; message: string };

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

export const snoozeWorkItem = async (id: string): Promise<ActionResult> => {
  const wi = workItems.get(id);
  if (!wi) return { ok: false, message: `work item not found: ${id}` };
  const next = Math.min(5, wi.priority + 1);
  workItems.update(id, { priority: next });
  return { ok: true, message: `snoozed ${id} → P${next}` };
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

export const markAllFyiRead = async (
  items: InboxItem[],
): Promise<ActionResult> => {
  const fyiNotifs = items.filter(
    (i) => i.band === "fyi" && i.kind === "notification",
  );
  for (const n of fyiNotifs) notifications.markPushed(n.id);
  return { ok: true, message: `marked ${fyiNotifs.length} FYI as read` };
};
