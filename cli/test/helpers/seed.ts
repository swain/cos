import Database from "better-sqlite3";
import { ulid } from "ulid";

export type SeedDb = Database.Database;

export const openSeedDb = (path: string): SeedDb => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

export const clearAll = (db: SeedDb) => {
  db.exec(`
    DELETE FROM work_items;
    DELETE FROM sessions;
    DELETE FROM notifications;
    DELETE FROM signals;
    DELETE FROM ideas;
    DELETE FROM cron_ticks;
    DELETE FROM cos_log;
    DELETE FROM followups;
    DELETE FROM recurring_tasks;
    DELETE FROM kv;
  `);
};

type WiRow = {
  id?: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  repos?: string[];
  priority?: number;
  status?: string;
  source?: string;
  pr_urls?: string[];
  needs_approval?: boolean;
  inbox_acked_at?: string | null;
  updated_at?: string;
  created_at?: string;
};

export const seedWorkItem = (db: SeedDb, row: WiRow): string => {
  const id = row.id ?? `wi-${ulid()}`;
  const maxRow = db.prepare(`SELECT MAX(num) AS max FROM work_items`).get() as {
    max: number | null;
  };
  const num = (maxRow.max ?? 0) + 1;
  const slug =
    row.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  db.prepare(
    `INSERT INTO work_items (
      id, num, slug, title, description, acceptance_criteria,
      repos, priority, status, source, depends_on, session_id,
      pr_urls, worklog_path, worktree_paths, needs_approval,
      parent_id, needs_planning, inbox_acked_at,
      created_at, updated_at
    ) VALUES (
      @id, @num, @slug, @title, @description, @acceptance_criteria,
      @repos, @priority, @status, @source, @depends_on, NULL,
      @pr_urls, NULL, '{}', @needs_approval,
      NULL, 0, @inbox_acked_at,
      COALESCE(@created_at, datetime('now')),
      COALESCE(@updated_at, datetime('now'))
    )`,
  ).run({
    id,
    num,
    slug,
    title: row.title,
    description: row.description ?? "",
    acceptance_criteria: row.acceptance_criteria ?? "",
    repos: JSON.stringify(row.repos ?? ["cos"]),
    priority: row.priority ?? 3,
    status: row.status ?? "queued",
    source: row.source ?? "user",
    depends_on: "[]",
    pr_urls: JSON.stringify(row.pr_urls ?? []),
    needs_approval: row.needs_approval ? 1 : 0,
    inbox_acked_at: row.inbox_acked_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  });
  return id;
};

type SessionRow = {
  id?: string;
  work_item_id?: string | null;
  kind?: string;
  status?: string;
  current_step?: string | null;
  notes?: string | null;
  last_heartbeat?: string;
  started_at?: string;
};

export const seedSession = (db: SeedDb, row: SessionRow = {}): string => {
  const id = row.id ?? `sess-${ulid()}`;
  db.prepare(
    `INSERT INTO sessions (
      id, work_item_id, tmux_window, kind, status, current_step,
      last_heartbeat, started_at, notes
    ) VALUES (
      @id, @work_item_id, NULL, @kind, @status, @current_step,
      COALESCE(@last_heartbeat, datetime('now')),
      COALESCE(@started_at, datetime('now')),
      @notes
    )`,
  ).run({
    id,
    work_item_id: row.work_item_id ?? null,
    kind: row.kind ?? "worker",
    status: row.status ?? "running",
    current_step: row.current_step ?? null,
    notes: row.notes ?? null,
    last_heartbeat: row.last_heartbeat ?? null,
    started_at: row.started_at ?? null,
  });
  return id;
};

type NotifRow = {
  id?: string;
  subject: string;
  body?: string;
  urgency?: "urgent" | "normal" | "digest";
  related_ids?: string[];
};

export const seedNotification = (db: SeedDb, row: NotifRow): string => {
  const id = row.id ?? `notif-${ulid()}`;
  db.prepare(
    `INSERT INTO notifications (id, subject, body, urgency, related_ids, pushed_at)
     VALUES (@id, @subject, @body, @urgency, @related_ids, NULL)`,
  ).run({
    id,
    subject: row.subject,
    body: row.body ?? "",
    urgency: row.urgency ?? "normal",
    related_ids: JSON.stringify(row.related_ids ?? []),
  });
  return id;
};

type SignalRow = {
  id?: string;
  source?: string;
  kind?: string;
  external_id?: string | null;
  payload?: Record<string, unknown>;
};

export const seedSignal = (db: SeedDb, row: SignalRow = {}): string => {
  const id = row.id ?? `sig-${ulid()}`;
  db.prepare(
    `INSERT INTO signals (id, source, kind, external_id, payload, status)
     VALUES (@id, @source, @kind, @external_id, @payload, 'new')`,
  ).run({
    id,
    source: row.source ?? "test",
    kind: row.kind ?? "test-event",
    external_id: row.external_id ?? null,
    payload: JSON.stringify(row.payload ?? {}),
  });
  return id;
};
