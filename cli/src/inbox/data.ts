import { getDb, notifications, signals, sessions } from "../db.js";
import type { InboxItem } from "./types.js";

const hasColumn = (table: string, column: string): boolean => {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.some((r) => r.name === column);
};

const trimBody = (s: string, max = 200) =>
  s.length <= max ? s : s.slice(0, max - 1) + "…";

export const collectInbox = (): InboxItem[] => {
  const items: InboxItem[] = [];

  for (const n of notifications.listUnpushed()) {
    const band =
      n.urgency === "urgent"
        ? "decision"
        : n.urgency === "digest"
          ? "digest"
          : "fyi";
    items.push({
      key: `notification:${n.id}`,
      kind: "notification",
      id: n.id,
      band,
      urgency: n.urgency,
      subject: n.subject,
      body: trimBody(n.body),
      related_ids: n.related_ids,
      created_at: n.created_at,
    });
  }

  if (hasColumn("work_items", "needs_approval")) {
    const rows = getDb()
      .prepare(
        `SELECT id, title, description, repos, priority, created_at
         FROM work_items
         WHERE status = 'queued' AND needs_approval = 1
         ORDER BY priority ASC, created_at ASC`,
      )
      .all() as {
      id: string;
      title: string;
      description: string;
      repos: string;
      priority: number;
      created_at: string;
    }[];
    for (const r of rows) {
      items.push({
        key: `work-item:${r.id}`,
        kind: "work-item",
        id: r.id,
        band: "decision",
        urgency: "urgent",
        subject: `P${r.priority} ${r.title}`,
        body: trimBody(r.description),
        related_ids: [],
        created_at: r.created_at,
      });
    }
  }

  for (const s of signals.list({ status: "new" })) {
    items.push({
      key: `signal:${s.id}`,
      kind: "signal",
      id: s.id,
      band: "decision",
      urgency: "urgent",
      subject: `${s.kind} (${s.source})`,
      body: trimBody(s.external_id ?? JSON.stringify(s.payload)),
      related_ids: s.external_id ? [s.external_id] : [],
      created_at: s.created_at,
    });
  }

  for (const status of ["stale", "failed"] as const) {
    for (const sess of sessions.list({ status })) {
      items.push({
        key: `session:${sess.id}`,
        kind: "session",
        id: sess.id,
        band: "fyi",
        urgency: "normal",
        subject: `Session ${status}: ${sess.id} (wi=${sess.work_item_id ?? "—"})`,
        body: trimBody(
          `last heartbeat ${sess.last_heartbeat}; step ${sess.current_step ?? "—"}`,
        ),
        related_ids: sess.work_item_id ? [sess.work_item_id] : [],
        created_at: sess.started_at,
      });
    }
  }

  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
};

export const groupByBand = (items: InboxItem[]) => ({
  decision: items.filter((i) => i.band === "decision"),
  fyi: items.filter((i) => i.band === "fyi"),
  digest: items.filter((i) => i.band === "digest"),
});
